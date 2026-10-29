import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { TestContext } from "node:test";

export const shellPath = process.platform === "android" ? "/system/bin/sh" : "/bin/sh";

export const WINDOWS_XARGS_REASON = "xargs is classified as not read-only on win32 (src/bash-readonly.ts)";

const RETRYABLE_CODES = new Set(["EBUSY", "EPERM", "EACCES"]);

export interface RemoveTempDirectoryOptions {
	attempts?: number;
	baseDelayMs?: number;
	delay?: (milliseconds: number) => Promise<void>;
	remove?: (directory: string) => Promise<void>;
}

/** Skips the whole test on Windows and returns true so callers can return early. */
export function skipOnWindows(t: TestContext, reason: string, platform: NodeJS.Platform = process.platform): boolean {
	if (platform !== "win32") return false;
	t.skip(`Windows: ${reason}`);
	return true;
}

/** Gates a POSIX-only block inside an otherwise cross-platform test. */
export function skipBlockOnWindows(
	t: TestContext,
	reason: string,
	platform: NodeJS.Platform = process.platform,
): boolean {
	if (platform !== "win32") return false;
	t.diagnostic(`Windows skip: ${reason}`);
	return true;
}

/**
 * Removes a temporary directory with a bounded, jittered retry. Windows reports
 * EBUSY/EPERM while a watcher, child process, or editor still holds a handle, and
 * keeps the directory locked while it is some process's working directory.
 */
export async function removeTempDirectory(directory: string, options: RemoveTempDirectoryOptions = {}): Promise<void> {
	const attempts = options.attempts ?? 5;
	const baseDelayMs = options.baseDelayMs ?? 50;
	const remove = options.remove ?? ((target: string) => rm(target, { recursive: true, force: true }));
	const delay =
		options.delay ?? ((milliseconds: number) => new Promise<void>((done) => setTimeout(done, milliseconds)));
	leaveWorkingDirectory(directory);
	for (let attempt = 1; ; attempt++) {
		try {
			await remove(directory);
			return;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (!code || !RETRYABLE_CODES.has(code) || attempt >= attempts) throw error;
			await delay(baseDelayMs * 2 ** (attempt - 1) + Math.floor(Math.random() * baseDelayMs));
		}
	}
}

export async function createTempDirectory(t: TestContext, prefix: string): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), prefix));
	t.after(() => removeTempDirectory(root));
	return root;
}

export async function createToolWorkspace(t: TestContext, prefix: string) {
	const root = await createTempDirectory(t, prefix);
	const memoryDir = join(root, "memory");
	const projectRoot = join(root, "project");
	const locksDir = join(root, "locks");
	await Promise.all([mkdir(memoryDir), mkdir(projectRoot), mkdir(locksDir)]);
	return { root, memoryDir, projectRoot, locksDir };
}

function leaveWorkingDirectory(directory: string): void {
	const target = resolve(directory);
	const current = resolve(process.cwd());
	const inside = relative(target, current);
	if (inside === "" || (!inside.startsWith("..") && !isAbsolute(inside))) process.chdir(tmpdir());
}
