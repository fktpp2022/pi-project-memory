import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, link, mkdir, readdir, readFile, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
	acquireLock,
	atomicWrite,
	atomicWriteIfBaseline,
	backfillIndex,
	baseline,
	compareAndSwapLastDreamAt,
	INDEX_CHAR_CAP,
	INDEX_LINE_CAP,
	listOtherSessionIds,
	memoryPathFromToolInput,
	readIndex,
	readRegularFileNoFollow,
	readState,
	recallTopic,
	scanTopics,
	snapshotMarkdown,
	topicCatalog,
	truncateIndex,
} from "../src/store.ts";
import { createTempDirectory, skipOnWindows } from "./helpers.ts";

test("memory tool paths follow native tilde, prefix, URL, and space normalization", () => {
	const memoryDir = join(homedir(), ".pi", "memory");
	const target = join(memoryDir, "topic name.md");
	for (const path of [
		"~/.pi/memory/topic name.md",
		"@~/.pi/memory/topic name.md",
		"~/.pi/memory/topic\u202Fname.md",
		`file://${target.replace(" ", "%20")}`,
		target,
	]) {
		assert.equal(memoryPathFromToolInput(memoryDir, "/other", { path }), target);
	}
	assert.equal(memoryPathFromToolInput(memoryDir, "/other", { file_path: "~/.pi/memory/topic name.md" }), target);
	assert.equal(memoryPathFromToolInput(memoryDir, "/other", { path: "~/.pi/memory/../outside.md" }), null);
});

test("truncateIndex matches Claude's line and UTF-16 code-unit window", () => {
	const byLines = truncateIndex(Array.from({ length: 250 }, (_, i) => `- item ${i}`).join("\n"));
	assert.match(byLines, /WARNING: MEMORY\.md was truncated/);
	assert.ok(byLines.split("\n").slice(0, INDEX_LINE_CAP).length <= INDEX_LINE_CAP);

	const byCharacters = truncateIndex("汉".repeat(INDEX_CHAR_CAP + 1));
	assert.match(byCharacters, /WARNING: MEMORY\.md was truncated/);
	const visible = byCharacters.split("\n\n> WARNING")[0]!;
	assert.equal(visible.length, INDEX_CHAR_CAP);
	assert.ok(Buffer.byteLength(visible, "utf8") > INDEX_CHAR_CAP);
});

test("topicCatalog matches Claude's selector catalog format", () => {
	const catalog = topicCatalog([
		{
			filename: "fact.md",
			filePath: "/memory/fact.md",
			description: "useful fact",
			type: "project",
			mtimeMs: Date.parse("2026-01-02T03:04:05.000Z"),
			modifiedMs: 0,
			sizeBytes: 10,
		},
	]);
	assert.equal(catalog, "- [project] fact.md (2026-01-02T03:04:05.000Z): useful fact");
});

test("session counting follows Claude's mtime and session-id index semantics", async (t) => {
	const root = await createTempDirectory(t, "pi-memory-sessions-");
	const project = join(root, "project");
	const otherProject = join(root, "other-project");
	await Promise.all([mkdir(project), mkdir(otherProject)]);
	const one = "11111111-1111-4111-8111-111111111111";
	const current = "22222222-2222-4222-8222-222222222222";
	const header = (id: string, cwd = project) =>
		`${JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-01-01T00:00:00.000Z", cwd })}\n`;
	await writeFile(join(root, "one.jsonl"), header(one));
	await writeFile(join(root, "one-copy.jsonl"), header(one));
	await writeFile(join(root, "current.jsonl"), header(current));
	await writeFile(join(root, "custom.jsonl"), header("safe.custom-id_2"));
	await writeFile(join(root, "invalid.jsonl"), header("unsafe id\nignored"));
	await writeFile(join(root, "other-project.jsonl"), header("33333333-3333-4333-8333-333333333333", otherProject));
	assert.deepEqual(
		new Set(await listOtherSessionIds(root, join(root, "current.jsonl"), current, 0)),
		new Set([one, "safe.custom-id_2", "33333333-3333-4333-8333-333333333333"]),
	);
	assert.deepEqual(
		new Set(await listOtherSessionIds(root, join(root, "current.jsonl"), current, 0, project)),
		new Set([one, "safe.custom-id_2"]),
	);
});

test("readIndex conditionally backfills a missing index without replacing a concurrent writer", async (t) => {
	const root = await createTempDirectory(t, "pi-memory-missing-index-");
	await mkdir(join(root, "nested"));
	await writeFile(
		join(root, "nested", "fact.md"),
		"---\nname: useful-fact\ndescription: a useful project fact\nmetadata:\n  type: project\n---\n\nFact.\n",
	);
	const concurrent = await Promise.all(Array.from({ length: 20 }, () => readIndex(root)));
	assert.deepEqual(new Set(concurrent), new Set(["- [fact](nested/fact.md) — a useful project fact"]));
	await writeFile(join(root, "MEMORY.md"), "hand-written\n");
	assert.equal(await backfillIndex(root), false);
	assert.equal(await readIndex(root), "hand-written");

	const empty = await createTempDirectory(t, "pi-memory-empty-index-");
	assert.equal(await readIndex(empty), "");
	await assert.rejects(stat(join(empty, "MEMORY.md")), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
});

test("snapshotMarkdown reuses unchanged hashes and detects content changes with restored mtime", async (t) => {
	const root = await createTempDirectory(t, "pi-memory-snapshot-cache-");
	const file = join(root, "fact.md");
	await writeFile(file, "first\n");
	const first = await snapshotMarkdown(root);
	const originalMtime = (await stat(file)).mtime;
	const cached = await snapshotMarkdown(root, first);
	assert.equal(cached.get("fact.md"), first.get("fact.md"));
	await writeFile(file, "other\n");
	await utimes(file, originalMtime, originalMtime);
	const changed = await snapshotMarkdown(root, cached);
	assert.notEqual(changed.get("fact.md")?.hash, first.get("fact.md")?.hash);
});

test("topic scans and backfill retain newest topics under a low file-descriptor limit", async (t) => {
	if (skipOnWindows(t, "bash ulimit and file-descriptor accounting are POSIX-only")) return;
	const root = await createTempDirectory(t, "pi-memory-scan-limit-");
	for (let index = 0; index < 300; index++) {
		const path = join(root, `topic-${index}.md`);
		await writeFile(path, `Fact ${index}\n`);
		const modified = new Date(1_700_000_000_000 + index * 1000);
		await utimes(path, modified, modified);
	}
	const { stdout } = await promisify(execFile)(
		"bash",
		[
			"-c",
			'ulimit -n 128\nexec "$@"',
			"scan-worker",
			process.execPath,
			"--import=tsx",
			fileURLToPath(new URL("./fixtures/scan-worker.ts", import.meta.url)),
			root,
		],
		{ timeout: 30_000 },
	);
	assert.equal(stdout.trim(), "scan and backfill passed");
});

test("topic scans and backfill omit unreadable files and keep valid topics", async (t) => {
	if (skipOnWindows(t, "chmod 000 does not make files unreadable on Windows")) return;
	if (process.getuid?.() === 0) return t.skip("root can read files without permission");
	const root = await createTempDirectory(t, "pi-memory-scan-read-error-");
	const path = join(root, "unreadable.md");
	await writeFile(path, "Unreadable fact\n");
	await writeFile(join(root, "valid.md"), "Valid fact\n");
	await chmod(path, 0);
	try {
		assert.deepEqual(
			(await scanTopics(root)).map((topic) => topic.filename),
			["valid.md"],
		);
		assert.equal(await backfillIndex(root), true);
		const index = await readFile(join(root, "MEMORY.md"), "utf8");
		assert.match(index, /valid\.md/);
		assert.doesNotMatch(index, /unreadable\.md/);
	} finally {
		await chmod(path, 0o600);
	}
});

test("topic scans return no catalog when the memory directory cannot be listed", async (t) => {
	if (skipOnWindows(t, "chmod 000 does not make directories unlistable on Windows")) return;
	if (process.getuid?.() === 0) return t.skip("root can list directories without permission");
	const root = await createTempDirectory(t, "pi-memory-scan-list-error-");
	await writeFile(join(root, "fact.md"), "Fact\n");
	await chmod(root, 0);
	try {
		assert.deepEqual(await scanTopics(root), []);
	} finally {
		await chmod(root, 0o700);
	}
});

test("scanTopics reads frontmatter and recallTopic applies the 4096-byte cap", async (t) => {
	const root = await createTempDirectory(t, "pi-memory-store-");
	await mkdir(join(root, "nested"));
	await writeFile(join(root, "MEMORY.md"), "- [Fact](nested/fact.md) — useful\n");
	await writeFile(
		join(root, "nested", "fact.md"),
		`---\nname: fact\ndescription: useful fact\nmetadata:\n  type: project\n---\n\n${"x".repeat(5000)}`,
	);

	const topics = await scanTopics(root);
	assert.equal(topics.length, 1);
	assert.equal(topics[0]!.filename, "nested/fact.md");
	assert.equal(topics[0]!.type, "project");
	assert.equal(topics[0]!.description, "useful fact");

	const recalled = await recallTopic(topics[0]!);
	assert.equal(recalled.truncatedByBytes, true);
	assert.equal(recalled.content, "---\nname: fact\ndescription: useful fact\nmetadata:\n  type: project\n---\n");
});

test("topic recall keeps only complete UTF-8 lines within the byte window", async (t) => {
	const root = await createTempDirectory(t, "pi-memory-lines-");
	const filePath = join(root, "lines.md");
	await writeFile(filePath, `short\n${"汉".repeat(2000)}\nafter`);
	const info = await stat(filePath);
	const recalled = await recallTopic({
		filename: "lines.md",
		filePath,
		description: "",
		type: "unknown",
		mtimeMs: info.mtimeMs,
		modifiedMs: info.mtimeMs,
		sizeBytes: info.size,
	});
	assert.equal(recalled.content, "short");
	assert.equal(recalled.truncatedByBytes, true);
});

test("topic recall is bounded and never returns a partial multibyte or partial line", async (t) => {
	const root = await createTempDirectory(t, "pi-memory-bounded-read-");
	const filePath = join(root, "bounded.md");
	await writeFile(filePath, `kept\n${"汉".repeat(20_000_000)}\nnot-read`);
	const info = await stat(filePath);
	const recalled = await recallTopic({
		filename: "bounded.md",
		filePath,
		description: "",
		type: "unknown",
		mtimeMs: info.mtimeMs,
		modifiedMs: info.mtimeMs,
		sizeBytes: info.size,
	});
	assert.equal(recalled.content, "kept");
	assert.equal(recalled.truncatedByBytes, true);
});

test("scanTopics flattens legacy top-level metadata like Claude", async (t) => {
	const root = await createTempDirectory(t, "pi-memory-flat-frontmatter-");
	await writeFile(
		join(root, "flat.md"),
		"---\nname: flat\ndescription: flat metadata\ntype: feedback\nmodified: 2026-02-03T04:05:06.000Z\n---\n\nBody\n",
	);
	await writeFile(
		join(root, "precedence.md"),
		"---\ndescription: nested wins\ntype: user\nmetadata:\n  type: project\n---\n\nBody\n",
	);
	const topics = await scanTopics(root);
	const flat = topics.find((topic) => topic.filename === "flat.md");
	assert.equal(flat?.description, "flat metadata");
	assert.equal(flat?.type, "feedback");
	assert.equal(flat?.modifiedMs, Date.parse("2026-02-03T04:05:06.000Z"));
	assert.equal(topics.find((topic) => topic.filename === "precedence.md")?.type, "project");
});

test("scanTopics accepts CRLF frontmatter and uses a capped first-line description", async (t) => {
	const root = await createTempDirectory(t, "pi-memory-frontmatter-");
	await writeFile(join(root, "crlf.md"), "---\r\nmetadata:\r\n  type: feedback\r\n---\r\n\r\n# Plain heading\r\n");
	await writeFile(join(root, "plain.md"), `${"x".repeat(140)}\n`);
	const topics = await scanTopics(root);
	assert.equal(topics.find((topic) => topic.filename === "crlf.md")?.type, "feedback");
	assert.equal(topics.find((topic) => topic.filename === "crlf.md")?.description, "Plain heading");
	assert.equal(topics.find((topic) => topic.filename === "plain.md")?.description.length, 120);
});

test("readIndex omits a non-file index while direct reads still fail", async (t) => {
	const root = await createTempDirectory(t, "pi-memory-index-directory-");
	const index = join(root, "MEMORY.md");
	await mkdir(index);
	await writeFile(join(root, "topic.md"), "---\ndescription: topic\n---\nfact\n");
	await assert.rejects(readRegularFileNoFollow(index));
	assert.equal(await readIndex(root), "");
	assert.ok((await stat(index)).isDirectory());
});

test("readIndex follows local private memory symlinks", async (t) => {
	const root = await createTempDirectory(t, "pi-memory-index-");
	const outside = join(root, "outside.md");
	const memory = join(root, "memory");
	await mkdir(memory);
	await writeFile(outside, "secret");
	await symlink(outside, join(memory, "MEMORY.md"));
	assert.equal(await readIndex(memory), "secret");
});

test("atomic replacement of a hard-linked entry leaves the other name unchanged", async (t) => {
	if (skipOnWindows(t, "Windows reports 0o666 for every writable file, so 0600 mode assertions are POSIX-only")) return;
	const root = await createTempDirectory(t, "pi-memory-atomic-");
	const filePath = join(root, "fact.md");
	await chmod(root, 0o700);
	await atomicWrite(filePath, "durable\n");
	const info = await stat(filePath);
	assert.equal(info.mode & 0o777, 0o600);
	assert.equal(await readFile(filePath, "utf8"), "durable\n");
	const alias = join(root, "alias.md");
	try {
		await link(filePath, alias);
	} catch (error) {
		if (process.platform === "android" && ["EACCES", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? ""))
			return t.skip("Android policy prohibits hard links");
		throw error;
	}
	const expected = await baseline(filePath);
	await atomicWriteIfBaseline(filePath, expected, () => "updated\n");
	assert.equal(await readFile(filePath, "utf8"), "updated\n");
	assert.equal(await readFile(alias, "utf8"), "durable\n");
});

test("new memory files publish exclusively with private permissions and no staging files", async (t) => {
	if (skipOnWindows(t, "Windows reports 0o666 for every writable file, so 0600 mode assertions are POSIX-only")) return;
	const root = await createTempDirectory(t, "pi-memory-exclusive-create-");
	const filePath = join(root, "fact.md");
	const results = await Promise.allSettled([
		atomicWriteIfBaseline(filePath, null, () => "first\n"),
		atomicWriteIfBaseline(filePath, null, () => "second\n"),
	]);
	assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
	assert.equal(results.filter((result) => result.status === "rejected").length, 1);
	const content = await readFile(filePath, "utf8");
	assert.ok(content === "first\n" || content === "second\n");
	assert.equal((await stat(filePath)).mode & 0o777, 0o600);
	assert.deepEqual(await readdir(root), ["fact.md"]);
	await assert.rejects(
		atomicWriteIfBaseline(filePath, null, () => "overwrite\n"),
		/modified since it was read/,
	);
	assert.equal(await readFile(filePath, "utf8"), content);
	await atomicWriteIfBaseline(filePath, await baseline(filePath), () => "updated\n");
	assert.equal(await readFile(filePath, "utf8"), "updated\n");
});

test("atomicWriteIfBaseline rejects a changed file instead of losing the update", async (t) => {
	const root = await createTempDirectory(t, "pi-memory-cas-");
	const filePath = join(root, "fact.md");
	await writeFile(filePath, "old");
	const expected = await baseline(filePath);
	await writeFile(filePath, "newer");
	await utimes(filePath, new Date(), new Date(expected.mtimeMs + 1000));
	await assert.rejects(
		atomicWriteIfBaseline(filePath, expected, () => "stale"),
		/modified since it was read/,
	);
	assert.equal(await readFile(filePath, "utf8"), "newer");
});

test("atomicWriteIfBaseline validates before writing without a second staging check", async (t) => {
	const root = await createTempDirectory(t, "pi-memory-cas-staging-");
	const filePath = join(root, "fact.md");
	await writeFile(filePath, "old");
	const expected = await baseline(filePath);
	let guardCalls = 0;
	await atomicWriteIfBaseline(
		filePath,
		expected,
		() => "extension update",
		undefined,
		async () => {
			guardCalls++;
			if (guardCalls === 2) await writeFile(filePath, "external update");
		},
	);
	assert.equal(await readFile(filePath, "utf8"), "extension update");
});

test("shared dream cadence migrates legacy project state and is visible across projects", async (t) => {
	const root = await createTempDirectory(t, "pi-memory-shared-dream-");
	const shared = join(root, "shared", "state.json");
	await mkdir(dirname(shared), { recursive: true });
	const left = {
		projectRoot: root,
		projectKey: "left",
		baseDir: root,
		memoryDir: root,
		stateFile: join(root, "left-state.json"),
		dreamStateFile: shared,
		locksDir: join(root, "locks"),
	};
	const right = { ...left, projectKey: "right", stateFile: join(root, "right-state.json") };
	await writeFile(left.stateFile, JSON.stringify({ schemaVersion: 1, lastDreamAt: 100 }));
	assert.equal((await readState(left)).lastDreamAt, 100);
	assert.equal(await compareAndSwapLastDreamAt(left, 100, 200), true);
	assert.equal((await readState(right)).lastDreamAt, 200);
	assert.equal(await compareAndSwapLastDreamAt(right, 100, 300), false);
});

test("invalid dream state fails loudly and cannot be overwritten by CAS", async (t) => {
	const root = await createTempDirectory(t, "pi-memory-malformed-state-");
	const stateFile = join(root, "state.json");
	const paths = {
		projectRoot: root,
		projectKey: "test",
		baseDir: root,
		memoryDir: root,
		stateFile,
		locksDir: join(root, "locks"),
	};
	for (const malformed of [
		"{",
		"{}",
		"[]",
		'"text"',
		'{"lastDreamAt":"bad"}',
		'{"lastDreamAt":-1}',
		'{"schemaVersion":2,"lastDreamAt":1}',
	]) {
		await writeFile(stateFile, malformed);
		await assert.rejects(readState(paths), { message: `Invalid dream state at ${stateFile}` });
		await assert.rejects(compareAndSwapLastDreamAt(paths, 0, 456));
		assert.equal(await readFile(stateFile, "utf8"), malformed);
	}
	await writeFile(stateFile, JSON.stringify({ lastSuccessfulDreamAt: 123 }));
	assert.equal((await readState(paths)).lastDreamAt, 123);
});

test("dream timestamp rollback uses compare-and-swap semantics", async (t) => {
	const root = await createTempDirectory(t, "pi-memory-dream-cas-");
	const paths = {
		projectRoot: root,
		projectKey: "test",
		baseDir: root,
		memoryDir: root,
		stateFile: join(root, "state.json"),
		locksDir: join(root, "locks"),
	};
	assert.equal(await compareAndSwapLastDreamAt(paths, 0, 100), true);
	assert.equal(await compareAndSwapLastDreamAt(paths, 0, 50), false);
	assert.equal(await compareAndSwapLastDreamAt(paths, 100, 200), true);
	assert.equal(await compareAndSwapLastDreamAt(paths, 100, 0), false);
	assert.equal((await readState(paths)).lastDreamAt, 200);
});

test("lock acquisition rejects a symlinked lock directory", async (t) => {
	const root = await createTempDirectory(t, "pi-memory-lock-symlink-");
	const target = join(root, "target");
	const linkPath = join(root, "linked-locks");
	await mkdir(target);
	await symlink(target, linkPath);
	await assert.rejects(acquireLock(join(linkPath, "unsafe.lock"), 1_000), /must be a real directory/);
	await assert.rejects(stat(join(target, "unsafe.lock")), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
});

test("locks honor live owners, expose ownership loss, and release by token", async (t) => {
	const root = await createTempDirectory(t, "pi-memory-lock-");
	const lockFile = join(root, "writer.lock");
	const releaseFirst = await acquireLock(lockFile, 100);
	assert.ok(releaseFirst);
	const old = new Date(Date.now() - 10_000);
	await utimes(lockFile, old, old);
	assert.equal(await acquireLock(lockFile, 100), null);

	await rm(lockFile);
	const releaseSecond = await acquireLock(lockFile, 10_000);
	assert.ok(releaseSecond);
	await assert.rejects(releaseFirst.assertValid(), /ownership was lost/);
	assert.equal(releaseFirst.isValid(), false);
	await releaseFirst();
	assert.equal(await acquireLock(lockFile, 10_000), null);
	await releaseSecond();

	await writeFile(
		`${lockFile}.recover`,
		JSON.stringify({ pid: 2_147_483_647, token: "orphan", acquiredAt: Date.now() - 10_000 }),
	);
	const releaseRecovered = await acquireLock(lockFile, 100);
	assert.ok(releaseRecovered);
	await releaseRecovered();
});
