import { createHash, randomUUID } from "node:crypto";
import { constants, type Dirent, type Stats } from "node:fs";
import {
	copyFile,
	link,
	lstat,
	mkdir,
	open,
	readdir,
	readFile,
	realpath,
	rename,
	rm,
	stat,
	utimes,
} from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import fg from "fast-glob";
import YAML from "yaml";
import {
	canonicalProjectRoot,
	containsVcsMetadataSegment,
	isContainedPath,
	isMarkdownPath,
	resolveToolPath,
	VCS_METADATA_DIRECTORIES,
} from "./paths.ts";
import { hasUnsafeMemoryText } from "./sanitize.ts";
import type { MemoryTopic, ProjectMemoryState, ProjectPaths, ReadBaseline, RecallItem } from "./types.ts";

export const INDEX_FILE = "MEMORY.md";
export const INDEX_LINE_CAP = 200;
// Claude Code names this as a byte budget in user-facing text, but 2.1.296
// enforces it with JavaScript string.length (UTF-16 code units).
export const INDEX_CHAR_CAP = 25_000;
export const TOPIC_LINE_CAP = 200;
export const TOPIC_BYTE_CAP = 4096;
export const TOPIC_SCAN_CAP = 200;
const TOPIC_SCAN_CONCURRENCY = 16;

const NO_FOLLOW_READ = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);

const DEFAULT_STATE: ProjectMemoryState = {
	schemaVersion: 1,
	lastDreamAt: 0,
};

export function sha256(content: string | Buffer): string {
	return createHash("sha256").update(content).digest("hex");
}

export function truncateIndex(raw: string): string {
	const normalized = raw.replace(/\r\n?/g, "\n").trim();
	const lines = normalized.split("\n");
	const originalLines = normalized === "" ? 0 : lines.length;
	const originalChars = normalized.length;
	if (originalLines <= INDEX_LINE_CAP && originalChars <= INDEX_CHAR_CAP) return normalized;

	let visible = lines.slice(0, INDEX_LINE_CAP).join("\n");
	if (visible.length > INDEX_CHAR_CAP) {
		const lastNewline = visible.lastIndexOf("\n", INDEX_CHAR_CAP);
		visible = visible.slice(0, lastNewline > 0 ? lastNewline : INDEX_CHAR_CAP);
	}
	return `${visible}\n\n> WARNING: MEMORY.md was truncated (${originalLines} lines, ${originalChars} characters). Keep the index below ${INDEX_LINE_CAP} lines and approximately 25KB.`;
}

export async function readRegularFileNoFollow(filePath: string): Promise<string> {
	const handle = await open(filePath, NO_FOLLOW_READ);
	try {
		const before = await handle.stat();
		if (!before.isFile()) throw new Error(`Not a regular file: ${filePath}`);
		const content = await handle.readFile({ encoding: "utf8" });
		const after = await handle.stat();
		if (before.mtimeMs !== after.mtimeMs || before.size !== after.size)
			throw new Error(`File changed while it was read: ${filePath}`);
		return content;
	} finally {
		await handle.close();
	}
}

/** The index name compares case-insensitively on Windows, matching NTFS. */
export function isIndexFilename(name: string, platform: NodeJS.Platform = process.platform): boolean {
	const base = basename(name);
	return platform === "win32" ? base.toLowerCase() === INDEX_FILE.toLowerCase() : base === INDEX_FILE;
}

/** Only the root index is reserved; a nested file with the same name stays a topic. */
function isMemoryIndexPath(relativePath: string, platform: NodeJS.Platform = process.platform): boolean {
	const normalized = relativePath.split(sep).join("/");
	if (normalized.includes("/")) return false;
	return platform === "win32" ? normalized.toLowerCase() === INDEX_FILE.toLowerCase() : normalized === INDEX_FILE;
}

function topicTitle(filename: string): string {
	const base = basename(filename);
	return process.platform === "win32" ? base.replace(/\.md$/i, "") : basename(base, ".md");
}

function indexableFilename(filename: string): boolean {
	const normalized = filename.split(sep).join("/");
	return !/[[\]()\n\r\u2028\u2029]/u.test(normalized) && !normalized.split("/").some((part) => part.startsWith("."));
}

function indexEntry(topic: MemoryTopic): string | null {
	const filename = topic.filename.split(sep).join("/");
	if (!indexableFilename(filename)) return null;
	const title = topicTitle(filename);
	const prefix = `- [${title}](${filename})`;
	const description = topic.description.replace(/\s+/g, " ").trim();
	const remaining = 150 - prefix.length - 3;
	return description && remaining > 1 ? `${prefix} — ${description.slice(0, remaining)}` : prefix;
}

export async function backfillIndex(memoryDir: string): Promise<boolean> {
	// Claude fills a missing index only when at least one safe topic can be
	// represented. Keep headroom for later maintenance, matching its 80% target.
	const topics = await scanTopicsInternal(memoryDir, Number.POSITIVE_INFINITY, indexableFilename);
	let content = "";
	let lines = 0;
	const lineCap = Math.floor(INDEX_LINE_CAP * 0.8);
	const charCap = Math.floor(INDEX_CHAR_CAP * 0.8);
	for (const topic of topics) {
		const entry = indexEntry(topic);
		if (!entry) continue;
		if (lines + 1 > lineCap || content.length + entry.length + 1 > charCap) break;
		content += `${entry}\n`;
		lines++;
	}
	if (!content) return false;
	return publishFile(join(await realpath(memoryDir), INDEX_FILE), content, undefined, true);
}

export async function readIndex(memoryDir: string): Promise<string> {
	// Optional prompt-index boundary, matching Claude's XNe/BJn loaders: an
	// unreadable index or failed backfill omits index context for this request.
	// Reads follow local private memory symlinks; lock readers remain no-follow.
	const indexPath = join(memoryDir, INDEX_FILE);
	try {
		return truncateIndex(await readFile(indexPath, "utf8"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") return "";
	}
	try {
		await backfillIndex(memoryDir);
		return truncateIndex(await readFile(indexPath, "utf8"));
	} catch {
		return "";
	}
}

function objectOrEmpty(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function parseFrontmatter(head: string): { metadata: Record<string, unknown>; body: string } {
	if (!head.startsWith("---\n")) return { metadata: {}, body: head };
	const closing = /\n---(?:\n|$)/.exec(head.slice(4));
	if (!closing) return { metadata: {}, body: head };
	const end = 4 + closing.index;
	const body = head.slice(end + closing[0].length).trimStart();
	try {
		const parsed = YAML.parse(head.slice(4, end)) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { metadata: {}, body };
		const raw = parsed as Record<string, unknown>;
		const nested = objectOrEmpty(raw.metadata);
		// Claude flattens non-standard top-level fields into metadata, with the
		// explicit metadata mapping taking precedence. This keeps older files
		// using top-level type/modified compatible with the current format.
		const flattened = Object.fromEntries(
			Object.entries(raw).filter(([key, value]) => !["name", "description", "metadata"].includes(key) && value != null),
		);
		return {
			metadata: { name: raw.name, description: raw.description, metadata: { ...flattened, ...nested } },
			body,
		};
	} catch {
		return { metadata: {}, body: head };
	}
}

function memoryType(type: unknown): MemoryTopic["type"] {
	return type === "user" || type === "feedback" || type === "project" || type === "reference" ? type : "unknown";
}

function descriptionFallback(body: string): string {
	const first = body
		.split("\n")
		.map((line) => line.trim())
		.find(Boolean);
	return (first?.replace(/^#{1,6}\s+/, "") ?? "").slice(0, 120);
}

const RESERVED_MEMORY_DIRECTORIES = new Set<string>(VCS_METADATA_DIRECTORIES);

async function scanTopicsInternal(
	memoryDir: string,
	limit: number,
	includeFilename: (filename: string) => boolean,
): Promise<MemoryTopic[]> {
	const relativePaths = await fg("**/*.md", {
		cwd: memoryDir,
		onlyFiles: true,
		followSymbolicLinks: true,
		dot: false,
		unique: true,
		caseSensitiveMatch: process.platform !== "win32",
	});
	const seen = new Set<string>();
	const filenames = relativePaths
		.filter(
			(path) =>
				!isMemoryIndexPath(path) &&
				includeFilename(path) &&
				!path.split("/").some((part) => RESERVED_MEMORY_DIRECTORIES.has(part.toLowerCase())),
		)
		.filter((path) => {
			// NTFS is case-insensitive; compare-canonical paths so a case-different
			// alias cannot appear twice in the catalog.
			const key = process.platform === "win32" ? resolve(memoryDir, path).toLowerCase() : path;
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		});
	const topics: MemoryTopic[] = [];
	for (let offset = 0; offset < filenames.length; offset += TOPIC_SCAN_CONCURRENCY) {
		// A failed topic head is omitted, matching Claude's partial catalog scan.
		const batch = await Promise.allSettled(
			filenames.slice(offset, offset + TOPIC_SCAN_CONCURRENCY).map(async (filename) => {
				const filePath = resolve(memoryDir, filename);
				if (!isContainedPath(memoryDir, filePath)) throw new Error("escaped memory path");
				const handle = await open(filePath, constants.O_RDONLY);
				try {
					const info = await handle.stat();
					if (!info.isFile()) throw new Error("not a regular file");
					const buffer = Buffer.alloc(65_536);
					const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
					const head = buffer
						.subarray(0, bytesRead)
						.toString("utf8")
						.replace(/^\uFEFF/, "")
						.replace(/\r\n?/g, "\n")
						.split("\n")
						.slice(0, 30)
						.join("\n");
					const { metadata, body } = parseFrontmatter(head);
					const nestedMetadata = objectOrEmpty(metadata.metadata);
					const modifiedValue = nestedMetadata.modified;
					const modifiedParsed = typeof modifiedValue === "string" ? Date.parse(modifiedValue) : Number.NaN;
					return {
						filename: filename.split(sep).join("/"),
						filePath,
						description:
							typeof metadata.description === "string" ? metadata.description.trim() : descriptionFallback(body),
						type: memoryType(nestedMetadata.type),
						mtimeMs: info.mtimeMs,
						modifiedMs: Number.isFinite(modifiedParsed) ? modifiedParsed : info.mtimeMs,
						sizeBytes: info.size,
					} satisfies MemoryTopic;
				} finally {
					await handle.close();
				}
			}),
		);
		topics.push(...batch.flatMap((result) => (result.status === "fulfilled" ? [result.value] : [])));
	}
	return topics.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, limit);
}

export async function scanTopics(memoryDir: string): Promise<MemoryTopic[]> {
	try {
		return await scanTopicsInternal(memoryDir, TOPIC_SCAN_CAP, () => true);
	} catch {
		// Recall and extraction can proceed without a catalog when listing fails.
		// Claude's public scanner also translates whole-scan failures to no topics.
		return [];
	}
}

export async function recallTopic(topic: MemoryTopic): Promise<RecallItem> {
	const handle = await open(topic.filePath, constants.O_RDONLY);
	try {
		const info = await handle.stat();
		if (!info.isFile()) throw new Error(`Not a regular file: ${topic.filePath}`);
		// One byte past the recall budget is enough to prove byte truncation. This
		// avoids loading an unbounded topic while retaining only complete UTF-8
		// lines, so a cut cannot silently corrupt the recalled text.
		const readLength = Math.min(info.size, TOPIC_BYTE_CAP + 1);
		const buffer = Buffer.alloc(readLength);
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
		let source = buffer.subarray(0, bytesRead);
		if (source.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))) source = source.subarray(3);
		const selected: string[] = [];
		let selectedBytes = 0;
		let cursor = 0;
		let truncatedByBytes = false;
		let truncatedByLines = false;
		while (cursor <= source.length) {
			const newline = source.indexOf(0x0a, cursor);
			const complete = newline >= 0 || bytesRead === info.size;
			if (!complete) {
				truncatedByBytes = true;
				break;
			}
			const end = newline >= 0 ? newline : source.length;
			let line = source.subarray(cursor, end);
			if (line.at(-1) === 0x0d) line = line.subarray(0, -1);
			if (selected.length >= TOPIC_LINE_CAP) {
				truncatedByLines = true;
				break;
			}
			const text = line.toString("utf8");
			const nextBytes = selectedBytes + (selected.length > 0 ? 1 : 0) + Buffer.byteLength(text);
			if (nextBytes > TOPIC_BYTE_CAP) {
				truncatedByBytes = true;
				break;
			}
			selected.push(text);
			selectedBytes = nextBytes;
			if (newline < 0) break;
			cursor = newline + 1;
		}
		if (!truncatedByBytes && bytesRead < info.size) truncatedByBytes = true;
		const visible = selected.join("\n");
		return {
			path: topic.filePath,
			filename: topic.filename,
			mtimeMs: topic.mtimeMs,
			content: visible,
			truncated: truncatedByLines || truncatedByBytes,
			truncatedByBytes,
			lineCount: visible === "" ? 0 : selected.length,
		};
	} finally {
		await handle.close();
	}
}

export function lintMemoryContent(
	filePath: string,
	content: string,
	existingMemoryPaths?: ReadonlySet<string>,
): string[] {
	const warnings: string[] = [];
	const size = Buffer.byteLength(content, "utf8");
	const lineCount = content.replace(/\r\n?/g, "\n").split("\n").length;
	if (hasUnsafeMemoryText(content))
		warnings.push(`${basename(filePath)} contains reserved prompt tags or unsafe invisible characters.`);
	if (isIndexFilename(filePath)) {
		if (content.length > INDEX_CHAR_CAP || lineCount > INDEX_LINE_CAP)
			warnings.push(
				`${INDEX_FILE} is ${content.length} characters / ${lineCount} lines, over the automatic context limit. Compact it below ${Math.floor(INDEX_CHAR_CAP * 0.7)} characters and ${Math.floor(INDEX_LINE_CAP * 0.7)} lines now; shorten hooks and remove stale pointers.`,
			);
		else if (content.length >= INDEX_CHAR_CAP * 0.8 || lineCount >= INDEX_LINE_CAP * 0.8)
			warnings.push(
				`${INDEX_FILE} is approaching its automatic context limit (${content.length} characters / ${lineCount} lines). Compact it toward ${Math.floor(INDEX_CHAR_CAP * 0.7)} characters and ${Math.floor(INDEX_LINE_CAP * 0.7)} lines now.`,
			);
		return warnings;
	}
	if (size > TOPIC_BYTE_CAP || lineCount > TOPIC_LINE_CAP) {
		warnings.push(
			`${basename(filePath)} is ${size} UTF-8 bytes / ${lineCount} lines, over the automatic recall limit. Future recall sees only the first ${TOPIC_BYTE_CAP} bytes or ${TOPIC_LINE_CAP} lines. Rewrite it below ${Math.floor(TOPIC_BYTE_CAP * 0.7)} bytes and ${Math.floor(TOPIC_LINE_CAP * 0.7)} lines now; split distinct facts into semantic topics rather than continuation files.`,
		);
	} else if (size >= TOPIC_BYTE_CAP * 0.8 || lineCount >= TOPIC_LINE_CAP * 0.8) {
		warnings.push(
			`${basename(filePath)} is approaching the automatic recall limit (${size} UTF-8 bytes / ${lineCount} lines). Compact it toward ${Math.floor(TOPIC_BYTE_CAP * 0.7)} bytes and ${Math.floor(TOPIC_LINE_CAP * 0.7)} lines now.`,
		);
	}
	const continuation = /^(.*\D)-(\d{1,2})\.md$/i.exec(basename(filePath));
	if (continuation && Number(continuation[2]) > 1 && existingMemoryPaths) {
		const relativePath =
			[...existingMemoryPaths].find((candidate) => candidate.endsWith(`/${basename(filePath)}`)) ?? basename(filePath);
		const parent = dirname(relativePath) === "." ? "" : `${dirname(relativePath).split(sep).join("/")}/`;
		const predecessor = `${parent}${continuation[1]}-${Number(continuation[2]) - 1}.md`;
		const base = `${parent}${continuation[1]}.md`;
		if (existingMemoryPaths.has(predecessor) || existingMemoryPaths.has(base))
			warnings.push(
				`${basename(filePath)} continues an existing numbered memory. Merge the shared topic or use an independent semantic filename; recall selects files independently.`,
			);
	}
	const { metadata } = parseFrontmatter(content.slice(0, 65_536));
	if (typeof metadata.description !== "string" || metadata.description.trim() === "") {
		warnings.push(
			`${basename(filePath)} has no frontmatter description, so future relevance selection will be unreliable.`,
		);
	} else if (metadata.description.length > 300) {
		warnings.push(
			`${basename(filePath)} has a ${metadata.description.length}-character description. Shorten it to a one-line hook of about 150 characters.`,
		);
	}
	return warnings;
}

async function fileSnapshot(filePath: string): Promise<{ content: string; baseline: ReadBaseline }> {
	const handle = await open(filePath, NO_FOLLOW_READ);
	try {
		const before = await handle.stat();
		if (!before.isFile()) throw new Error(`Not a regular file: ${filePath}`);
		const content = await handle.readFile({ encoding: "utf8" });
		const after = await handle.stat();
		if (before.mtimeMs !== after.mtimeMs || before.size !== after.size)
			throw new Error(`File changed while it was read: ${filePath}. Read it again before editing.`);
		return {
			content,
			baseline: { hash: sha256(content), mtimeMs: after.mtimeMs, size: after.size },
		};
	} finally {
		await handle.close();
	}
}

export async function baseline(filePath: string): Promise<ReadBaseline> {
	return (await fileSnapshot(filePath)).baseline;
}

export function sameBaseline(left: ReadBaseline, right: ReadBaseline): boolean {
	// Claude treats an mtime-only change as safe when the complete content hash
	// and size still match the model's last ordinary text read.
	return left.hash === right.hash && left.size === right.size;
}

function baselineChanged(current: ReadBaseline | null, expected: ReadBaseline | null): boolean {
	if (current === null || expected === null) return current !== expected;
	return Math.floor(current.mtimeMs) > expected.mtimeMs && !sameBaseline(current, expected);
}

async function publishFile(
	filePath: string,
	content: string,
	beforeRename?: () => void | Promise<void>,
	exclusiveCreate = false,
): Promise<boolean> {
	const parent = dirname(filePath);
	const parentInfo = await lstat(parent);
	if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink()) throw new Error(`Unsafe parent directory: ${parent}`);
	const temporary = join(parent, `.${basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
	try {
		const handle = await open(temporary, "wx", 0o600);
		try {
			await handle.writeFile(content, "utf8");
		} finally {
			await handle.close();
		}
		await beforeRename?.();
		if (exclusiveCreate) {
			try {
				// Android SELinux can prohibit hard links even in Termux's private storage.
				// Exclusive copying still refuses existing targets, but is not atomic for readers.
				if (process.platform === "android") await copyFile(temporary, filePath, constants.COPYFILE_EXCL);
				else await link(temporary, filePath);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
				throw error;
			}
			await rm(temporary);
		} else await rename(temporary, filePath);
		return true;
	} finally {
		await rm(temporary, { force: true }).catch(() => {});
	}
}

export async function atomicWrite(filePath: string, content: string): Promise<void> {
	await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
	await withFileMutationQueue(filePath, () => publishFile(filePath, content));
}

export async function atomicWriteIfBaseline(
	filePath: string,
	expected: ReadBaseline | null,
	update: (current: string | null) => string,
	lockFile?: string,
	guard?: () => void | Promise<void>,
	options?: { allowChangedBaseline?: boolean; onChangedBaseline?: () => void },
): Promise<ReadBaseline> {
	await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
	const release = lockFile ? await acquireLock(lockFile, 15 * 60_000) : undefined;
	if (lockFile && !release) throw new Error(`Another memory writer is modifying ${filePath}`);
	try {
		await guard?.();
		return await withFileMutationQueue(filePath, async () => {
			let current: string | null = null;
			let currentBaseline: ReadBaseline | null = null;
			try {
				const snapshot = await fileSnapshot(filePath);
				current = snapshot.content;
				currentBaseline = snapshot.baseline;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
			if (baselineChanged(currentBaseline, expected)) {
				if (!options?.allowChangedBaseline)
					throw new Error(`File has been modified since it was read: ${filePath}. Read it again before editing.`);
				options.onChangedBaseline?.();
			}
			if (!(await publishFile(filePath, update(current), guard, currentBaseline === null)))
				throw new Error(`File was created while the update was staged: ${filePath}. Read it before editing.`);
			return baseline(filePath);
		});
	} finally {
		await release?.();
	}
}

function dreamStateFile(paths: ProjectPaths): string {
	return paths.dreamStateFile ?? paths.stateFile;
}

async function readStateFile(filePath: string): Promise<ProjectMemoryState | undefined> {
	let handle: Awaited<ReturnType<typeof open>>;
	try {
		handle = await open(filePath, NO_FOLLOW_READ);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
	try {
		const before = await handle.stat();
		if (!before.isFile()) throw new Error(`Dream state is not a regular file: ${filePath}`);
		const raw = await handle.readFile("utf8");
		const after = await handle.stat();
		if (before.mtimeMs !== after.mtimeMs || before.size !== after.size)
			throw new Error(`Dream state changed while it was read: ${filePath}`);
		try {
			const parsed: unknown = JSON.parse(raw);
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid shape");
			const record = parsed as Record<string, unknown>;
			if (record.schemaVersion !== undefined && record.schemaVersion !== 1) throw new Error("unsupported schema");
			const value = record.lastDreamAt ?? record.lastSuccessfulDreamAt;
			if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error("invalid timestamp");
			return { schemaVersion: 1, lastDreamAt: value };
		} catch (error) {
			// Invalid or newer state cannot safely establish cadence or be overwritten.
			throw new Error(`Invalid dream state at ${filePath}`, { cause: error });
		}
	} finally {
		await handle.close();
	}
}

export async function readState(paths: ProjectPaths): Promise<ProjectMemoryState> {
	const shared = dreamStateFile(paths);
	return (
		(await readStateFile(shared)) ??
		(shared === paths.stateFile ? undefined : await readStateFile(paths.stateFile)) ?? { ...DEFAULT_STATE }
	);
}

export async function compareAndSwapLastDreamAt(
	paths: ProjectPaths,
	expected: number,
	replacement: number,
	guard?: () => void | Promise<void>,
): Promise<boolean> {
	const lease = await acquireLock(join(paths.locksDir, "last-dream-at.lock"), 60_000);
	if (!lease) return false;
	try {
		await guard?.();
		await lease.assertValid();
		const stateFile = dreamStateFile(paths);
		return await withFileMutationQueue(stateFile, async () => {
			await guard?.();
			await lease.assertValid();
			const current = await readState(paths);
			if (current.lastDreamAt !== expected) return false;
			await publishFile(
				stateFile,
				`${JSON.stringify({ ...current, lastDreamAt: replacement }, null, 2)}\n`,
				async () => {
					await guard?.();
					await lease.assertValid();
				},
			);
			return true;
		});
	} finally {
		await lease();
	}
}

// Pi accepts safe custom IDs in addition to UUIDs. Keep the exact host grammar
// so an explicit session name cannot inject lines or prompt markup.
const SESSION_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

async function readSessionHeader(filePath: string): Promise<{ id: string; cwd?: string; mtimeMs: number } | undefined> {
	const handle = await open(filePath, NO_FOLLOW_READ);
	try {
		const info = await handle.stat();
		if (!info.isFile()) return undefined;
		const buffer = Buffer.alloc(16_384);
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
		const firstLine = buffer.subarray(0, bytesRead).toString("utf8").split("\n", 1)[0];
		if (!firstLine) return undefined;
		const header = JSON.parse(firstLine) as { type?: unknown; id?: unknown; cwd?: unknown };
		if (header.type !== "session" || typeof header.id !== "string" || !SESSION_ID.test(header.id)) return undefined;
		return { id: header.id, ...(typeof header.cwd === "string" ? { cwd: header.cwd } : {}), mtimeMs: info.mtimeMs };
	} finally {
		await handle.close();
	}
}

/**
 * Claude's dream scheduler selects sessions from the current project's session
 * index by mtime and passes only their IDs to the model. The dream itself gets
 * read-only access to the session directory through the normal tool gate.
 */
export async function listOtherSessionIds(
	sessionDir: string,
	currentSessionFile: string | undefined,
	currentSessionId: string,
	sinceMs: number,
	projectRoot?: string,
): Promise<string[]> {
	let entries: Dirent[];
	try {
		entries = await readdir(sessionDir, { withFileTypes: true });
	} catch {
		return [];
	}
	const sessions = new Set<string>();
	const canonicalFilter = projectRoot ? await canonicalSessionProjectRoot(projectRoot) : undefined;
	if (projectRoot && !canonicalFilter) return [];
	for (const entry of entries) {
		if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
		const filePath = join(sessionDir, entry.name);
		if (currentSessionFile && resolve(filePath) === resolve(currentSessionFile)) continue;
		try {
			const header = await readSessionHeader(filePath);
			if (!header || header.mtimeMs <= sinceMs || header.id === currentSessionId) continue;
			// Pi's default session directory is project-scoped. A caller may supply a
			// shared custom directory, so require canonical project metadata there.
			if (canonicalFilter && (!header.cwd || (await canonicalSessionProjectRoot(header.cwd)) !== canonicalFilter))
				continue;
			sessions.add(header.id);
		} catch {}
	}
	return [...sessions];
}

async function canonicalSessionProjectRoot(cwd: string): Promise<string | undefined> {
	try {
		return await canonicalProjectRoot(cwd);
	} catch {
		return undefined;
	}
}

interface LockOwner {
	pid: number;
	token: string;
	acquiredAt: number;
}

function processIsAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

async function readLockOwner(lockFile: string): Promise<LockOwner | undefined> {
	try {
		const parsed = JSON.parse(await readRegularFileNoFollow(lockFile)) as Partial<LockOwner>;
		return Number.isSafeInteger(parsed.pid) && typeof parsed.token === "string" && Number.isFinite(parsed.acquiredAt)
			? { pid: Number(parsed.pid), token: parsed.token, acquiredAt: Number(parsed.acquiredAt) }
			: undefined;
	} catch {
		return undefined;
	}
}

export interface LockLease {
	(): Promise<void>;
	isValid(): boolean;
	assertValid(): Promise<void>;
}

async function tryCreateOwnedLock(lockFile: string, owner: LockOwner, staleMs: number): Promise<LockLease | null> {
	let handle: Awaited<ReturnType<typeof open>>;
	try {
		handle = await open(lockFile, "wx", 0o600);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") return null;
		throw error;
	}
	try {
		await handle.writeFile(JSON.stringify(owner));
	} catch (error) {
		await handle.close().catch(() => {});
		await rm(lockFile, { force: true }).catch(() => {});
		throw error;
	}
	await handle.close();

	let valid = true;
	let released = false;
	const checkOwnership = async (): Promise<boolean> => {
		if (!valid || released) return false;
		const current = await readLockOwner(lockFile);
		if (current?.token === owner.token) return true;
		valid = false;
		return false;
	};
	const heartbeat = setInterval(
		() => {
			void (async () => {
				if (!(await checkOwnership())) return;
				const now = new Date();
				await utimes(lockFile, now, now).catch(() => {
					valid = false;
				});
			})();
		},
		Math.max(100, Math.min(1_000, Math.floor(staleMs / 3))),
	);
	heartbeat.unref();

	const release = (async () => {
		if (released) return;
		released = true;
		clearInterval(heartbeat);
		const current = await readLockOwner(lockFile);
		if (current?.token === owner.token) await rm(lockFile, { force: true });
		valid = false;
	}) as LockLease;
	Object.defineProperties(release, {
		isValid: { value: () => valid && !released },
		assertValid: {
			value: async () => {
				if (!(await checkOwnership())) throw new Error(`Lock ownership was lost: ${lockFile}`);
			},
		},
	});
	return release;
}

export async function acquireLock(lockFile: string, staleMs: number): Promise<LockLease | null> {
	const lockDirectory = dirname(lockFile);
	await mkdir(lockDirectory, { recursive: true, mode: 0o700 });
	const lockDirectoryInfo = await lstat(lockDirectory);
	if (!lockDirectoryInfo.isDirectory() || lockDirectoryInfo.isSymbolicLink())
		throw new Error(`Lock directory must be a real directory: ${lockDirectory}`);
	const owner: LockOwner = { pid: process.pid, token: randomUUID(), acquiredAt: Date.now() };
	const recoveryFile = `${lockFile}.recover`;
	// A recovery claim serializes stale-owner takeover. A malformed claim fails
	// closed while fresh, then becomes reclaimable like another stale lock.
	const recoveryInfo = await lstat(recoveryFile).catch(() => undefined);
	if (recoveryInfo) {
		if (!recoveryInfo.isFile() || recoveryInfo.isSymbolicLink()) return null;
		const recoveryOwner = await readLockOwner(recoveryFile);
		if (!recoveryOwner) {
			if (Date.now() - recoveryInfo.mtimeMs <= staleMs) return null;
		} else {
			if (processIsAlive(recoveryOwner.pid)) return null;
			const confirmedRecovery = await readLockOwner(recoveryFile);
			if (confirmedRecovery?.token !== recoveryOwner.token) return null;
		}
		await rm(recoveryFile, { force: true }).catch(() => {});
	}
	const immediate = await tryCreateOwnedLock(lockFile, owner, staleMs);
	if (immediate) return immediate;

	const [info, observed] = await Promise.all([stat(lockFile).catch(() => undefined), readLockOwner(lockFile)]);
	if (!info || Date.now() - info.mtimeMs <= staleMs || (observed?.pid && processIsAlive(observed.pid))) return null;

	let recovery: Awaited<ReturnType<typeof open>> | undefined;
	try {
		recovery = await open(recoveryFile, "wx", 0o600);
		await recovery.writeFile(JSON.stringify(owner));
	} catch (error) {
		await recovery?.close().catch(() => {});
		if ((error as NodeJS.ErrnoException).code === "EEXIST") return null;
		throw error;
	}
	await recovery.close();
	try {
		const [confirmedInfo, confirmed] = await Promise.all([
			stat(lockFile).catch(() => undefined),
			readLockOwner(lockFile),
		]);
		if (
			!confirmedInfo ||
			Date.now() - confirmedInfo.mtimeMs <= staleMs ||
			confirmed?.token !== observed?.token ||
			(confirmed?.pid && processIsAlive(confirmed.pid))
		)
			return null;
		await rm(lockFile, { force: true });
		return await tryCreateOwnedLock(lockFile, owner, staleMs);
	} finally {
		await rm(recoveryFile, { force: true }).catch(() => {});
	}
}

export interface MarkdownSnapshotEntry {
	hash: string;
	mtimeMs: number;
	ctimeMs: number;
	size: number;
	dev: number;
	ino: number;
}

function snapshotEntry(info: Stats, content: string | Buffer): MarkdownSnapshotEntry {
	return {
		hash: sha256(content),
		mtimeMs: info.mtimeMs,
		ctimeMs: info.ctimeMs,
		size: info.size,
		dev: info.dev,
		ino: info.ino,
	};
}

async function markdownSnapshotEntry(
	filePath: string,
	previous?: MarkdownSnapshotEntry,
): Promise<MarkdownSnapshotEntry> {
	const handle = await open(filePath, NO_FOLLOW_READ);
	try {
		const before = await handle.stat();
		if (!before.isFile()) throw new Error(`Not a regular file: ${filePath}`);
		if (
			previous &&
			previous.mtimeMs === before.mtimeMs &&
			previous.ctimeMs === before.ctimeMs &&
			previous.size === before.size &&
			previous.dev === before.dev &&
			previous.ino === before.ino
		)
			return previous;
		const content = await handle.readFile();
		const after = await handle.stat();
		if (before.mtimeMs !== after.mtimeMs || before.size !== after.size)
			throw new Error(`File changed while it was snapshotted: ${filePath}`);
		return snapshotEntry(after, content);
	} finally {
		await handle.close();
	}
}

function markdownAbsolutePath(memoryDir: string, relativePath: string): string | undefined {
	if (!isMarkdownPath(relativePath) || containsVcsMetadataSegment(relativePath)) return undefined;
	const absolute = resolve(memoryDir, relativePath);
	return isContainedPath(memoryDir, absolute) ? absolute : undefined;
}

export async function readMarkdownFileSnapshot(
	memoryDir: string,
	relativePath: string,
): Promise<{ content: string; snapshot: MarkdownSnapshotEntry } | undefined> {
	const absolute = markdownAbsolutePath(memoryDir, relativePath);
	if (!absolute) return undefined;
	const handle = await open(absolute, NO_FOLLOW_READ).catch(() => undefined);
	if (!handle) return undefined;
	try {
		const before = await handle.stat();
		if (!before.isFile()) return undefined;
		const content = await handle.readFile("utf8");
		const after = await handle.stat();
		if (before.mtimeMs !== after.mtimeMs || before.size !== after.size) return undefined;
		return {
			content,
			snapshot: snapshotEntry(after, content),
		};
	} finally {
		await handle.close();
	}
}

export async function snapshotMarkdownFile(
	memoryDir: string,
	relativePath: string,
	previous?: MarkdownSnapshotEntry,
): Promise<MarkdownSnapshotEntry | undefined> {
	const absolute = markdownAbsolutePath(memoryDir, relativePath);
	if (!absolute) return undefined;
	try {
		return await markdownSnapshotEntry(absolute, previous);
	} catch {
		return undefined;
	}
}

export async function snapshotMarkdown(
	memoryDir: string,
	previous: ReadonlyMap<string, MarkdownSnapshotEntry> = new Map(),
): Promise<Map<string, MarkdownSnapshotEntry>> {
	const map = new Map<string, MarkdownSnapshotEntry>();
	for (const topic of await fg("**/*.md", {
		cwd: memoryDir,
		onlyFiles: true,
		followSymbolicLinks: false,
		caseSensitiveMatch: process.platform !== "win32",
		ignore: VCS_METADATA_DIRECTORIES.map((directory) => `**/${directory}/**`),
	})) {
		const entry = await snapshotMarkdownFile(memoryDir, topic, previous.get(topic));
		if (entry) map.set(topic, entry);
	}
	return map;
}

export function diffSnapshots(
	before: ReadonlyMap<string, MarkdownSnapshotEntry>,
	after: ReadonlyMap<string, MarkdownSnapshotEntry>,
): string[] {
	const changed: string[] = [];
	for (const [path, entry] of after) if (before.get(path)?.hash !== entry.hash) changed.push(path);
	for (const path of before.keys()) if (!after.has(path)) changed.push(path);
	return changed.sort();
}

export function memoryPathFromToolInput(memoryDir: string, cwd: string, input: Record<string, unknown>): string | null {
	let raw: string | undefined;
	if (typeof input.path === "string") raw = input.path;
	else if (typeof input.file_path === "string") raw = input.file_path;
	if (!raw) return null;
	let absolute: string;
	try {
		absolute = resolveToolPath(cwd, raw);
	} catch {
		// Unsafe forms (drive-relative, expanded variables, ADS) never enter memory.
		return null;
	}
	return isContainedPath(memoryDir, absolute) ? absolute : null;
}

export function topicCatalog(topics: MemoryTopic[]): string {
	return topics
		.map((topic) => {
			const type = topic.type === "unknown" ? "" : `[${topic.type}] `;
			const head = `- ${type}${topic.filename} (${new Date(topic.mtimeMs).toISOString()})`;
			return topic.description ? `${head}: ${topic.description}` : head;
		})
		.join("\n");
}

export async function safeDeleteMemoryFile(
	memoryDir: string,
	filePath: string,
	expected: ReadBaseline | undefined,
	lockFile?: string,
	guard?: () => void | Promise<void>,
): Promise<void> {
	const [canonicalRoot, canonicalParent] = await Promise.all([realpath(memoryDir), realpath(dirname(filePath))]);
	const canonicalFile = join(canonicalParent, basename(filePath));
	if (!isContainedPath(canonicalRoot, canonicalFile) || !isMarkdownPath(canonicalFile))
		throw new Error("delete target is outside memory or is not a .md file");
	const release = lockFile ? await acquireLock(lockFile, 15 * 60_000) : undefined;
	if (lockFile && !release) throw new Error(`Another memory writer is modifying ${canonicalFile}`);
	try {
		await guard?.();
		await withFileMutationQueue(canonicalFile, async () => {
			if (expected && !sameBaseline(await baseline(canonicalFile), expected))
				throw new Error(`File changed since it was read: ${canonicalFile}. Read it again before deleting.`);
			await guard?.();
			await rm(canonicalFile);
		});
	} finally {
		await release?.();
	}
}
