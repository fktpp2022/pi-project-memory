import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";
import { promisify } from "node:util";
import {
	containsVcsMetadataSegment,
	initializeProjectPaths,
	resolveProjectPaths,
	sanitizeProjectKey,
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
