import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Windows installations of Git expose their MSYS shell under one of these names. */
const DEFAULT_GIT_BASH_PATH = "C:\\Program Files\\Git\\bin\\bash.exe";

const GIT_BASH_VERSION = /^(?:MINGW|MSYS)/;
const VALIDATION_TIMEOUT_MS = 5_000;

export type ShellRejectionDetail = "wsl" | "invalid" | "missing";

export type ShellAvailability =
	| { available: true; path: string }
	| { available: false; reason: "not-found" }
	| { available: false; reason: "rejected"; path: string; detail: ShellRejectionDetail };

export interface ShellProbeOptions {
	/** Defaults to process.platform. */
	platform?: NodeJS.Platform;
	/** Defaults to process.env. */
	env?: NodeJS.ProcessEnv;
	/** Explicit user shellPath. Authoritative when set. */
	shellPath?: string | null;
	/** Test seam: whether a candidate exists. */
	exists?: (path: string) => Promise<boolean>;
	/** Test seam: `where bash.exe` replacements. */
	findOnPath?: (name: string) => Promise<string[]>;
	/** Test seam: output of `bash -c 'uname -s'`, or undefined when it failed. */
	validate?: (path: string) => Promise<string | undefined>;
}

export function isGitBashVersion(output: string | undefined): boolean {
	return GIT_BASH_VERSION.test(output?.trim() ?? "");
}

function defaultExists(path: string): Promise<boolean> {
	return access(path).then(
		() => true,
		() => false,
	);
}

async function defaultFindOnPath(name: string): Promise<string[]> {
	try {
		const { stdout } = await execFileAsync("where", [name], { windowsHide: true, timeout: VALIDATION_TIMEOUT_MS });
		return stdout
			.split(/\r?\n/)
			.map((line) => line.trim())
			.filter(Boolean);
	} catch {
		return [];
	}
}

async function defaultValidate(path: string): Promise<string | undefined> {
	try {
		const { stdout } = await execFileAsync(path, ["-c", "uname -s"], {
			windowsHide: true,
			timeout: VALIDATION_TIMEOUT_MS,
		});
		return stdout;
	} catch {
		return undefined;
	}
}

function rejection(path: string, output: string | undefined, exists: boolean): ShellAvailability {
	return {
		available: false,
		reason: "rejected",
		path,
		detail: !exists ? "missing" : /^Linux\b/i.test(output?.trim() ?? "") ? "wsl" : "invalid",
	};
}

/**
 * Resolve a usable background shell. On Windows only Git Bash is accepted:
 * the WSL launcher reports Linux from `uname -s` and is rejected. On POSIX the
 * existing behavior is unchanged and no validation is attempted.
 */
export async function probeShell(options: ShellProbeOptions = {}): Promise<ShellAvailability> {
	const platform = options.platform ?? process.platform;
	const env = options.env ?? process.env;
	const exists = options.exists ?? defaultExists;
	const findOnPath = options.findOnPath ?? defaultFindOnPath;
	const validate = options.validate ?? defaultValidate;
	const explicit = options.shellPath?.trim() || null;

	if (platform !== "win32") return { available: true, path: explicit ?? "bash" };

	if (explicit) {
		const found = await exists(explicit);
		if (!found) return rejection(explicit, undefined, false);
		const version = await validate(explicit);
		return isGitBashVersion(version) ? { available: true, path: explicit } : rejection(explicit, version, true);
	}

	let rejected: ShellAvailability | undefined;
	const check = async (candidate: string): Promise<ShellAvailability | undefined> => {
		if (!(await exists(candidate))) return undefined;
		const version = await validate(candidate);
		if (isGitBashVersion(version)) return { available: true, path: candidate };
		rejected ??= rejection(candidate, version, true);
		return undefined;
	};

	const localAppData = env.LOCALAPPDATA?.trim();
	const fixed = [DEFAULT_GIT_BASH_PATH];
	if (localAppData) fixed.push(join(localAppData, "Programs", "Git", "bin", "bash.exe"));
	for (const candidate of fixed) {
		const available = await check(candidate);
		if (available) return available;
	}

	for (const candidate of new Set(await findOnPath("bash.exe"))) {
		const available = await check(candidate);
		if (available) return available;
	}
	return rejected ?? { available: false, reason: "not-found" };
}

/** The single line shown by `/memory status` and the one-time TUI notice. */
export function shellStatusLine(shell: ShellAvailability): string {
	if (shell.available) return `Git Bash: ${shell.path}`;
	if (shell.reason === "not-found") return "Git Bash: not found — bash tool disabled";
	if (shell.detail === "wsl") return `Git Bash: rejected (${shell.path} is WSL)`;
	if (shell.detail === "missing") return `Git Bash: rejected (${shell.path} was not found)`;
	return `Git Bash: rejected (${shell.path} is not Git Bash)`;
}
