/**
 * Prime backend — executes one delegated microagent turn through the pinned,
 * installed prime-agent binary (wish rlmx-v2-prime-backend, Group 2).
 *
 * Why a subprocess: prime-agent is not an npm SDK this repo may import — the
 * wish pins integration to the installed binary (`--mode json -p`), and a
 * spawn per turn is the only surface that exists. The daemon socket is never
 * touched and no prime-agent package is imported anywhere.
 *
 * ## Host contract
 * The result shape is exactly `MicroagentResult` (`src/mcp/backend.ts`):
 * `answer` from prime's final assistant message, `iterations` from prime's
 * turn count (prime has no iteration concept of its own — a turn is its
 * analog), `budgetHit` from this backend's own enforcement, `usage` from the
 * assistant messages' usage records. `isFailedRun` (`src/mcp/server.ts`)
 * classifies the two designed aborts the way it classifies legacy's: a
 * deadline kill returns `TIMEOUT_ANSWER` (failed run) and a ceiling kill
 * returns normally with `budgetHit` set (success with a budget note in the
 * footer).
 *
 * ## Mapping decisions
 * The wish is the governing artifact; every ambiguous mapping fails loudly —
 * no silent degradation.
 *
 * - model: prime 0.8.1 exposes credential-gated catalogs for `google`,
 *   `openrouter`, `deepseek`, and `prime-inference`, plus OpenAI-compatible
 *   custom providers declared in Prime's `models.json`. RLΜX supports its
 *   `khal` gateway through that custom-provider contract. Each takes the same bare
 *   model id rlmx stores after its first-slash provider split, so
 *   `openrouter/~deepseek/…` maps to
 *   `--provider openrouter --model ~deepseek/…`. RLΜX-only providers that
 *   Prime cannot configure, such as `station`, throw before spawn.
 * - thinking: `config.gemini.thinkingLevel` (minimal|low|medium|high) is a
 *   subset of prime's `--thinking` levels; passed through verbatim.
 * - system: `config.system` (the agent's SYSTEM.md via `applyAgent`) and
 *   `config.criteria` are APPENDED to prime's base prompt via
 *   `--append-system-prompt` — never `--system-prompt`, which per prime
 *   0.8.1 `--help` *replaces* the default system prompt. Replacing would
 *   strip prime's base RLM prompt and handicap the prime leg.
 * - context: `LoadedContext` items are materialized from their already-loaded
 *   contents into private 0600 snapshots, then mapped to prime `@file`
 *   arguments. Prime never re-reads mutable originals or learns their host
 *   paths. Every arg uses the single `@<abs path>` form prime 0.8.1 parses as
 *   a file argument; snapshots are removed in a `finally` block. A `dict`
 *   context throws.
 * - budget.maxCost / maxTokens: rlmx-owned ceilings monitored from the
 *   assistant messages' usage records, mirroring `BudgetTracker`
 *   (`src/budget.ts`): totalCost ≥ maxCost → "max-cost", input+output
 *   tokens ≥ maxTokens → "max-tokens". A breach kills the subprocess AND its
 *   descendants and returns a normal result with the partial answer and
 *   `budgetHit` set — never a throw, matching legacy's non-throwing aborts.
 * - maxIterations (spec budget/shape): prime has no iteration concept, so
 *   the cap maps to a turn ceiling — when the (cap+1)th turn would start,
 *   the tree is killed and the run returns the last completed turn's answer
 *   with `budgetHit: "max-iterations"`. Documented deviation: legacy's loop
 *   bound ends gracefully with no budget note; prime has no stop signal
 *   other than the kill, so the truncation is marked in the footer.
 *   `isFailedRun` still classifies it as a success, matching legacy.
 * - deadline: an rlmx-owned wall clock defaulting to rlmLoop's 300s and
 *   overridable with `RLMX_MCP_RUN_TIMEOUT_MS` — the same override the
 *   legacy backend forwards to its engine. Expiry kills the tree and
 *   returns `TIMEOUT_ANSWER`, which `isFailedRun` classifies as failed,
 *   exactly like legacy's timeout.
 *
 * ## Loudly rejected (no silent degradation)
 * - `config.tools` (TOOLS.md REPL functions): Python REPL functions prime's
 *   environment does not have.
 * - `budget.maxDepth`: legacy enforces depth at sub-call time; the parent's
 *   prime stream carries no child-depth signal to enforce from.
 * - `output.schema`: prime has no structured-output flag.
 * - gemini feature flags (googleSearch, urlContext, codeExecution,
 *   computerUse, mapsGrounding, fileSearch, mediaResolution): rlmx-side
 *   request decoration prime cannot replicate.
 * - `context` of type `dict`.
 *
 * `config.cache` / `storage` / `rtk` are deliberately NOT rejected: they are
 * already inert on the legacy MCP path (rlmLoop runs with cache and storage
 * mode off), so rejecting them here would make prime stricter than the
 * reference backend.
 *
 * ## Inherent subprocess boundary (not mapped; noted for Group 3)
 * - sub-call model: legacy re-pins sub-calls to the agent's model; prime's
 *   recursive children run on prime's own defaults — the CLI has no flag
 *   for it.
 * - child usage: legacy merges sub-call usage into the footer totals; the
 *   prime parent stream carries only its own turns' usage.
 */

import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createInterface } from "node:readline";
import { basename, dirname, join } from "node:path";
import type { RlmxConfig } from "../../config.js";
import type { LoadedContext } from "../../context.js";
import { TIMEOUT_ANSWER } from "../../rlm.js";
import type { Microagent } from "../agents.js";
import type { BackendRequest, MicroagentResult, RuntimeBackend } from "../backend.js";

/** The exact prime-agent version this build pins. */
export const EXPECTED_PRIME_VERSION = "0.8.1";

/** rlmLoop's default wall-clock cap, mirrored so the deadline default matches legacy. */
export const DEFAULT_PRIME_DEADLINE_MS = 300_000;

/** Budgets the backend enforces on the spawned run, from the request. */
export interface PrimeRunLimits {
  /** rlmx-owned wall-clock deadline; expiry kills the tree and returns TIMEOUT_ANSWER. */
  readonly deadlineMs: number;
  /** Cost ceiling from `budget.max_cost` (null = unlimited). */
  readonly maxCost: number | null;
  /** Token ceiling from `budget.max_tokens` (null = unlimited; input+output, like BudgetTracker). */
  readonly maxTokens: number | null;
  /** Turn ceiling from the spec's iteration cap (null = unlimited). */
  readonly maxTurns: number | null;
}

/** What the spawn engine hands back — the raw material of one turn. */
export interface PrimeRunResult {
  readonly answer: string;
  /** Completed prime turns — the backend reports this as `iterations`. */
  readonly turns: number;
  /** "max-cost" | "max-tokens" | "max-iterations" | null. */
  readonly budgetHit: string | null;
  readonly usage: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly totalCost: number;
  };
}

/**
 * The spawn seam: run one argv line to completion (or to a designed kill)
 * and hand back the raw result. In production this is `spawnPrimeRun`; tests
 * inject a scripted engine (the contract harness) or drive the real spawner
 * through a stub binary (`tests/prime-backend.test.ts`).
 */
export type PrimeEngine = (
  argv: readonly string[],
  emit: (message: string) => void,
  limits: PrimeRunLimits,
  signal?: AbortSignal
) => Promise<PrimeRunResult>;

export interface PrimeBackendOptions {
  /** Path to the prime-agent binary (default: `RLMX_PRIME_BINARY_PATH` or "prime-agent"). */
  readonly binaryPath?: string;
  /** Pinned version to assert at construction (default: EXPECTED_PRIME_VERSION). */
  readonly expectedVersion?: string;
  /** Test seam: replaces the real spawn engine and skips the version check. */
  readonly engine?: PrimeEngine;
  /** Test seam: overrides production's least-privilege child environment builder. */
  readonly environment?: (source: NodeJS.ProcessEnv, provider: string) => NodeJS.ProcessEnv;
}

// ── Event stream shapes (prime 0.8.1 `--mode json`, verified live) ────────
// session → agent_start → turn_start → message_start/user → message_end/user
// → message_start/assistant → message_update/assistant* → message_end/assistant
// (carries usage + cost) → tool_execution_start/update/end* → turn_end
// (carries the turn's final assistant message + toolResults) → … →
// agent_end (carries the full `messages` array). Assistant usage records are
// per-completion (not cumulative), so the run total is the sum over messages.

interface PrimeUsage {
  readonly input?: number;
  readonly output?: number;
  readonly cacheRead?: number;
  readonly cacheWrite?: number;
  readonly totalTokens?: number;
  readonly cost?: {
    readonly input?: number;
    readonly output?: number;
    readonly cacheRead?: number;
    readonly cacheWrite?: number;
    readonly total?: number;
  };
}

interface PrimeMessage {
  readonly role?: string;
  readonly content?: string | ReadonlyArray<{ type?: string; text?: string }>;
  readonly usage?: PrimeUsage;
  readonly stopReason?: string;
  readonly errorMessage?: string;
  readonly provider?: string;
  readonly model?: string;
}

interface PrimeEvent {
  readonly type?: string;
  readonly message?: PrimeMessage;
  readonly messages?: ReadonlyArray<PrimeMessage>;
  readonly toolName?: string;
}

/**
 * Environment names Prime needs to run without inheriting the host's entire
 * credential set. Keep this deliberately small and explicit: adding a new
 * provider requires adding both its model mapping and its credential here.
 */
const PRIME_ENV_ALLOWLIST = [
  "HOME",
  "PATH",
  "TMPDIR",
  "TMP",
  "TEMP",
  "USER",
  "PRIME_AGENT_CODING_AGENT_DIR",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LC_ALL",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
] as const;

const PRIME_PROVIDER_CREDENTIALS: Readonly<Record<string, readonly string[]>> = {
  google: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
  openrouter: ["OPENROUTER_API_KEY"],
  deepseek: ["DEEPSEEK_API_KEY"],
  "prime-inference": ["PRIME_API_KEY"],
  khal: ["KHAL_API_KEY", "RLMX_KHAL_API_KEY"],
};

/** Build the least-privilege environment handed to the Prime subprocess. */
export function buildPrimeChildEnv(
  source: NodeJS.ProcessEnv,
  provider: string
): NodeJS.ProcessEnv {
  const child: NodeJS.ProcessEnv = {
    // Prime 0.8.1 honors both variables. Set both so user-level settings can
    // never silently turn telemetry back on for an rlmx-dispatched run.
    DO_NOT_TRACK: "1",
    PRIME_AGENT_TELEMETRY: "0",
  };
  for (const name of PRIME_ENV_ALLOWLIST) {
    const value = source[name];
    if (value !== undefined) child[name] = value;
  }
  for (const name of PRIME_PROVIDER_CREDENTIALS[provider] ?? []) {
    const value = source[name];
    if (value !== undefined) child[name] = value;
  }
  return child;
}

/** Kill reasons the backend owns — each maps to a designed, non-throwing abort. */
type KillReason = "deadline" | "max-cost" | "max-tokens" | "max-turns";

const num = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;

function isAssistant(message: unknown): message is PrimeMessage {
  return (
    typeof message === "object" &&
    message !== null &&
    (message as PrimeMessage).role === "assistant"
  );
}

/** Text content of an assistant message — concatenated `text` parts. */
function textOf(message: PrimeMessage): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  let out = "";
  for (const part of content) {
    if (part && typeof part === "object" && part.type === "text" && typeof part.text === "string") {
      out += part.text;
    }
  }
  return out;
}

/**
 * The real engine: spawn the binary, parse the JSONL event stream, enforce
 * the rlmx-owned budgets, and kill the whole process tree on breach.
 */
function spawnPrimeRun(
  argv: readonly string[],
  emit: (message: string) => void,
  limits: PrimeRunLimits,
  childEnv: NodeJS.ProcessEnv,
  signal?: AbortSignal
): Promise<PrimeRunResult> {
  return new Promise<PrimeRunResult>((resolve, reject) => {
    const binaryPath = argv[0]!;
    const child = spawn(binaryPath, argv.slice(1), {
      // Own process group: the budget kill takes the tree, descendants included.
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: childEnv,
    });

    let settled = false;
    let cancelled = false;
    let killed: KillReason | null = null;
    let turns = 0;
    let lastTurnText: string | null = null;
    let lastText = "";
    let agentEnded = false;
    let finalMessage: PrimeMessage | null = null;
    let malformedLines = 0;
    let stderrTail = "";
    const usage = { inputTokens: 0, outputTokens: 0, totalCost: 0 };

    const killResult = (reason: KillReason): PrimeRunResult => {
      switch (reason) {
        case "deadline":
          // Legacy's timeout preserves whatever budgetHit had accumulated
          // (usually none); ceiling kills return immediately, so it is null here.
          return { answer: TIMEOUT_ANSWER, turns, budgetHit: null, usage: { ...usage } };
        case "max-cost":
        case "max-tokens":
          return {
            answer:
              lastText.trim() ||
              `Error: budget hit: ${reason} before the model produced any output`,
            turns,
            budgetHit: reason,
            usage: { ...usage },
          };
        case "max-turns":
          return {
            answer:
              (lastTurnText ?? lastText).trim() ||
              `Error: iteration cap reached: the run exceeded ${limits.maxTurns} turn(s) without producing a report`,
            turns,
            budgetHit: "max-iterations",
            usage: { ...usage },
          };
      }
    };

    const killTree = (): void => {
      if (typeof child.pid !== "number") return;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // Already gone — the close handler resolves the run.
      }
    };

    let deadlineTimer: NodeJS.Timeout | undefined;
    let failsafeTimer: NodeJS.Timeout | undefined;
    const settle = (result: PrimeRunResult): void => {
      if (settled) return;
      settled = true;
      if (deadlineTimer) clearTimeout(deadlineTimer);
      if (failsafeTimer) clearTimeout(failsafeTimer);
      signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };
    const fail = (err: Error): void => {
      if (settled) return;
      settled = true;
      if (deadlineTimer) clearTimeout(deadlineTimer);
      if (failsafeTimer) clearTimeout(failsafeTimer);
      signal?.removeEventListener("abort", onAbort);
      reject(err);
    };
    const breach = (reason: KillReason): void => {
      if (killed) return; // first breach wins
      killed = reason;
      killTree();
      // SIGKILL cannot be ignored, but the close handler is the only
      // resolver — never leave a run hanging on a lost close event.
      failsafeTimer = setTimeout(() => settle(killResult(reason)), 2_000);
    };

    deadlineTimer = setTimeout(() => breach("deadline"), limits.deadlineMs);

    const onAbort = (): void => {
      if (settled || cancelled) return;
      cancelled = true;
      killTree();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();

    const handleEvent = (event: PrimeEvent): void => {
      switch (event.type) {
        case "turn_start":
          // The iteration cap: turns are prime's analog of legacy iterations.
          // Kill when the (cap+1)th turn would start, so the reported answer
          // is the last COMPLETED turn's — legacy's loop-bound answer.
          if (limits.maxTurns !== null && turns >= limits.maxTurns) {
            breach("max-turns");
            return;
          }
          emit(`iteration ${turns + 1}`);
          break;
        case "turn_end":
          turns += 1;
          if (isAssistant(event.message)) lastTurnText = textOf(event.message);
          break;
        case "message_update":
          if (isAssistant(event.message)) lastText = textOf(event.message);
          break;
        case "message_end":
          if (isAssistant(event.message)) {
            lastText = textOf(event.message);
            const u = event.message.usage;
            if (u) {
              usage.inputTokens += num(u.input);
              usage.outputTokens += num(u.output);
              usage.totalCost += num(u.cost?.total);
            }
            if (limits.maxCost !== null && usage.totalCost >= limits.maxCost) {
              breach("max-cost");
            } else if (
              limits.maxTokens !== null &&
              usage.inputTokens + usage.outputTokens >= limits.maxTokens
            ) {
              breach("max-tokens");
            }
          }
          break;
        case "tool_execution_start":
          if (typeof event.toolName === "string" && event.toolName.length > 0) {
            emit(`tool ${event.toolName}`);
          }
          break;
        case "agent_end": {
          agentEnded = true;
          const messages = Array.isArray(event.messages) ? event.messages : [];
          for (let i = messages.length - 1; i >= 0; i -= 1) {
            if (isAssistant(messages[i])) {
              finalMessage = messages[i]!;
              break;
            }
          }
          break;
        }
        default:
          // session / agent_start / message_start / tool_execution_update/end
          break;
      }
    };

    // stdout discipline: parse every line, skip non-JSON lines, and keep the
    // stream drained until the process closes — closing stdout early EPIPEs
    // the child (observed live).
    const lines = createInterface({ input: child.stdout! });
    lines.on("line", (line) => {
      let event: PrimeEvent;
      try {
        event = JSON.parse(line) as PrimeEvent;
      } catch {
        malformedLines += 1;
        return;
      }
      handleEvent(event);
    });

    // stderr must drain too — a full pipe buffer blocks the child. Keep the
    // last 4 KiB for error reports.
    child.stderr!.on("data", (chunk: Buffer) => {
      stderrTail = `${stderrTail}${chunk.toString("utf8")}`.slice(-4096);
    });

    child.on("error", (err) => fail(err));

    child.on("close", (code, signal) => {
      if (settled) return;
      if (cancelled) {
        fail(new Error("prime backend: cancelled by the MCP caller"));
        return;
      }
      if (killed) {
        settle(killResult(killed));
        return;
      }
      if (!agentEnded) {
        const tail = stderrTail.trim();
        const malformed = malformedLines > 0 ? `; ${malformedLines} non-JSON stdout line(s)` : "";
        fail(
          new Error(
            `prime backend: prime-agent exited before reporting agent_end ` +
              `(code ${code ?? "null"}, signal ${signal ?? "none"})` +
              `${tail ? `; stderr: ${tail}` : ""}${malformed}`
          )
        );
        return;
      }
      // Final answer = text content of the final assistant message
      // (agent_end's message list, falling back to the last turn_end and the
      // streamed text); usage = the run total over every assistant message.
      const answer = finalMessage ? textOf(finalMessage) : (lastTurnText ?? lastText);
      if (finalMessage?.stopReason === "error" || finalMessage?.errorMessage) {
        const model = [finalMessage.provider, finalMessage.model].filter(Boolean).join("/");
        fail(
          new Error(
            `prime backend: prime-agent model run failed${model ? ` (${model})` : ""}: ` +
              `${finalMessage.errorMessage?.trim() || "unknown model error"}`
          )
        );
        return;
      }
      if (!answer.trim()) {
        fail(
          new Error(
            "prime backend: prime-agent reported agent_end without a final text answer. " +
              "The run cannot be treated as successful; inspect the Prime JSON event stream."
          )
        );
        return;
      }
      settle({
        answer,
        turns,
        budgetHit: null,
        usage: { ...usage },
      });
    });
  });
}

/**
 * Version-pin check at backend startup: `prime-agent --version` must report
 * exactly the pinned version. Reports to stderr AND throws, so the failure
 * is visible in the server log and surfaces as a clean tool error.
 */
function assertPinnedVersion(binaryPath: string, expected: string): void {
  const failWith = (message: string): void => {
    process.stderr.write(`rlmx: ${message}\n`);
    throw new Error(message);
  };

  let probe;
  try {
    probe = spawnSync(binaryPath, ["--version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    failWith(
      `prime backend: cannot run "${binaryPath}": ${err instanceof Error ? err.message : String(err)}. ` +
        `The prime backend executes microagent turns through the installed prime-agent binary; ` +
        `install prime-agent ${expected} and restart rlmx mcp, or switch the agent back to \`backend: rlmx\`.`
    );
    return;
  }

  if (probe.error) {
    failWith(
      `prime backend: cannot run "${binaryPath}": ${probe.error.message}. ` +
        `The prime backend executes microagent turns through the installed prime-agent binary; ` +
        `install prime-agent ${expected} and restart rlmx mcp, or switch the agent back to \`backend: rlmx\`.`
    );
    return;
  }

  // The real binary reports the version on stderr; accept either stream.
  const reported = `${probe.stdout ?? ""}${probe.stderr ?? ""}`.trim();
  if (probe.status !== 0 || reported !== expected) {
    failWith(
      `prime backend: "${binaryPath}" is not the pinned prime-agent ${expected}: ` +
        `\`prime-agent --version\` reported ${reported ? `"${reported}"` : "nothing"}. ` +
        `rlmx pins this backend to an exact binary version — upgrades are deliberate events. ` +
        `Run \`prime-agent update\` to move the pin as a recorded decision, or switch the agent back to \`backend: rlmx\`.`
    );
  }
}

/**
 * Map rlmx's model addressing onto prime 0.8.1's advertised providers. Fails loudly
 * for every rlmx provider prime cannot address — a spec that says "run on X"
 * must never silently run on another model.
 */
function mapPrimeModel(
  model: RlmxConfig["model"],
  agentName: string | undefined
): { provider: string; model: string } {
  const who = agentName ? `agent "${agentName}"` : "this run";
  switch (model.provider) {
    case "google":
      return { provider: "google", model: model.model };
    case "openrouter":
      return { provider: "openrouter", model: model.model };
    case "deepseek":
      return { provider: "deepseek", model: model.model };
    case "prime-inference":
      return { provider: "prime-inference", model: model.model };
    case "khal":
      return { provider: "khal", model: model.model };
    default:
      throw new Error(
        `prime backend: ${who} is pinned to rlmx model "${model.provider}/${model.model}", ` +
          `which the rlmx Prime adapter for prime-agent 0.8.1 cannot address — it supports \`google\`, \`openrouter\`, \`deepseek\`, \`prime-inference\`, and the configured \`khal\` provider. ` +
          `Re-pin the agent to one of those providers, ` +
          `or switch the agent back to \`backend: rlmx\`.`
      );
  }
}

/** Reject every rlmx feature the prime leg cannot honor — never degrade silently. */
function assertSupportedConfig(config: RlmxConfig, agentName: string | undefined): void {
  const who = agentName ? `agent "${agentName}"` : "this run";
  const reject = (field: string, why: string): never => {
    throw new Error(
      `prime backend: ${who} declares ${field}, which the prime leg cannot honor (${why}). ` +
        `Remove it from the agent/config or switch the agent back to \`backend: rlmx\`.`
    );
  };

  if (config.tools && config.tools.length > 0) {
    reject(
      "custom REPL tools (TOOLS.md)",
      "they are Python REPL functions prime's environment does not have"
    );
  }
  if ((config.output?.schema ?? null) !== null) {
    reject("a structured output schema", "prime has no structured-output flag");
  }
  if (config.budget?.maxDepth != null) {
    reject(
      "budget.max_depth",
      "depth is enforced at sub-call time and the parent's prime stream carries no child-depth signal"
    );
  }
  const gemini = config.gemini;
  if (gemini) {
    if (gemini.googleSearch) reject("gemini.google-search", "prime has no googleSearch flag");
    if (gemini.urlContext) reject("gemini.url-context", "prime has no urlContext flag");
    if (gemini.codeExecution) reject("gemini.code-execution", "prime has no codeExecution flag");
    if (gemini.computerUse) reject("gemini.computer-use", "prime has no computerUse flag");
    if (gemini.mapsGrounding) reject("gemini.maps-grounding", "prime has no mapsGrounding flag");
    if (gemini.fileSearch) reject("gemini.file-search", "prime has no fileSearch flag");
    if (gemini.mediaResolution != null) {
      reject("gemini.media-resolution", "prime has no mediaResolution flag");
    }
  }
}

/** Sanitize a context item's relative path into safe join segments. */
function sanitizeSegments(relativePath: string): string[] {
  return relativePath
    .split("/")
    .filter((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

/**
 * The `@` prefix is the contract itself, not decoration: a plain path becomes
 * a message and Prime runs one autonomous turn per path string. Snapshotting
 * also closes the load-to-spawn race and avoids leaking original host paths.
 */
interface PreparedPrimeContext {
  readonly fileArgs: readonly string[];
  readonly labels: readonly string[];
  cleanup(): Promise<void>;
}

/**
 * Materialize the already-loaded context into a private immutable snapshot.
 * Prime receives only snapshot paths, never the caller's mutable originals.
 */
async function prepareContextSnapshot(
  context: LoadedContext | null,
  contextRoot: string | undefined
): Promise<PreparedPrimeContext> {
  if (!context) {
    return { fileArgs: [], labels: [], cleanup: async () => {} };
  }
  if (context.type === "dict") {
    throw new Error(
      `prime backend: context type "${context.type}" cannot be mapped to prime @file arguments. ` +
        `Pass a file or directory as the context, or switch the agent back to \`backend: rlmx\`.`
    );
  }

  const root = await mkdtemp(join(tmpdir(), "rlmx-prime-context-"));
  const entries: ReadonlyArray<{ label: string; content: string }> =
    context.type === "string"
      ? [{
          label: basename(contextRoot ?? "context.txt") || "context.txt",
          content: context.content as string,
        }]
      : (context.content as ReadonlyArray<{ path: string; content: string }>).map((item) => ({
          label: sanitizeSegments(item.path).join("/") || "context.txt",
          content: item.content,
        }));

  try {
    const fileArgs: string[] = [];
    const labels: string[] = [];
    for (const [index, entry] of entries.entries()) {
      // The index makes sanitization collisions impossible while the suffix
      // keeps the caller's logical filename visible to the model.
      const snapshotPath = join(root, String(index).padStart(4, "0"), entry.label);
      await mkdir(dirname(snapshotPath), { recursive: true, mode: 0o700 });
      await writeFile(snapshotPath, entry.content, { encoding: "utf8", mode: 0o600 });
      fileArgs.push(`@${snapshotPath}`);
      labels.push(entry.label);
    }
    return {
      fileArgs,
      labels,
      cleanup: () => rm(root, { recursive: true, force: true }),
    };
  } catch (err) {
    await rm(root, { recursive: true, force: true });
    throw err;
  }
}

/** The microagent role appended AFTER prime's base prompt (never replacing it). */
function buildAppendedRole(
  agent: Microagent | undefined,
  config: RlmxConfig,
  contextNote: string | null
): string {
  const who = agent ? `the rlmx microagent "${agent.name}"` : "an rlmx microagent";
  const parts: string[] = [
    `You are operating as ${who}, dispatched by an rlmx MCP host to complete one delegated task. ` +
      `Work autonomously to completion — you cannot ask the host follow-up questions mid-run — and ` +
      `end with your final report: the complete answer to the task, self-contained and written for the host's user.`,
  ];
  if (contextNote) parts.push(contextNote);
  if (config.system) parts.push(`## Agent instructions\n\n${config.system}`);
  if (config.criteria) {
    parts.push(`## Output criteria\n\nWhen providing your final answer, follow these criteria:\n${config.criteria}`);
  }
  return parts.join("\n\n");
}

/** Resolve the wall-clock deadline — legacy's override, same default. */
function primeDeadlineMs(): number {
  const ms = Number(process.env.RLMX_MCP_RUN_TIMEOUT_MS);
  return Number.isFinite(ms) && ms > 0 ? ms : DEFAULT_PRIME_DEADLINE_MS;
}

function buildArgv(
  binaryPath: string,
  agent: Microagent | undefined,
  request: BackendRequest,
  preparedContext: Pick<PreparedPrimeContext, "fileArgs" | "labels">
): string[] {
  const config = request.config;
  assertSupportedConfig(config, agent?.name);
  const mapped = mapPrimeModel(config.model, agent?.name);

  const contextFiles = preparedContext.fileArgs;
  const contextNote =
    contextFiles.length > 0
      ? `## Caller-provided context\n\nThe host attached ${contextFiles.length} immutable file snapshot(s) to this task, corresponding to: ${preparedContext.labels.join(", ")}. Read them before answering.`
      : null;
  const role = buildAppendedRole(agent, config, contextNote);

  const argv: string[] = [
    binaryPath,
    "--mode", "json",
    "-p",
    "--offline",
    "--no-session",
    "--cwd", request.cwd,
    // Host hermeticity: no AGENTS.md/CLAUDE.md, extension, skill, or prompt
    // template from the host machine participates in the run.
    "-nc", "-ne", "-ns", "-np",
    "--provider", mapped.provider,
    "--model", mapped.model,
  ];
  if (config.gemini?.thinkingLevel) argv.push("--thinking", config.gemini.thinkingLevel);
  argv.push("--append-system-prompt", role);
  argv.push(...contextFiles, "--", request.query);
  return argv;
}

export class PrimeBackend implements RuntimeBackend {
  private readonly binaryPath: string;
  private readonly engine: PrimeEngine;

  constructor(options: PrimeBackendOptions = {}) {
    this.binaryPath =
      options.binaryPath ?? process.env.RLMX_PRIME_BINARY_PATH ?? "prime-agent";
    const environment = options.environment ?? buildPrimeChildEnv;
    this.engine =
      options.engine ??
      ((argv, emit, limits, signal) => {
        const providerIndex = argv.indexOf("--provider");
        const provider = providerIndex >= 0 ? argv[providerIndex + 1] : undefined;
        if (!provider) throw new Error("prime backend: internal error: spawn argv has no --provider");
        return spawnPrimeRun(
          argv,
          emit,
          limits,
          environment(process.env, provider),
          signal
        );
      });
    // Backend startup: the version pin is asserted once per instance. The
    // server constructs this lazily on first prime selection (selectBackend),
    // so a machine without prime-agent never pays for it — and the injected
    // engine seam skips it entirely.
    if (!options.engine) assertPinnedVersion(this.binaryPath, options.expectedVersion ?? EXPECTED_PRIME_VERSION);
  }

  async run(
    agent: Microagent | undefined,
    request: BackendRequest,
    emit: (message: string) => void
  ): Promise<MicroagentResult> {
    const limits: PrimeRunLimits = {
      deadlineMs: primeDeadlineMs(),
      maxCost: request.config.budget?.maxCost ?? null,
      maxTokens: request.config.budget?.maxTokens ?? null,
      maxTurns: request.maxIterations !== undefined ? request.maxIterations : null,
    };

    const preparedContext = await prepareContextSnapshot(request.context, request.contextRoot);
    let result: PrimeRunResult;
    try {
      result = await this.engine(
        buildArgv(this.binaryPath, agent, request, preparedContext),
        emit,
        limits,
        request.signal
      );
    } finally {
      await preparedContext.cleanup();
    }

    return {
      answer: result.answer,
      iterations: result.turns,
      budgetHit: result.budgetHit,
      usage: {
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        totalCost: result.usage.totalCost,
      },
    };
  }
}
