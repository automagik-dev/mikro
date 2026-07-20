import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createUsage, mergeUsage, usageDelta, parseRlmChildOutput, buildRlmChildArgs, buildChildEnv } from "../src/llm.js";
import { buildStats } from "../src/output.js";
import { LangfuseTraceRecorder } from "../src/langfuse.js";
describe("recursive RLM tracing helpers", () => {
    it("parses child json answer, run id, usage, and stats without losing the answer", () => {
        const parsed = parseRlmChildOutput(JSON.stringify({
            answer: "child verdict",
            usage: { inputTokens: 11, outputTokens: 7, cacheReadTokens: 2, cacheWriteTokens: 3, totalCost: 0.0123, llmCalls: 2 },
            stats: { run_id: "child-run-123" },
        }));
        assert.equal(parsed.answer, "child verdict");
        assert.equal(parsed.runId, "child-run-123");
        assert.deepEqual(parsed.usage, { inputTokens: 11, outputTokens: 7, cacheReadTokens: 2, cacheWriteTokens: 3, totalCost: 0.0123, llmCalls: 2 });
    });
    it("builds bounded child invocation flags and increments recursion depth in env", () => {
        const args = buildRlmChildArgs("subproblem", {
            output: "json",
            maxIterations: 4,
            timeout: 120000,
            maxDepth: 3,
            maxCost: 0.25,
            maxTokens: 5000,
            logPath: "/tmp/parent.jsonl",
            stats: true,
            noSession: true,
        });
        assert.deepEqual(args, [
            "subproblem",
            "--output", "json",
            "--stats",
            "--max-iterations", "4",
            "--timeout", "120000",
            "--max-depth", "3",
            "--max-cost", "0.25",
            "--max-tokens", "5000",
            "--no-session",
        ]);
        const env = buildChildEnv({ ...process.env, RLMX_RECURSION_DEPTH: "1" }, "parent-run", "child-corr");
        assert.equal(env.RLMX_PARENT_RUN_ID, "parent-run");
        assert.equal(env.RLMX_CHILD_CORRELATION_ID, "child-corr");
        assert.equal(env.RLMX_RECURSION_DEPTH, "2");
    });
    it("computes root/child/total usage splits", () => {
        const total = createUsage();
        mergeUsage(total, { inputTokens: 100, outputTokens: 50, cacheReadTokens: 5, cacheWriteTokens: 6, totalCost: 0.15, llmCalls: 3 });
        const child = createUsage();
        mergeUsage(child, { inputTokens: 40, outputTokens: 10, cacheReadTokens: 1, cacheWriteTokens: 2, totalCost: 0.05, llmCalls: 1 });
        assert.deepEqual(usageDelta(total, child), {
            inputTokens: 60,
            outputTokens: 40,
            cacheReadTokens: 4,
            cacheWriteTokens: 4,
            totalCost: 0.09999999999999999,
            llmCalls: 2,
            reasoningTokens: 0,
        });
    });
    it("includes root/child/total token and cost splits in stats", () => {
        const result = {
            answer: "ok",
            references: [],
            usage: { inputTokens: 150, outputTokens: 80, cacheReadTokens: 0, cacheWriteTokens: 0, totalCost: 0.23, llmCalls: 5 },
            usageBreakdown: {
                root: { inputTokens: 100, outputTokens: 60, cacheReadTokens: 0, cacheWriteTokens: 0, totalCost: 0.16, llmCalls: 3 },
                child: { inputTokens: 50, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0, totalCost: 0.07, llmCalls: 2 },
                total: { inputTokens: 150, outputTokens: 80, cacheReadTokens: 0, cacheWriteTokens: 0, totalCost: 0.23, llmCalls: 5 },
            },
            iterations: 2,
            model: "openrouter/deepseek-v4-pro",
        };
        const stats = buildStats(result, { time_ms: 1000, run_id: "root-run" });
        assert.deepEqual(stats.usage_split, {
            root: { input_tokens: 100, output_tokens: 60, total_tokens: 160, total_cost: 0.16, llm_calls: 3 },
            child: { input_tokens: 50, output_tokens: 20, total_tokens: 70, total_cost: 0.07, llm_calls: 2 },
            total: { input_tokens: 150, output_tokens: 80, total_tokens: 230, total_cost: 0.23, llm_calls: 5 },
        });
    });
    it("builds a Langfuse parent trace with child_start and child_end spans", async () => {
        const payloads = [];
        const recorder = new LangfuseTraceRecorder({
            host: "https://langfuse.example",
            publicKey: "pk",
            secretKey: "sk",
            fetchImpl: async (_url, init) => {
                payloads.push(JSON.parse(String(init?.body)));
                return new Response("{}", { status: 200 });
            },
        });
        recorder.startTrace({ runId: "root-run", query: "root query", model: "openrouter/deepseek-v4-pro" });
        const spanId = recorder.childStart({ parentRunId: "root-run", childRunId: "pending", correlationId: "child-1", prompt: "child query", depth: 1 });
        recorder.childEnd(spanId, { childRunId: "child-run", answerPreview: "child answer", durationMs: 42, usage: { inputTokens: 3, outputTokens: 4, cacheReadTokens: 0, cacheWriteTokens: 0, totalCost: 0.01, llmCalls: 1 } });
        await recorder.flush();
        const batch = payloads.flatMap((p) => p.batch);
        assert.equal(batch.some((e) => e.type === "trace-create"), true);
        assert.equal(batch.filter((e) => e.type === "span-create").length, 1);
        assert.equal(batch.filter((e) => e.type === "span-update").length, 1);
        assert.equal(batch.find((e) => e.type === "span-update").body.metadata.child_run_id, "child-run");
    });
    it("builds root Langfuse generation create/update events with model, IO, usage, and latency", async () => {
        const payloads = [];
        const recorder = new LangfuseTraceRecorder({
            host: "https://langfuse.example",
            publicKey: "pk",
            secretKey: "sk",
            fetchImpl: async (_url, init) => {
                payloads.push(JSON.parse(String(init?.body)));
                return new Response("{}", { status: 200 });
            },
        });
        recorder.startTrace({ runId: "root-run", query: "root query", model: "anthropic/claude-opus-4-8" });
        const generationId = recorder.rootGenerationStart({
            name: "Model call — root iteration 1",
            input: [{ role: "user", content: "hello" }],
            model: "anthropic/claude-opus-4-8",
            iteration: 0,
        });
        recorder.rootGenerationEnd(generationId, {
            output: "world",
            durationMs: 123,
            usage: { inputTokens: 5, outputTokens: 7, cacheReadTokens: 0, cacheWriteTokens: 2, totalCost: 0.42, llmCalls: 1 },
        });
        await recorder.flush();
        const batch = payloads.flatMap((p) => p.batch);
        const generationCreate = batch.find((e) => e.type === "generation-create");
        const generationUpdate = batch.find((e) => e.type === "generation-update");
        assert.ok(generationCreate, "generation-create event missing");
        assert.ok(generationUpdate, "generation-update event missing");
        assert.equal(generationCreate.body.traceId, "root-run");
        assert.equal(generationCreate.body.model, "anthropic/claude-opus-4-8");
        assert.deepEqual(generationCreate.body.input, [{ role: "user", content: "hello" }]);
        assert.equal(generationUpdate.body.output, "world");
        assert.equal(generationUpdate.body.usage.input, 5);
        assert.equal(generationUpdate.body.usage.output, 7);
        assert.equal(generationUpdate.body.usage.total, 14);
        assert.equal(generationUpdate.body.usageDetails.input, 5);
        assert.equal(generationUpdate.body.usageDetails.output, 7);
        assert.equal(generationUpdate.body.usageDetails.cache_read, 0);
        assert.equal(generationUpdate.body.usageDetails.cache_write, 2);
        assert.equal(generationUpdate.body.costDetails.total, 0.42);
        assert.equal(generationUpdate.body.metadata.duration_ms, 123);
        assert.equal(generationUpdate.body.metadata.total_cost, 0.42);
    });
});
//# sourceMappingURL=recursive-trace.test.js.map