import assert from "node:assert/strict";
import { access, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, win32 } from "node:path";
import test from "node:test";
import { createChildTools } from "../src/child-tools.ts";
import { prepareRestrictedBash } from "../src/restricted-bash.ts";
import { createToolWorkspace } from "./helpers.ts";

test("memory deletion parses escaped spaces, quoted concatenations, and literal special characters", async (t) => {
	const env = await createToolWorkspace(t, "pi-memory-rm-arguments-");
	const bash = createChildTools({
		...env,
		mode: "extractor",
		cwd: env.projectRoot,
		isCurrentGeneration: () => true,
		touchedPaths: new Set(),
	}).find((tool) => tool.name === "bash")!;
	for (const [filename, command] of [
		["old fact.md", `rm ${env.memoryDir}/old\\ fact.md`],
		["mixed quote.md", `rm '${env.memoryDir}'/'mixed '"quote".md`],
		['double "quote".md', `rm "${env.memoryDir}/double \\"quote\\".md"`],
		["literal $value.md", `rm '${env.memoryDir}/literal $value.md'`],
		["command name.md", `r""m '${env.memoryDir}/command name.md'`],
		["linecontinued.md", `rm ${env.memoryDir}/line\\\ncontinued.md`],
	] as const) {
		const path = join(env.memoryDir, filename);
		await writeFile(path, "remove this file\n");
		const prepared = await prepareRestrictedBash(command, { cwd: env.projectRoot, memoryDir: env.memoryDir });
		assert.deepEqual(prepared, { kind: "delete", paths: [path], force: false });
		const result = await bash.execute("delete", { command });
		assert.notEqual(result.isError, true, JSON.stringify(result));
		await assert.rejects(access(path), { code: "ENOENT" });
	}
});

test("memory deletion still requires one static command without assignments or redirects", async (t) => {
	const env = await createToolWorkspace(t, "pi-memory-rm-static-");
	const path = join(env.memoryDir, "keep.md");
	await writeFile(path, "keep this file\n");
	for (const command of [
		`rm '${path}' && echo extra`,
		`rm '${path}'; echo extra`,
		`rm '${path}' | cat`,
		`rm '${path}' &`,
		`rm '${path}' > /dev/null`,
		`LANG=C rm '${path}'`,
		`value=1; rm '${path}'`,
		`rm "${env.memoryDir}/$NAME.md"`,
		`rm "${env.memoryDir}/$(printf keep).md"`,
		`rm ${env.memoryDir}/*.md`,
		`rm -r '${path}'`,
		`rm '${join(env.projectRoot, "outside.md")}'`,
	])
		await assert.rejects(prepareRestrictedBash(command, { cwd: env.projectRoot, memoryDir: env.memoryDir }), command);
	await access(path);
});

test("rm normalizes every accepted Windows operand form before containment", async () => {
	const memoryDir = "C:\\pi-rm-fixture\\memory";
	const cwd = "C:\\pi-rm-fixture\\project";
	const expected = `${memoryDir}\\topic.md`;
	for (const operand of [
		expected,
		"C:/pi-rm-fixture/memory/topic.md",
		"/c/pi-rm-fixture/memory/topic.md",
		"/cygdrive/c/pi-rm-fixture/memory/topic.md",
		"/mnt/c/pi-rm-fixture/memory/topic.md",
		"\\\\?\\C:\\pi-rm-fixture\\memory\\topic.md",
	]) {
		const prepared = await prepareRestrictedBash(`rm '${operand}'`, { cwd, memoryDir }, "win32");
		assert.deepEqual(prepared, { kind: "delete", paths: [expected], force: false }, operand);
	}
	const homeMemory = win32.join(homedir(), "pi-rm-home", "memory");
	const homePrepared = await prepareRestrictedBash(
		`rm '~/pi-rm-home/memory/topic.md'`,
		{
			cwd,
			memoryDir: homeMemory,
		},
		"win32",
	);
	assert.deepEqual(homePrepared, { kind: "delete", paths: [win32.join(homeMemory, "topic.md")], force: false });
	for (const operand of [
		"topic.md",
		"./topic.md",
		"../memory/topic.md",
		"C:pi-rm-fixture\\memory\\topic.md",
		"/other-root/topic.md",
	]) {
		await assert.rejects(
			prepareRestrictedBash(`rm '${operand}'`, { cwd, memoryDir }, "win32"),
			/absolute|contained|escapes|drive-relative/i,
			operand,
		);
	}
	await assert.rejects(prepareRestrictedBash(`rm '${memoryDir}\\topic.txt'`, { cwd, memoryDir }, "win32"), /\.md/);
	await assert.rejects(
		prepareRestrictedBash(`rm 'C:\\pi-rm-fixture\\outside.md'`, { cwd, memoryDir }, "win32"),
		/escapes/,
	);
});

test("rm deletes an uppercase .MD topic on Windows and still rejects it on POSIX", async (t) => {
	const env = await createToolWorkspace(t, "pi-memory-rm-case-");
	const path = join(env.memoryDir, "FOO.MD");
	await writeFile(path, "uppercase topic\n");
	const command = `rm '${path}'`;
	if (process.platform === "win32") {
		const bash = createChildTools({
			...env,
			mode: "extractor",
			cwd: env.projectRoot,
			isCurrentGeneration: () => true,
			touchedPaths: new Set(),
		}).find((tool) => tool.name === "bash")!;
		const result = await bash.execute("delete", { command });
		assert.notEqual(result.isError, true, JSON.stringify(result));
		await assert.rejects(access(path), { code: "ENOENT" });
	} else
		await assert.rejects(prepareRestrictedBash(command, { cwd: env.projectRoot, memoryDir: env.memoryDir }), /\.md/);
});
