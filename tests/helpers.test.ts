import assert from "node:assert/strict";
import { mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { removeTempDirectory, skipBlockOnWindows, skipOnWindows } from "./helpers.ts";

function recorder() {
	const skips: string[] = [];
	const diagnostics: string[] = [];
	const context = {
		skip: (message?: string) => skips.push(message ?? ""),
		diagnostic: (message: string) => diagnostics.push(message),
	} as unknown as TestContext;
	return { context, diagnostics, skips };
}

function lockingError(code: string): NodeJS.ErrnoException {
	return Object.assign(new Error(`${code}: resource busy or locked`), { code });
}

test("skipOnWindows skips only on win32 and reports the reason", () => {
	const posix = recorder();
	assert.equal(skipOnWindows(posix.context, "xargs is POSIX-only", "linux"), false);
	assert.deepEqual(posix.skips, []);

	const windows = recorder();
	assert.equal(skipOnWindows(windows.context, "xargs is POSIX-only", "win32"), true);
	assert.deepEqual(windows.skips, ["Windows: xargs is POSIX-only"]);
});

test("skipBlockOnWindows records a visible reason without skipping the whole test", () => {
	const posix = recorder();
	assert.equal(skipBlockOnWindows(posix.context, "xargs is POSIX-only", "linux"), false);
	assert.deepEqual(posix.diagnostics, []);

	const windows = recorder();
	assert.equal(skipBlockOnWindows(windows.context, "xargs is POSIX-only", "win32"), true);
	assert.deepEqual(windows.diagnostics, ["Windows skip: xargs is POSIX-only"]);
	assert.deepEqual(windows.skips, []);
});

test("removeTempDirectory removes a directory tree", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-memory-helper-remove-"));
	await writeFile(join(root, "fact.md"), "fact\n");
	await removeTempDirectory(root);
	await assert.rejects(stat(root), { code: "ENOENT" });
});

test("removeTempDirectory retries locking errors with bounded increasing backoff", async () => {
	const delays: number[] = [];
	let calls = 0;
	await removeTempDirectory("unused", {
		baseDelayMs: 50,
		delay: async (ms) => {
			delays.push(ms);
		},
		remove: async () => {
			calls += 1;
			if (calls < 3) throw lockingError(calls === 1 ? "EBUSY" : "EPERM");
		},
	});
	assert.equal(calls, 3);
	assert.equal(delays.length, 2);
	for (const [index, delay] of delays.entries()) {
		const floor = 50 * 2 ** index;
		assert.ok(delay >= floor && delay < floor * 2, `${delay} outside [${floor}, ${floor * 2})`);
	}
});

test("removeTempDirectory gives up after five bounded attempts", async () => {
	let calls = 0;
	await assert.rejects(
		removeTempDirectory("unused", {
			baseDelayMs: 1,
			delay: async () => {},
			remove: async () => {
				calls += 1;
				throw lockingError("EBUSY");
			},
		}),
		/EBUSY/,
	);
	assert.equal(calls, 5);
});

test("removeTempDirectory rethrows non-locking errors without retrying", async () => {
	let calls = 0;
	await assert.rejects(
		removeTempDirectory("unused", {
			delay: async () => {},
			remove: async () => {
				calls += 1;
				throw lockingError("ENOENT");
			},
		}),
		/ENOENT/,
	);
	assert.equal(calls, 1);
});

test("removeTempDirectory leaves a working directory inside the temp tree first", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-memory-helper-chdir-"));
	const previous = process.cwd();
	try {
		process.chdir(root);
		await removeTempDirectory(root);
		assert.notEqual(process.cwd(), root);
		await assert.rejects(stat(root), { code: "ENOENT" });
	} finally {
		process.chdir(previous);
	}
});
