import { execFile } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { REPL } from "../src/repl.js";
import {
	createToolRegistry,
	toolRegistryAsResolver,
} from "../src/sdk/index.js";

const execFileAsync = promisify(execFile);
const echoStub = `def echo(**kwargs):
    return call_tool("echo", kwargs)`;

async function hasPython(): Promise<boolean> {
	try {
		await execFileAsync("python3", ["--version"], { timeout: 2_000 });
		return true;
	} catch {
		return false;
	}
}

function assertRuntimeError(
	result: Awaited<ReturnType<REPL["execute"]>>,
	text: RegExp,
): void {
	assert.match(result.error ?? result.stderr, /RuntimeError/);
	assert.match(result.error ?? result.stderr, text);
}

async function assertAlive(repl: REPL): Promise<void> {
	const followUp = await repl.execute('print("still-alive")');
	assert.equal(followUp.error, undefined, followUp.stderr);
	assert.match(followUp.stdout, /still-alive/);
	assert.equal(repl.isRunning(), true);
}

describe("REPL tool bridge", () => {
	let pythonAvailable = false;

	before(async () => {
		pythonAvailable = await hasPython();
	});

	it("JSON-round-trips results and retains the handler after recovery", async (ctx) => {
		if (!pythonAvailable) {
			ctx.diagnostic("python3 not on PATH — skipping REPL subprocess test");
			return;
		}

		const repl = new REPL();
		repl.onToolRequest(async (_tool, args, signal) => {
			assert.equal(signal.aborted, false);
			return args;
		});
		try {
			await repl.start({ tools: { echo: echoStub } });
			const first = await repl.execute('import json\nprint(json.dumps(echo(x=1)))');
			assert.equal(first.error, undefined, first.stderr);
			assert.deepEqual(JSON.parse(first.stdout.trim()), { x: 1 });

			const process = (repl as unknown as { process: ChildProcess }).process;
			const exited = new Promise<void>((resolve) =>
				process.once("exit", () => resolve()),
			);
			process.kill("SIGKILL");
			await exited;

			const recovered = await repl.execute('import json\nprint(json.dumps(echo(x=2)))');
			assert.equal(recovered.error, undefined, recovered.stderr);
			assert.deepEqual(JSON.parse(recovered.stdout.trim()), { x: 2 });
			assert.equal(repl.isRunning(), true);
		} finally {
			await repl.stop();
		}
	});

	it("turns bridge failures into RuntimeError and stays alive", async (ctx) => {
		if (!pythonAvailable) {
			ctx.diagnostic("python3 not on PATH — skipping REPL subprocess test");
			return;
		}

		const repl = new REPL();
		try {
			await repl.start({ tools: { echo: echoStub } });

			repl.onToolRequest(async () => {
				throw "plain handler rejection";
			});
			assertRuntimeError(await repl.execute("echo(x=1)"), /plain handler rejection/);
			await assertAlive(repl);

			repl.onToolRequest(async () => 1n);
			assertRuntimeError(await repl.execute("echo(x=1)"), /BigInt|serializ/);
			await assertAlive(repl);

			const registry = createToolRegistry();
			repl.onToolRequest(toolRegistryAsResolver(registry));
			assertRuntimeError(await repl.execute("echo(x=1)"), /unknown tool.*echo/i);
			await assertAlive(repl);

			repl.onToolRequest(async (_tool, args) => args);
			const writable = repl as unknown as {
				_send(message: Record<string, unknown>): void;
			};
			const send = writable._send.bind(repl);
			let failNextResponse = true;
			writable._send = (message) => {
				if (message.type === "tool_response" && failNextResponse) {
					failNextResponse = false;
					throw new Error("synthetic send failure");
				}
				send(message);
			};
			assertRuntimeError(await repl.execute("echo(x=1)"), /synthetic send failure/);
			writable._send = send;
			await assertAlive(repl);
		} finally {
			await repl.stop();
		}
	});

	it("returns RuntimeError when no handler is registered and remains alive", async (ctx) => {
		if (!pythonAvailable) {
			ctx.diagnostic("python3 not on PATH — skipping REPL subprocess test");
			return;
		}

		const repl = new REPL();
		try {
			await repl.start({ tools: { echo: echoStub } });
			assertRuntimeError(await repl.execute("echo(x=1)"), /No tool handler configured/);
			await assertAlive(repl);
		} finally {
			await repl.stop();
		}
	});
});
