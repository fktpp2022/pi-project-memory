import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, win32 } from "node:path";
import test, { after, before } from "node:test";
import { promisify } from "node:util";
import {
	assertBashCwdBudget,
	assertContainedMarkdown,
	assertLocalFixedMemoryRoot,
	assertMemoryFilePathBudget,
	assertMemoryPathBudget,
	containsVcsMetadataSegment,
	initializeProjectPaths,
	isContainedPath,
	isMarkdownPath,
	normalizePathInput,
	resolveProjectPaths,
	sanitizeProjectKey,
	WINDOWS_FILE_PATH_BUDGET,
	WINDOWS_MEMORY_PATH_BUDGET,
} from "../src/paths.ts";
import { createTempDirectory, removeTempDirectory, shellPath, skipOnWindows } from "./helpers.ts";

const execFileAsync = promisify(execFile);
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
let isolatedAgentDir: string;

before(async () => {
	isolatedAgentDir = await mkdtemp(join(tmpdir(), "pi-memory-path-tests-agent-"));
	process.env.PI_CODING_AGENT_DIR = isolatedAgentDir;
});

after(async () => {
	if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
	await removeTempDirectory(isolatedAgentDir);
});

test("VCS metadata detection uses exact path segments", () => {
	for (const path of [".git/config", "nested/.hg/store", "a/.SVN/entries", ".bzr/x", ".jj/x", ".sl/x"])
		assert.equal(containsVcsMetadataSegment(path), true, path);
	for (const path of [".github/workflows/test.yml", "git-notes.md", "target.svn.md", "nested/git/file"])
		assert.equal(containsVcsMetadataSegment(path), false, path);
});

test("autoMemoryDirectory accepts safe paths and falls back for invalid overrides", async (t) => {
	const root = await createTempDirectory(t, "pi-memory-paths-");
	const override = join(root, "custom-memory");
	const paths = await resolveProjectPaths(root, override);
	assert.ok(paths.namespaceDir?.startsWith(join(isolatedAgentDir, "project-memory", "projects")));
	assert.equal(paths.memoryDir, override);
	for (const invalid of [
		"relative-memory",
		"/",
		"\0bad",
		"~/",
		"~/.",
		"~/..",
		"~/../escape",
		join(root, ".git", "memory"),
	]) {
		const fallback = await resolveProjectPaths(root, invalid);
		assert.notEqual(fallback.memoryDir, invalid);
		assert.match(fallback.memoryDir, /project-memory.*projects.*memory/);
	}
});

test("default and explicitly equivalent memory roots share coordination paths", async (t) => {
	const root = await createTempDirectory(t, "pi-memory-default-coordination-");
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = join(root, "agent");
	t.after(() => {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	});
	const project = join(root, "project");
	await mkdir(project);
	const defaults = await resolveProjectPaths(project);
	const explicitBeforeCreation = await resolveProjectPaths(project, defaults.memoryDir);
	await initializeProjectPaths(defaults);
	const explicitAfterCreation = await resolveProjectPaths(project, defaults.memoryDir);
	const alias = join(root, "memory-alias");
	await symlink(defaults.memoryDir, alias);
	const throughAlias = await resolveProjectPaths(project, alias);
	for (const paths of [explicitBeforeCreation, explicitAfterCreation, throughAlias]) {
		assert.equal(paths.locksDir, defaults.locksDir);
		assert.equal(paths.dreamStateFile, defaults.dreamStateFile);
	}
});

test("custom roots isolate state and share locks by canonical memory namespace", async (t) => {
	if (skipOnWindows(t, "unprivileged directory symlinks fall back to file links, so realpath fails")) return;
	const root = await createTempDirectory(t, "pi-memory-custom-root-");
	const [projectOne, projectTwo] = [join(root, "one"), join(root, "two")];
	await Promise.all([mkdir(projectOne), mkdir(projectTwo)]);
	const shared = join(root, "shared-memory");
	const first = await resolveProjectPaths(projectOne, shared);
	const second = await resolveProjectPaths(projectTwo, shared);
	assert.equal(first.memoryDir, shared);
	assert.equal(first.locksDir, second.locksDir);
	assert.notEqual(first.stateFile, second.stateFile);
	const isolated = await resolveProjectPaths(projectTwo, join(root, "other-memory"));
	assert.notEqual(first.locksDir, isolated.locksDir);
	assert.notEqual(first.stateFile, isolated.stateFile);

	const alias = join(root, "shared-alias");
	await symlink(shared, alias);
	await mkdir(shared);
	const throughAlias = await resolveProjectPaths(projectTwo, alias);
	assert.equal(first.locksDir, throughAlias.locksDir);
	assert.equal(throughAlias.memoryDir, await realpath(shared));
});

test("namespace reservation rejects a pre-existing symlink before writing a marker", async (t) => {
	const root = await createTempDirectory(t, "pi-memory-namespace-symlink-");
	const agentDir = join(root, "agent");
	const project = join(root, "project");
	const target = join(root, "target");
	await Promise.all([
		mkdir(project),
		mkdir(target),
		mkdir(join(agentDir, "project-memory", "projects"), { recursive: true }),
	]);
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	t.after(() => {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	});
	const projectRoot = await realpath(project);
	await symlink(target, join(agentDir, "project-memory", "projects", sanitizeProjectKey(projectRoot)));
	await assert.rejects(resolveProjectPaths(project), /namespace must be a real directory/);
	await assert.rejects(
		readFile(join(target, ".project-root")),
		(error: NodeJS.ErrnoException) => error.code === "ENOENT",
	);
});

test("concurrent namespace reservations converge", async (t) => {
	const root = await createTempDirectory(t, "pi-memory-namespace-concurrent-");
	const agentDir = join(root, "agent");
	const project = join(root, "project");
	await mkdir(project);
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	t.after(() => {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	});
	const resolved = await Promise.all(Array.from({ length: 32 }, () => resolveProjectPaths(project)));
	assert.equal(new Set(resolved.map((paths) => paths.baseDir)).size, 1);
	const marker = join(resolved[0]!.namespaceDir!, ".project-root");
	assert.equal((await readFile(marker, "utf8")).trim(), await realpath(project));
});

test("default namespaces do not collide when sanitized project keys do", async (t) => {
	const root = await createTempDirectory(t, "pi-memory-key-collision-");
	const [dash, underscore] = [join(root, "a-b"), join(root, "a_b")];
	await Promise.all([mkdir(dash), mkdir(underscore)]);
	const [left, right] = await Promise.all([resolveProjectPaths(dash), resolveProjectPaths(underscore)]);
	await Promise.all([initializeProjectPaths(left), initializeProjectPaths(right)]);
	assert.equal(left.projectKey, right.projectKey);
	assert.notEqual(left.baseDir, right.baseDir);
	assert.notEqual(left.memoryDir, right.memoryDir);

	const shared = join(root, "shared-memory");
	const [customLeft, customRight] = await Promise.all([
		resolveProjectPaths(dash, shared),
		resolveProjectPaths(underscore, shared),
	]);
	await Promise.all([initializeProjectPaths(customLeft), initializeProjectPaths(customRight)]);
	assert.equal(customLeft.locksDir, customRight.locksDir);
	assert.notEqual(customLeft.stateFile, customRight.stateFile);
	assert.equal(customLeft.dreamStateFile, customRight.dreamStateFile);
});

test("linked worktrees use the common checkout as the Claude-compatible root", async (t) => {
	if (skipOnWindows(t, "the fake git executable is a POSIX shebang script run through /bin/sh")) return;
	const root = await createTempDirectory(t, "pi-memory-worktree-");
	const main = join(root, "main");
	const linked = join(root, "linked");
	await mkdir(main);
	await execFileAsync("git", ["-C", main, "init"]);
	await execFileAsync("git", ["-C", main, "config", "user.email", "memory@example.invalid"]);
	await execFileAsync("git", ["-C", main, "config", "user.name", "Memory Test"]);
	await execFileAsync("git", ["-C", main, "commit", "--allow-empty", "-m", "initial"]);
	await execFileAsync("git", ["-C", main, "worktree", "add", linked, "-b", "linked-test"]);
	const fakeBin = join(root, "fake-bin");
	const fakeGit = join(fakeBin, "git");
	const marker = join(root, "fake-git-ran");
	const realGit = (await execFileAsync(shellPath, ["-c", "command -v git"])).stdout.trim();
	await mkdir(fakeBin);
	await writeFile(
		fakeGit,
		`#!${shellPath}\necho ran > ${JSON.stringify(marker)}\nexec ${JSON.stringify(realGit)} "$@"\n`,
	);
	await chmod(fakeGit, 0o700);
	const previousPath = process.env.PATH;
	process.env.PATH = fakeBin;
	let mainPaths: Awaited<ReturnType<typeof resolveProjectPaths>>;
	let linkedPaths: Awaited<ReturnType<typeof resolveProjectPaths>>;
	try {
		mainPaths = await resolveProjectPaths(main);
		linkedPaths = await resolveProjectPaths(linked);
	} finally {
		if (previousPath === undefined) delete process.env.PATH;
		else process.env.PATH = previousPath;
	}
	assert.equal(await readFile(marker, "utf8"), "ran\n");
	assert.equal(linkedPaths.projectRoot, mainPaths.projectRoot);
	assert.equal(linkedPaths.baseDir, mainPaths.baseDir);
});

test("project path initialization keeps existing permissions and accepts a symlink memory root", async (t) => {
	if (skipOnWindows(t, "Windows does not preserve POSIX mode bits such as 0o777")) return;
	const root = await createTempDirectory(t, "pi-memory-symlink-root-");
	const target = join(root, "target");
	const memoryDir = join(root, "memory");
	const locksDir = join(root, "locks");
	await mkdir(target);
	await mkdir(locksDir, { mode: 0o777 });
	await chmod(locksDir, 0o777);
	const secureMemory = join(root, "secure-memory");
	await mkdir(secureMemory, { mode: 0o777 });
	await chmod(secureMemory, 0o777);
	await initializeProjectPaths({
		projectRoot: root,
		projectKey: "secure",
		baseDir: root,
		memoryDir: secureMemory,
		stateFile: join(root, "secure-state.json"),
		locksDir,
	});
	assert.equal((await stat(secureMemory)).mode & 0o777, 0o777);
	assert.equal((await stat(locksDir)).mode & 0o777, 0o777);
	await rm(locksDir, { recursive: true });
	await symlink(target, memoryDir);
	await initializeProjectPaths({
		projectRoot: root,
		projectKey: "test",
		baseDir: root,
		memoryDir,
		stateFile: join(root, "state.json"),
		locksDir,
	});
	await writeFile(join(memoryDir, "fact.md"), "linked memory");
	assert.equal(await readFile(join(target, "fact.md"), "utf8"), "linked memory");
});

test("normalizePathInput maps every accepted Windows form to one canonical drive path", () => {
	const root = "C:\\pi-windows-path-fixture\\memory";
	const cases: [string, string][] = [
		["C:\\pi-windows-path-fixture\\memory\\a.md", `${root}\\a.md`],
		["C:/pi-windows-path-fixture/memory/a.md", `${root}\\a.md`],
		["/c/pi-windows-path-fixture/memory/a.md", `${root}\\a.md`],
		["/d/pi-windows-path-fixture/memory/a.md", "D:\\pi-windows-path-fixture\\memory\\a.md"],
		["/mnt/c/pi-windows-path-fixture/memory/a.md", `${root}\\a.md`],
		["/cygdrive/c/pi-windows-path-fixture/memory/a.md", `${root}\\a.md`],
		["\\\\?\\C:\\pi-windows-path-fixture\\memory\\a.md", `${root}\\a.md`],
		["\\\\?\\UNC\\server\\share\\a.md", "\\\\server\\share\\a.md"],
	];
	for (const [input, expected] of cases)
		assert.equal(normalizePathInput("D:\\project", input, "win32"), expected, input);
	for (const input of ["~/pi-windows-path-fixture/a.md", "~\\pi-windows-path-fixture\\a.md"]) {
		const expected = win32.join(homedir(), "pi-windows-path-fixture", "a.md");
		assert.equal(normalizePathInput("D:\\project", input, "win32"), expected, input);
	}
	assert.equal(normalizePathInput("D:\\project", "~", "win32"), normalizePathInput("D:\\project", homedir(), "win32"));
});

test("normalizePathInput rejects drive-relative, variable, and stream operands", () => {
	for (const [input, message] of [
		["C:pi-windows-path-fixture\\a.md", /drive-relative/i],
		["C:", /drive-relative/i],
		["%USERPROFILE%\\pi-windows-path-fixture\\a.md", /variable/i],
		["C:\\mem\\notes.md:stream.md", /data streams/i],
		["C:\\mem\\a.md::$DATA", /data streams/i],
	] as const)
		assert.throws(() => normalizePathInput("C:\\project", input, "win32"), message, input);
});

test("normalizePathInput is a no-op for canonical POSIX paths", () => {
	for (const path of ["/tmp/memory/a.md", "/tmp/memory", "/"])
		assert.equal(normalizePathInput("/tmp/memory", path, "linux"), path);
	assert.equal(normalizePathInput("/tmp/memory", "topics/a.md", "linux"), "/tmp/memory/topics/a.md");
	assert.equal(normalizePathInput("/tmp/memory", "a.md", "linux"), "/tmp/memory/a.md");
});

test("isContainedPath case-folds Windows paths and rejects sibling prefixes", () => {
	assert.equal(isContainedPath("C:\\memory", "c:\\MEMORY\\topics\\a.md", "win32"), true);
	assert.equal(isContainedPath("C:\\memory", "C:/memory/topics/a.md", "win32"), true);
	assert.equal(isContainedPath("C:\\memory", "C:\\memory", "win32"), true);
	assert.equal(isContainedPath("C:\\memory", "C:\\memory-evil\\a.md", "win32"), false);
	assert.equal(isContainedPath("C:\\memory", "D:\\memory\\a.md", "win32"), false);
	assert.equal(isContainedPath("/memory", "/memory/topics/a.md", "linux"), true);
	assert.equal(isContainedPath("/memory", "/memory-evil/a.md", "linux"), false);
});

test("the containment primitive stays lexical and case-folds on Windows", () => {
	assert.equal(isContainedPath("/memory", "/memory/topic.md", "linux"), true);
	assert.equal(isContainedPath("/memory", "/memory-evil/topic.md", "linux"), false);
	assert.equal(isContainedPath("C:\\memory", "C:\\memory\\topic.md", "win32"), true);
	assert.equal(isContainedPath("C:\\memory", "c:\\MEMORY\\topic.md", "win32"), true);
	assert.equal(isContainedPath("C:\\memory", "C:\\memory-evil\\topic.md", "win32"), false);
	// The comparison stays lexical; write and delete callers resolve links with
	// realpath before consulting it, while reads may follow links like Claude.
	assert.equal(isContainedPath("C:\\memory", "C:\\memory\\link\\secret.md", "win32"), true);
});

test("assertContainedMarkdown accepts FOO.MD on Windows and rejects ADS", () => {
	assert.equal(assertContainedMarkdown("C:\\memory", "C:\\memory\\FOO.MD", "win32"), "C:\\memory\\FOO.MD");
	assert.equal(assertContainedMarkdown("/memory", "/memory/topic.md", "linux"), "/memory/topic.md");
	assert.throws(() => assertContainedMarkdown("/memory", "/memory/FOO.MD", "linux"), /\.md/);
	assert.throws(() => assertContainedMarkdown("C:\\memory", "C:\\memory\\notes.md:stream.md", "win32"), /data streams/);
	assert.throws(() => assertContainedMarkdown("C:\\memory", "C:\\memory-evil\\a.md", "win32"), /escapes/);
});

test("isMarkdownPath matches the index and topics case-insensitively on Windows", () => {
	assert.equal(isMarkdownPath("FOO.MD", "win32"), true);
	assert.equal(isMarkdownPath("MEMORY.MD", "win32"), true);
	assert.equal(isMarkdownPath("FOO.MD", "linux"), false);
	assert.equal(isMarkdownPath("foo.md", "linux"), true);
});

test("the Windows memory path budget is 241 characters and POSIX is unbounded", () => {
	const within = `C:\\${"a".repeat(WINDOWS_MEMORY_PATH_BUDGET - 3)}`;
	assert.equal(within.length, WINDOWS_MEMORY_PATH_BUDGET);
	assert.doesNotThrow(() => assertMemoryPathBudget(within, "win32"));
	const over = `${within}a`;
	assert.throws(() => assertMemoryPathBudget(over, "win32"), /budget/);
	assert.throws(() => assertMemoryPathBudget(over, "win32"), new RegExp(over.replace(/\\/g, "\\\\")));
	assert.doesNotThrow(() => assertMemoryPathBudget(over, "linux"));
	const longFile = `C:\\memory\\${"b".repeat(WINDOWS_FILE_PATH_BUDGET - 12)}.md`;
	assert.equal(longFile.length, WINDOWS_FILE_PATH_BUDGET + 1);
	assert.throws(() => assertMemoryFilePathBudget(longFile, "win32"), /budget/);
	assert.doesNotThrow(() => assertMemoryFilePathBudget(longFile, "linux"));
	assert.throws(() => assertBashCwdBudget(longFile, "win32"), /258/);
	assert.doesNotThrow(() => assertBashCwdBudget(longFile, "linux"));
});

test("startup enforces the Windows memory path budget on the canonical root", async (t) => {
	const root = await createTempDirectory(t, "pi-memory-budget-");
	const longMemory = join(root, "m".repeat(220));
	const paths = {
		projectRoot: root,
		projectKey: "budget",
		baseDir: join(root, "state"),
		memoryDir: longMemory,
		stateFile: join(root, "state.json"),
		locksDir: join(root, "locks"),
	};
	if (process.platform === "win32") {
		await assert.rejects(initializeProjectPaths(paths), (error: Error) => {
			assert.match(error.message, /budget/);
			assert.ok(error.message.includes(longMemory));
			return true;
		});
	} else await initializeProjectPaths(paths);
});

test("an existing legacy namespace is adopted instead of migrated", async (t) => {
	const root = await createTempDirectory(t, "pi-memory-legacy-namespace-");
	const agentDir = join(root, "agent");
	const project = join(root, "project");
	const alias = join(root, "project-alias");
	await Promise.all([mkdir(project), mkdir(agentDir)]);
	await symlink(project, alias, process.platform === "win32" ? "junction" : "dir");
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	t.after(() => {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	});
	const projectRoot = await realpath(project);
	const canonicalKey = sanitizeProjectKey(projectRoot);
	const legacyKey = sanitizeProjectKey(alias);
	assert.notEqual(canonicalKey, legacyKey);
	const projectsRoot = join(agentDir, "project-memory", "projects");
	const legacyDir = join(projectsRoot, legacyKey);
	await mkdir(legacyDir, { recursive: true });
	await writeFile(join(legacyDir, ".project-root"), `${projectRoot}\n`);
	const adopted = await resolveProjectPaths(alias);
	assert.equal(adopted.projectKey, legacyKey);
	assert.equal(adopted.namespaceDir, legacyDir);
	await assert.rejects(access(join(projectsRoot, canonicalKey)), { code: "ENOENT" });

	const canonicalDir = join(projectsRoot, canonicalKey);
	await mkdir(canonicalDir);
	await writeFile(join(canonicalDir, ".project-root"), `${projectRoot}\n`);
	const preferred = await resolveProjectPaths(alias);
	assert.equal(preferred.projectKey, canonicalKey);
	assert.equal(preferred.namespaceDir, canonicalDir);
	// Remove the junction before the recursive temp-directory teardown.
	await rm(alias, { force: true });
});

test("the memory root policy rejects UNC and non-fixed drives at startup", async () => {
	await assert.rejects(
		assertLocalFixedMemoryRoot("\\\\server\\share\\memory", "win32"),
		/memory root is not a local fixed drive/,
	);
	await assert.doesNotThrow(() => assertLocalFixedMemoryRoot("C:\\memory", "win32"));
	await assert.doesNotThrow(() => assertLocalFixedMemoryRoot("/memory", "linux"));
});
