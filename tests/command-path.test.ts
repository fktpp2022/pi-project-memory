import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, symlink, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import test from "node:test";
import { createChildTools } from "../src/child-tools.ts";
import { createToolWorkspace, shellPath, skipOnWindows } from "./helpers.ts";

function quote(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

test("background Bash follows PATH order and relative entries", async (t) => {
	if (skipOnWindows(t, "POSIX-only fixture: fake commands are shebang scripts that rely on executable bits")) return;
	const env = await createToolWorkspace(t, "pi-memory-command-path-");
	const first = join(env.projectRoot, "first bin");
	const second = join(env.projectRoot, "second bin");
	const scratchDir = join(env.root, "scratch");
	await Promise.all([mkdir(first), mkdir(second), mkdir(scratchDir)]);
	const firstCommand = join(first, "head");
	const secondCommand = join(second, "head");
	await writeFile(firstCommand, `#!${shellPath}\nprintf FIRST\n`);
	await writeFile(secondCommand, `#!${shellPath}\nprintf SECOND\n`);
	await chmod(firstCommand, 0o777);
	await chmod(secondCommand, 0o755);
	await symlink(secondCommand, join(env.projectRoot, "head"));
	await writeFile(join(env.projectRoot, "source.md"), "source\n");
	const bash = createChildTools({
		...env,
		mode: "extractor",
		cwd: env.projectRoot,
		scratchDir,
		isCurrentGeneration: () => true,
		touchedPaths: new Set(),
	}).find((tool) => tool.name === "bash")!;
	const previousPath = process.env.PATH;
	t.after(() => {
		if (previousPath === undefined) delete process.env.PATH;
		else process.env.PATH = previousPath;
	});
	const readHead = async () => {
		const result = await bash.execute("head", { command: "head -n 1 source.md" });
		assert.notEqual(result.isError, true, JSON.stringify(result));
		return JSON.stringify(result.content);
	};
	process.env.PATH = ["first bin", "second bin", previousPath ?? "/usr/bin:/bin"].join(delimiter);
	assert.match(await readHead(), /FIRST/);
	await chmod(firstCommand, 0o644);
	assert.match(await readHead(), /SECOND/);
	process.env.PATH = `${delimiter}${previousPath ?? "/usr/bin:/bin"}`;
	assert.match(await readHead(), /SECOND/);
});

test("background tools use executables and their helpers from arbitrary host PATH directories", async (t) => {
	if (skipOnWindows(t, "POSIX-only fixture: helpers are executed through /bin/sh, which is unavailable")) return;
	const { root, memoryDir, projectRoot, locksDir } = await createToolWorkspace(t, "pi-memory-host-path-");
	const bin = join(projectRoot, "custom bin");
	const scratchDir = join(root, "scratch");
	await Promise.all([mkdir(bin), mkdir(scratchDir)]);
	const commands = new Map(
		["head", "grep", "fd", "rg"].map((name) => [
			name,
			execFileSync(shellPath, ["-c", `command -v ${name}`], { encoding: "utf8" }).trim(),
		]),
	);
	for (const [name, executable] of commands) {
		const target = join(bin, `${name}-target`);
		const script =
			name === "head"
				? `#!${shellPath}\nexec memory-test-helper "$@"\n`
				: `#!${shellPath}\nexec ${quote(executable)} "$@"\n`;
		await writeFile(target, script);
		await chmod(target, 0o777);
		await symlink(target, join(bin, name));
	}
	const helper = join(bin, "memory-test-helper");
	await writeFile(helper, `#!${shellPath}\nexec ${quote(commands.get("head")!)} "$@"\n`);
	await chmod(helper, 0o777);
	await writeFile(join(projectRoot, "source.md"), "HOST_PATH_MARKER\n");
	const previousPath = process.env.PATH;
	const hostPath = `${bin}${delimiter}${previousPath ?? "/usr/bin:/bin"}`;
	process.env.PATH = hostPath;
	t.after(() => {
		if (previousPath === undefined) delete process.env.PATH;
		else process.env.PATH = previousPath;
	});
	for (const mode of ["extractor", "dream"] as const) {
		const tools = new Map(
			createChildTools({
				mode,
				memoryDir,
				projectRoot,
				cwd: projectRoot,
				locksDir,
				scratchDir,
				isCurrentGeneration: () => true,
				touchedPaths: new Set(),
			}).map((tool) => [tool.name, tool]),
		);
		for (const [name, params, expected] of [
			["bash", { command: "head -n 1 source.md" }, /HOST_PATH_MARKER/],
			["bash", { command: "grep HOST_PATH_MARKER source.md" }, /HOST_PATH_MARKER/],
			["bash", { command: "printf 'source.md\\n' | xargs head -n 1" }, /HOST_PATH_MARKER/],
			["find", { pattern: "*.md" }, /source\.md/],
			["grep", { path: "source.md", pattern: "HOST_PATH_MARKER" }, /HOST_PATH_MARKER/],
		] as const) {
			const result = await tools.get(name)!.execute(name, params);
			assert.notEqual(result.isError, true, JSON.stringify(result));
			assert.match(JSON.stringify(result.content), expected);
		}
	}
	assert.equal(process.env.PATH, hostPath);
});
