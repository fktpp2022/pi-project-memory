import assert from "node:assert/strict";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { createChildTools } from "../src/child-tools.ts";
import { createToolWorkspace, skipBlockOnWindows, WINDOWS_XARGS_REASON } from "./helpers.ts";

async function workspace(t: TestContext) {
	const { root, memoryDir, projectRoot, locksDir } = await createToolWorkspace(t, "pi-memory-boundaries-");
	const scratchDir = join(root, "scratch");
	await mkdir(scratchDir);
	return {
		root,
		memoryDir,
		projectRoot,
		cwd: projectRoot,
		locksDir,
		scratchDir,
		isCurrentGeneration: () => true,
		touchedPaths: new Set<string>(),
	};
}

function resultText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.map((block) => block.text ?? "").join("\n");
}

test("native grep ignores host configuration without changing the environment", async (t) => {
	const env = await workspace(t);
	const outside = join(env.root, "outside.txt");
	await writeFile(outside, "OUTSIDE_MARKER\n");
	await writeFile(join(env.projectRoot, "inside.txt"), "INSIDE_MARKER\n");
	await symlink(outside, join(env.projectRoot, "linked.txt"));
	const config = join(env.root, "ripgrep.config");
	await writeFile(config, "--follow\n--fixed-strings\n");
	const previous = process.env.RIPGREP_CONFIG_PATH;
	process.env.RIPGREP_CONFIG_PATH = config;
	t.after(() => {
		if (previous === undefined) delete process.env.RIPGREP_CONFIG_PATH;
		else process.env.RIPGREP_CONFIG_PATH = previous;
	});
	const tools = new Map(createChildTools({ ...env, mode: "dream" }).map((tool) => [tool.name, tool]));
	const result = await tools.get("grep")!.execute("grep", {
		path: env.projectRoot,
		pattern: "(INSIDE|OUTSIDE)_MARKER",
		glob: "**/*",
	});
	assert.notEqual(result.isError, true);
	assert.match(resultText(result), /INSIDE_MARKER/);
	assert.doesNotMatch(resultText(result), /OUTSIDE_MARKER/);
	assert.equal(process.env.RIPGREP_CONFIG_PATH, config);
});

test("dream tools read original session directories and keep them read-only", async (t) => {
	const env = await workspace(t);
	const sessions = join(env.projectRoot, "shared-sessions");
	await mkdir(sessions);
	const transcript = join(sessions, "session.jsonl");
	await writeFile(transcript, "SESSION_MARKER\n");
	const tools = new Map(
		createChildTools({ ...env, mode: "dream", sessionDir: sessions }).map((tool) => [tool.name, tool]),
	);
	const read = await tools.get("read")!.execute("session", { path: transcript });
	assert.notEqual(read.isError, true);
	assert.match(resultText(read), /SESSION_MARKER/);
	const found = await tools.get("find")!.execute("sessions", { path: sessions, pattern: "*.jsonl" });
	assert.notEqual(found.isError, true);
	assert.match(resultText(found), /session.jsonl/);
	const grep = await tools.get("grep")!.execute("sessions", { path: sessions, pattern: "SESSION_MARKER" });
	assert.notEqual(grep.isError, true);
	assert.match(resultText(grep), /SESSION_MARKER/);
	const commands = [`head -n 1 '${transcript}'`];
	if (!skipBlockOnWindows(t, WINDOWS_XARGS_REASON))
		commands.push("printf 'shared-sessions/session.jsonl\\n' | xargs head -n 1");
	for (const command of commands) {
		const result = await tools.get("bash")!.execute("sessions", { command });
		assert.notEqual(result.isError, true, resultText(result));
		assert.match(resultText(result), /SESSION_MARKER/);
	}
	assert.equal(
		(await tools.get("write")!.execute("session-write", { path: transcript, content: "changed" })).isError,
		true,
	);
	assert.equal(await readFile(transcript, "utf8"), "SESSION_MARKER\n");
});

test("native Bash runs xargs and env commands without earlier calls", async (t) => {
	const env = await workspace(t);
	await writeFile(join(env.projectRoot, "inside.md"), "project value\n");
	await writeFile(join(env.projectRoot, "-danger.md"), "dash filename value\n");
	const xargsCommands = skipBlockOnWindows(t, WINDOWS_XARGS_REASON)
		? []
		: [
				"printf 'inside.md\\n' | xargs head -n 1",
				"printf 'value\\n' | xargs echo",
				"printf '%s\\n' '-danger.md' | xargs head -n 1 --",
			];
	for (const [index, command] of [...xargsCommands, "env head -n 1 inside.md"].entries()) {
		const scratchDir = join(env.root, `fresh-${index}`);
		await mkdir(scratchDir);
		const bash = createChildTools({ ...env, mode: "extractor", scratchDir }).find((tool) => tool.name === "bash")!;
		const result = await bash.execute("fresh", { command });
		assert.notEqual(result.isError, true, resultText(result));
		assert.match(resultText(result), /value/);
		assert.doesNotMatch(resultText(result), /ENOENT|Command exited/);
	}
});

test("Bash leaves grep options and xargs input expansion to the native programs", async (t) => {
	const env = await workspace(t);
	await mkdir(join(env.projectRoot, ".git"));
	await writeFile(join(env.projectRoot, ".git", "config"), "NATIVE_GREP_MARKER\n");
	await writeFile(join(env.root, "outside.md"), "NATIVE_XARGS_MARKER\n");
	const bash = createChildTools({ ...env, mode: "extractor" }).find((tool) => tool.name === "bash")!;
	const grep = await bash.execute("grep", { command: "grep -r NATIVE_GREP_MARKER ." });
	assert.notEqual(grep.isError, true, resultText(grep));
	assert.match(resultText(grep), /NATIVE_GREP_MARKER/);
	if (!skipBlockOnWindows(t, WINDOWS_XARGS_REASON)) {
		const xargs = await bash.execute("xargs", { command: "printf '../outside.md\\n' | xargs head -n 1" });
		assert.notEqual(xargs.isError, true, resultText(xargs));
		assert.match(resultText(xargs), /NATIVE_XARGS_MARKER/);
	}
	const explicit = await bash.execute("explicit", { command: "head -n 1 ../outside.md" });
	assert.notEqual(explicit.isError, true);
	assert.match(resultText(explicit), /NATIVE_XARGS_MARKER/);
});

test("explicit pages establish Claude-style baselines but automatic truncation revokes them", async (t) => {
	const env = await workspace(t);
	const topic = join(env.memoryDir, "large.md");
	await writeFile(topic, Array.from({ length: 2001 }, (_, index) => `line-${index}`).join("\n"));
	const tools = new Map(createChildTools({ ...env, mode: "extractor" }).map((tool) => [tool.name, tool]));
	await tools.get("read")!.execute("automatic", { path: topic });
	assert.equal(
		(
			await tools
				.get("edit")!
				.execute("no-baseline", { path: topic, edits: [{ oldText: "line-0\n", newText: "changed\n" }] })
		).isError,
		true,
	);
	await tools.get("read")!.execute("empty-page", { path: topic, limit: 0 });
	assert.equal(
		(
			await tools
				.get("edit")!
				.execute("empty-page-edit", { path: topic, edits: [{ oldText: "line-0\n", newText: "changed\n" }] })
		).isError,
		true,
	);
	await tools.get("read")!.execute("first-page", { path: topic, limit: 1500 });
	await tools.get("read")!.execute("last-page", { path: topic, offset: 1501 });
	const edit = await tools
		.get("edit")!
		.execute("paged-edit", { path: topic, edits: [{ oldText: "line-0\n", newText: "changed\n" }] });
	assert.notEqual(edit.isError, true, resultText(edit));
	assert.match(await readFile(topic, "utf8"), /^changed/);
	await tools.get("read")!.execute("automatic-again", { path: topic });
	assert.equal(
		(await tools.get("write")!.execute("truncated-write", { path: topic, content: "replacement\n" })).isError,
		true,
	);
	await tools.get("read")!.execute("explicit", { path: topic, offset: 1501, limit: 1 });
	assert.notEqual(
		(await tools.get("write")!.execute("paged-write", { path: topic, content: "replacement\n" })).isError,
		true,
	);
	await tools.get("read")!.execute("read-delete", { path: topic, limit: 1 });
	assert.notEqual((await tools.get("bash")!.execute("paged-delete", { command: `rm '${topic}'` })).isError, true);
});
