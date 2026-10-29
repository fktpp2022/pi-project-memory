import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { createChildTools } from "../src/child-tools.ts";
import { createToolWorkspace, skipOnWindows } from "./helpers.ts";

function toolMap(tools: ReturnType<typeof createChildTools>) {
	return new Map(tools.map((tool) => [tool.name, tool]));
}

test("child tools normalize native Pi shorthand before read and mutation checks", async (t) => {
	const { memoryDir, projectRoot, locksDir } = await createToolWorkspace(t, "pi-memory-shorthand-");
	const tools = toolMap(
		createChildTools({
			mode: "extractor",
			memoryDir,
			projectRoot,
			cwd: projectRoot,
			locksDir,
			isCurrentGeneration: () => true,
			touchedPaths: new Set(),
		}),
	);
	const file = join(memoryDir, "a topic.md");
	const forms = [
		`@${file}`,
		`~/${relative(homedir(), file)}`,
		pathToFileURL(file).href,
		file.replace("a topic", "a\u00a0topic"),
	];
	for (const path of forms) {
		await writeFile(file, "old fact\n");
		const read = await tools.get("read")!.execute("read", { path });
		assert.notEqual(read.isError, true, JSON.stringify(read));
		assert.equal(read.structuredContent, "old fact\n");
		const edit = await tools.get("edit")!.execute("edit", { path, edits: [{ oldText: "old", newText: "new" }] });
		assert.notEqual(edit.isError, true, JSON.stringify(edit));
		const write = await tools.get("write")!.execute("write", { path, content: "replacement\n" });
		assert.notEqual(write.isError, true, JSON.stringify(write));
		assert.equal(await readFile(file, "utf8"), "replacement\n");
	}
});

test("read-only Git commands work from linked worktrees with an approved checkout", async (t) => {
	const { root, memoryDir, projectRoot, locksDir } = await createToolWorkspace(t, "pi-memory-worktree-git-");
	const git = (args: string[]) => execFileSync("git", ["-C", projectRoot, ...args], { encoding: "utf8" });
	git(["init", "-q"]);
	git([
		"-c",
		"user.name=Test",
		"-c",
		"user.email=test@example.com",
		"-c",
		"commit.gpgsign=false",
		"commit",
		"--allow-empty",
		"-qm",
		"initial",
	]);
	const cwd = join(root, "worktree");
	git(["worktree", "add", "--detach", "-q", cwd]);
	const scratchDir = join(root, "scratch");
	await mkdir(scratchDir);
	for (const approved of [true, false]) {
		const tools = toolMap(
			createChildTools({
				mode: "extractor",
				memoryDir,
				projectRoot: approved ? projectRoot : cwd,
				cwd,
				scratchDir,
				locksDir,
				isCurrentGeneration: () => true,
				touchedPaths: new Set(),
			}),
		);
		for (const command of ["git status --short", "git log --oneline -1"]) {
			const result = await tools.get("bash")!.execute("git", { command });
			assert.notEqual(result.isError, true, JSON.stringify(result));
			if (approved && command.includes("log")) assert.match(JSON.stringify(result.content), /initial/);
		}
	}
});

test("background tools use Pi-native names and schemas", async (t) => {
	const { memoryDir, projectRoot, locksDir } = await createToolWorkspace(t, "pi-memory-native-tools-");
	const tools = toolMap(
		createChildTools({
			mode: "extractor",
			memoryDir,
			projectRoot,
			cwd: projectRoot,
			locksDir,
			isCurrentGeneration: () => true,
			touchedPaths: new Set(),
		}),
	);
	assert.deepEqual([...tools.keys()].sort(), ["bash", "edit", "find", "grep", "read", "write"]);
	assert.deepEqual(Object.keys((tools.get("read")!.parameters as any).properties).sort(), ["limit", "offset", "path"]);
	assert.deepEqual(Object.keys((tools.get("write")!.parameters as any).properties).sort(), ["content", "path"]);
	assert.deepEqual(Object.keys((tools.get("edit")!.parameters as any).properties).sort(), ["edits", "path"]);
	assert.deepEqual(Object.keys((tools.get("find")!.parameters as any).properties).sort(), ["limit", "path", "pattern"]);
	assert.deepEqual(Object.keys((tools.get("bash")!.parameters as any).properties).sort(), ["command", "timeout"]);
	assert.deepEqual(Object.keys((tools.get("grep")!.parameters as any).properties).sort(), [
		"context",
		"glob",
		"ignoreCase",
		"limit",
		"literal",
		"path",
		"pattern",
	]);
});

test("bash is omitted from the child tool list when no Git Bash is available", async (t) => {
	const { memoryDir, projectRoot, locksDir } = await createToolWorkspace(t, "pi-memory-no-bash-");
	for (const shell of [
		{ available: false as const, reason: "not-found" as const },
		{
			available: false as const,
			reason: "rejected" as const,
			path: "C:\\Windows\\System32\\bash.exe",
			detail: "wsl" as const,
		},
	]) {
		const tools = createChildTools({
			mode: "extractor",
			memoryDir,
			projectRoot,
			cwd: projectRoot,
			locksDir,
			isCurrentGeneration: () => true,
			touchedPaths: new Set(),
			shell,
		});
		assert.deepEqual(
			tools.map((tool) => tool.name),
			["read", "write", "edit", "find", "grep"],
		);
	}
});

test("bash is listed when a Git Bash is available", async (t) => {
	const { memoryDir, projectRoot, locksDir } = await createToolWorkspace(t, "pi-memory-with-bash-");
	const tools = createChildTools({
		mode: "extractor",
		memoryDir,
		projectRoot,
		cwd: projectRoot,
		locksDir,
		isCurrentGeneration: () => true,
		touchedPaths: new Set(),
		shell: { available: true, path: "C:\\Program Files\\Git\\bin\\bash.exe" },
	});
	assert.deepEqual(
		tools.map((tool) => tool.name),
		["read", "write", "edit", "find", "grep", "bash"],
	);
});

test("a shell removed mid-run fails only individual bash calls", async (t) => {
	const { root, memoryDir, projectRoot, locksDir } = await createToolWorkspace(t, "pi-memory-shell-removed-");
	const scratchDir = join(root, "scratch");
	await mkdir(scratchDir);
	const file = join(memoryDir, "fact.md");
	await writeFile(file, "fact\n");
	const tools = toolMap(
		createChildTools({
			mode: "extractor",
			memoryDir,
			projectRoot,
			cwd: projectRoot,
			scratchDir,
			locksDir,
			isCurrentGeneration: () => true,
			touchedPaths: new Set(),
			shell: { available: true, path: join(root, "removed", "bash.exe") },
		}),
	);
	const bash = await tools.get("bash")!.execute("bash", { command: "ls" });
	assert.equal(bash.isError, true);
	assert.equal((await tools.get("read")!.execute("read", { path: file })).structuredContent, "fact\n");
});

test("all background tools inherit the parent cwd for both roles", async (t) => {
	const { root, memoryDir, projectRoot, locksDir } = await createToolWorkspace(t, "pi-memory-relative-tools-");
	// A linked worktree can live outside the canonical checkout used for memory identity.
	const cwd = join(root, "worktree", "nested");
	const scratchDir = join(root, "scratch");
	await Promise.all([mkdir(cwd, { recursive: true }), mkdir(scratchDir)]);
	assert.notEqual(process.cwd(), cwd);
	await writeFile(join(projectRoot, "fact.md"), "checkout fact\n");
	await writeFile(join(cwd, "fact.md"), "parent fact\n");
	await writeFile(join(root, "worktree", "outside-cwd.md"), "outside cwd\n");
	const topic = join(memoryDir, "nested", "fact.md");
	const memoryPath = relative(cwd, topic);
	for (const mode of ["extractor", "dream"] as const) {
		const tools = toolMap(
			createChildTools({
				mode,
				memoryDir,
				projectRoot,
				cwd,
				locksDir,
				scratchDir,
				isCurrentGeneration: () => true,
				touchedPaths: new Set(),
			}),
		);
		const read = tools.get("read")!;
		const write = tools.get("write")!;
		const edit = tools.get("edit")!;
		const projectRead = await read.execute("project", { path: "fact.md" });
		assert.notEqual(projectRead.isError, true);
		assert.equal(projectRead.structuredContent, "parent fact\n");
		for (const name of ["find", "grep"] as const) {
			for (const path of [undefined, "."]) {
				const result = await tools
					.get(name)!
					.execute(name, { pattern: name === "find" ? "*.md" : "parent fact", path });
				assert.notEqual(result.isError, true);
				assert.match(JSON.stringify(result.content), /fact.md/);
				assert.doesNotMatch(JSON.stringify(result.content), /outside-cwd/);
			}
		}
		const pwd = await tools.get("bash")!.execute("pwd", { command: "pwd" });
		assert.notEqual(pwd.isError, true);
		assert.equal(pwd.content[0]?.type === "text" && pwd.content[0].text.trim(), await realpath(cwd));
		const bashRead = await tools.get("bash")!.execute("relative-read", { command: "cat fact.md" });
		assert.notEqual(bashRead.isError, true);
		assert.match(JSON.stringify(bashRead.content), /parent fact/);
		const rejectedWrite = await write.execute("outside-memory", { path: "fact.md", content: "wrong\n" });
		assert.equal(rejectedWrite.isError, true);
		const written = await write.execute("write", { path: memoryPath, content: "memory fact\n" });
		assert.notEqual(written.isError, true);
		const memoryRead = await read.execute("memory", { path: memoryPath });
		assert.notEqual(memoryRead.isError, true);
		assert.equal(memoryRead.structuredContent, "memory fact\n");
		const edited = await edit.execute("edit", {
			path: memoryPath,
			edits: [{ oldText: "memory fact", newText: "updated fact" }],
		});
		assert.notEqual(edited.isError, true);
		assert.equal(await readFile(topic, "utf8"), "updated fact\n");
		await rm(topic);
	}
	assert.equal(await readFile(join(cwd, "fact.md"), "utf8"), "parent fact\n");
	assert.equal(await readFile(join(projectRoot, "fact.md"), "utf8"), "checkout fact\n");
});

test("ordinary explicit Read pages authorize mutations while preserving Pi transformations", async (t) => {
	const { memoryDir, projectRoot, locksDir } = await createToolWorkspace(t, "pi-memory-native-mutation-");
	const topic = join(memoryDir, "fact.md");
	await writeFile(topic, "---\ndescription: fact\n---\nold\n");
	const touchedPaths = new Set<string>();
	const tools = toolMap(
		createChildTools({
			mode: "extractor",
			memoryDir,
			projectRoot,
			cwd: projectRoot,
			locksDir,
			isCurrentGeneration: () => true,
			touchedPaths,
		}),
	);
	const read = tools.get("read")!;
	const write = tools.get("write")!;
	const edit = tools.get("edit")!;

	const beforeRead = await edit.execute("before-read", { path: topic, edits: [{ oldText: "old", newText: "new" }] });
	assert.equal(beforeRead.isError, true);

	const partial = await read.execute("partial", { path: topic, limit: 1 });
	assert.notEqual(partial.isError, true);
	assert.notEqual(
		(
			await edit.execute("after-partial", {
				path: topic,
				edits: [{ oldText: "description: fact", newText: "description: paged fact" }],
			})
		).isError,
		true,
	);

	const full = await read.execute("full", { path: topic });
	assert.notEqual(full.isError, true);
	assert.equal(full.structuredContent, "---\ndescription: paged fact\n---\nold\n");
	const edited = await edit.execute("edit", { path: topic, edits: [{ oldText: "old", newText: "new" }] });
	assert.notEqual(edited.isError, true);
	assert.match((edited.details as { patch: string }).patch, /\+new/);
	assert.equal(await readFile(topic, "utf8"), "---\ndescription: paged fact\n---\nnew\n");

	await read.execute("read-for-write", { path: topic });
	const written = await write.execute("write", { path: topic, content: "---\ndescription: fact\n---\nupdated\n" });
	assert.notEqual(written.isError, true);
	assert.match((written.details as { patch: string }).patch, /\+updated/);
	assert.deepEqual([...touchedPaths], ["fact.md"]);
});

test("native read truncation and images keep baseline rules without extension-based blocking", async (t) => {
	const { memoryDir, projectRoot, locksDir } = await createToolWorkspace(t, "pi-memory-native-read-contract-");
	const tools = toolMap(
		createChildTools({
			mode: "extractor",
			memoryDir,
			projectRoot,
			cwd: projectRoot,
			locksDir,
			isCurrentGeneration: () => true,
			touchedPaths: new Set(),
		}),
	);
	const read = tools.get("read")!;
	const write = tools.get("write")!;
	const large = join(memoryDir, "large.md");
	await writeFile(large, `${Array.from({ length: 2_100 }, (_, index) => `line-${index}`).join("\n")}\n`);
	const truncated = await read.execute("large", { path: large });
	assert.notEqual(truncated.isError, true);
	assert.ok((truncated.details as { truncation?: unknown } | undefined)?.truncation);
	assert.equal((await write.execute("large-write", { path: large, content: "replacement\n" })).isError, true);

	const png = join(memoryDir, "image.png");
	await writeFile(
		png,
		Buffer.from(
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
			"base64",
		),
	);
	const image = await read.execute("image", { path: png });
	assert.equal(
		image.content.some((block) => block.type === "image"),
		true,
	);
	for (const extension of [".pdf", ".ipynb"]) {
		const unsupported = join(memoryDir, `unsupported${extension}`);
		await writeFile(unsupported, "plain text payload");
		const result = await read.execute(`unsupported-${extension}`, { path: unsupported });
		assert.notEqual(result.isError, true);
		assert.equal(result.structuredContent, "plain text payload");
	}
});

test("edit applies Pi multi-edit transformation and recovers only clean stale edits", async (t) => {
	const { memoryDir, projectRoot, locksDir } = await createToolWorkspace(t, "pi-memory-native-edit-");
	const topic = join(memoryDir, "multi.md");
	await writeFile(topic, "---\ndescription: fact\n---\nalpha\nbeta\nexternal-old\n");
	const tools = toolMap(
		createChildTools({
			mode: "extractor",
			memoryDir,
			projectRoot,
			cwd: projectRoot,
			locksDir,
			isCurrentGeneration: () => true,
			touchedPaths: new Set(),
		}),
	);
	const read = tools.get("read")!;
	const edit = tools.get("edit")!;
	await read.execute("read", { path: topic });
	await writeFile(topic, "---\ndescription: fact\n---\nalpha\nbeta\nexternal-new\n");
	const edited = await edit.execute("edit", {
		path: topic,
		edits: [
			{ oldText: "alpha", newText: "one" },
			{ oldText: "beta", newText: "two" },
		],
	});
	assert.notEqual(edited.isError, true);
	assert.equal((edited.details as { staleRecovered: boolean }).staleRecovered, true);
	assert.equal(await readFile(topic, "utf8"), "---\ndescription: fact\n---\none\ntwo\nexternal-new\n");

	await read.execute("read-conflict", { path: topic });
	await writeFile(topic, "replacement removed the expected text\n");
	const conflict = await edit.execute("conflict", { path: topic, edits: [{ oldText: "one", newText: "lost" }] });
	assert.equal(conflict.isError, true);
	assert.equal(await readFile(topic, "utf8"), "replacement removed the expected text\n");
});

test("native read, find, and grep can read outside the project and memory directories", async (t) => {
	const { root, memoryDir, projectRoot, locksDir } = await createToolWorkspace(t, "pi-memory-native-read-");
	const sessionDir = join(root, "sessions");
	await mkdir(sessionDir);
	const topic = join(memoryDir, "topic.md");
	const projectFile = join(projectRoot, "source.ts");
	const sessionFile = join(sessionDir, "session.jsonl");
	const outside = join(root, "outside.txt");
	await writeFile(topic, "needle memory\n");
	await writeFile(projectFile, "needle project\n");
	await writeFile(sessionFile, "needle session\n");
	await writeFile(outside, "needle outside\n");

	const dreamTools = toolMap(
		createChildTools({
			mode: "dream",
			memoryDir,
			projectRoot,
			cwd: projectRoot,
			locksDir,
			sessionDir,
			isCurrentGeneration: () => true,
			touchedPaths: new Set(),
		}),
	);
	assert.notEqual((await dreamTools.get("read")!.execute("session", { path: sessionFile })).isError, true);
	assert.notEqual((await dreamTools.get("read")!.execute("outside", { path: outside })).isError, true);
	assert.notEqual(
		(await dreamTools.get("find")!.execute("find-outside", { path: root, pattern: "**/*" })).isError,
		true,
	);
	assert.notEqual(
		(await dreamTools.get("grep")!.execute("grep-outside", { path: root, pattern: "needle" })).isError,
		true,
	);

	const found = await dreamTools.get("find")!.execute("find", { path: memoryDir, pattern: "**/*.md" });
	assert.match(found.content[0]?.type === "text" ? found.content[0].text : "", /topic\.md/);
	const grep = await dreamTools.get("grep")!.execute("grep", { path: projectRoot, pattern: "needle", context: 1 });
	assert.match(grep.content[0]?.type === "text" ? grep.content[0].text : "", /source\.ts:1: needle project/);

	const extractorTools = toolMap(
		createChildTools({
			mode: "extractor",
			memoryDir,
			projectRoot,
			cwd: projectRoot,
			locksDir,
			sessionDir,
			isCurrentGeneration: () => true,
			touchedPaths: new Set(),
		}),
	);
	assert.notEqual((await extractorTools.get("read")!.execute("session", { path: sessionFile })).isError, true);
});

test("restricted Pi-native Bash permits outside reads and denies writes", async (t) => {
	if (
		skipOnWindows(
			t,
			"POSIX-only Bash fixture: native backslash paths and xargs input do not behave the same under Git Bash",
		)
	)
		return;
	const { root, memoryDir, projectRoot, locksDir } = await createToolWorkspace(t, "pi-memory-native-bash-");
	const scratchDir = join(root, "scratch");
	await mkdir(scratchDir);
	const memoryFile = join(memoryDir, "inside.md");
	const projectFile = join(projectRoot, "source.txt");
	const outsideFile = join(root, "outside.txt");
	await writeFile(memoryFile, "memory value\n");
	await writeFile(projectFile, "project value\n");
	await writeFile(outsideFile, "outside value\n");
	const extractor = toolMap(
		createChildTools({
			mode: "extractor",
			memoryDir,
			projectRoot,
			cwd: projectRoot,
			locksDir,
			scratchDir,
			isCurrentGeneration: () => true,
			touchedPaths: new Set(),
		}),
	);
	const extractorBash = extractor.get("bash")!;
	const readMemory = await extractorBash.execute("read-memory", { command: `head -n 1 ${memoryFile}` });
	assert.notEqual(readMemory.isError, true);
	assert.match(readMemory.content[0]?.type === "text" ? readMemory.content[0].text : "", /memory value/);
	assert.notEqual((await extractorBash.execute("outside", { command: `cat ${outsideFile}` })).isError, true);
	assert.equal((await extractorBash.execute("write", { command: `echo changed > ${memoryFile}` })).isError, true);
	const xargsRead = await extractorBash.execute("xargs-read", { command: "printf 'source.txt\\n' | xargs head -n 1" });
	assert.notEqual(xargsRead.isError, true);
	assert.match(xargsRead.content[0]?.type === "text" ? xargsRead.content[0].text : "", /project value/);
	assert.notEqual(
		(await extractorBash.execute("xargs-outside", { command: `printf '' | xargs head -n 1 ${outsideFile}` })).isError,
		true,
	);
	assert.equal(await readFile(memoryFile, "utf8"), "memory value\n");

	const dream = toolMap(
		createChildTools({
			mode: "dream",
			memoryDir,
			projectRoot,
			cwd: projectRoot,
			locksDir,
			scratchDir,
			isCurrentGeneration: () => true,
			touchedPaths: new Set(),
		}),
	);
	const dreamRead = await dream.get("bash")!.execute("read-project", { command: `head -n 1 ${projectFile}` });
	assert.notEqual(dreamRead.isError, true);
	assert.match(dreamRead.content[0]?.type === "text" ? dreamRead.content[0].text : "", /project value/);
});

test("restricted Bash rejects command remapping before executing it", async (t) => {
	const { memoryDir, projectRoot, locksDir } = await createToolWorkspace(t, "pi-memory-bash-command-mapping-");
	const target = join(projectRoot, "keep.md");
	await writeFile(target, "keep this project file\n");
	for (const mode of ["extractor", "dream"] as const) {
		const tools = toolMap(
			createChildTools({
				mode,
				memoryDir,
				projectRoot,
				cwd: projectRoot,
				locksDir,
				isCurrentGeneration: () => true,
				touchedPaths: new Set(),
			}),
		);
		const result = await tools
			.get("bash")!
			.execute("command-mapping", { command: `BASH_CMDS[cat]=/bin/rm; cat '${target}'` });
		assert.equal(result.isError, true);
		assert.equal(await readFile(target, "utf8"), "keep this project file\n");
	}
});

test("reads can follow symlinks while writes stay contained and rm needs no read baseline", async (t) => {
	const { root, memoryDir, projectRoot, locksDir } = await createToolWorkspace(t, "pi-memory-native-delete-");
	const outside = join(root, "outside.md");
	const linked = join(memoryDir, "linked.md");
	await writeFile(outside, "outside\n");
	await symlink(outside, linked);
	const tools = toolMap(
		createChildTools({
			mode: "extractor",
			memoryDir,
			projectRoot,
			cwd: projectRoot,
			locksDir,
			isCurrentGeneration: () => true,
			touchedPaths: new Set(),
		}),
	);
	assert.notEqual((await tools.get("read")!.execute("linked", { path: linked })).isError, true);
	assert.equal((await tools.get("write")!.execute("linked-write", { path: linked, content: "x" })).isError, true);

	const target = join(memoryDir, "delete.md");
	await writeFile(target, "delete me\n");
	const bash = tools.get("bash")!;
	assert.notEqual((await bash.execute("unread", { command: `rm --force ${target}` })).isError, true);
	await writeFile(target, "read version\n");
	await tools.get("read")!.execute("read", { path: target });
	await writeFile(target, "changed\n");
	assert.notEqual((await bash.execute("stale", { command: `rm -f -- ${target}` })).isError, true);
	await assert.rejects(readFile(target), (error: NodeJS.ErrnoException) => error.code === "ENOENT");

	for (const protectedName of ["agents", ".git"]) {
		const protectedDir = join(memoryDir, protectedName);
		const protectedFile = join(protectedDir, "protected.md");
		await mkdir(protectedDir);
		await writeFile(protectedFile, "protected\n");
		await tools.get("read")!.execute(`read-${protectedName}`, { path: protectedFile });
		assert.equal((await bash.execute(`delete-${protectedName}`, { command: `rm ${protectedFile}` })).isError, true);
		assert.equal(await readFile(protectedFile, "utf8"), "protected\n");
	}
	assert.equal(
		(await bash.execute("long-force", { command: `rm --force ${join(memoryDir, "agents", "protected.md")}` })).isError,
		true,
	);
});
