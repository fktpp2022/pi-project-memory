import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { isGitBashVersion, probeShell, type ShellAvailability, shellStatusLine } from "../src/shell.ts";

const GIT_BASH = "MINGW64_NT-10.0-26300";
const WSL = "Linux";

function fakeProbe(options: {
	sources: Record<string, string | undefined>;
	where?: string[];
	localAppData?: string;
	shellPath?: string | null;
	platform?: NodeJS.Platform;
}) {
	const validated: string[] = [];
	const checked: string[] = [];
	const whereCalls: string[] = [];
	const result = probeShell({
		platform: options.platform ?? "win32",
		env: { LOCALAPPDATA: options.localAppData ?? "C:\\Users\\test\\AppData\\Local" },
		shellPath: options.shellPath ?? null,
		exists: async (path) => {
			checked.push(path);
			return path in options.sources;
		},
		findOnPath: async (name) => {
			whereCalls.push(name);
			return options.where ?? [];
		},
		validate: async (path) => {
			validated.push(path);
			return options.sources[path];
		},
	});
	return { result, validated, checked, whereCalls };
}

test("probe follows Git for Windows locations in order and validates each candidate", async () => {
	const system = "C:\\Program Files\\Git\\bin\\bash.exe";
	const local = join("C:\\Users\\test\\AppData\\Local", "Programs", "Git", "bin", "bash.exe");
	const { result, validated, whereCalls } = fakeProbe({
		sources: { [system]: "Linux", [local]: GIT_BASH },
		where: ["C:\\Windows\\System32\\bash.exe"],
	});
	assert.deepEqual(await result, { available: true, path: local });
	assert.deepEqual(validated, [system, local]);
	assert.deepEqual(whereCalls, []);
});

test("probe falls through to where bash.exe and accepts an MSYS install", async () => {
	const where = "C:\\tools\\msys64\\usr\\bin\\bash.exe";
	const { result, whereCalls } = fakeProbe({
		sources: { [where]: "MSYS_NT-10.0" },
		where: ["C:\\Windows\\System32\\bash.exe", where],
	});
	assert.deepEqual(await result, { available: true, path: where });
	assert.deepEqual(whereCalls, ["bash.exe"]);
});

test("an explicit shellPath is authoritative and a WSL launcher is rejected without fall-through", async () => {
	const system = "C:\\Program Files\\Git\\bin\\bash.exe";
	const wsl = "C:\\Windows\\System32\\bash.exe";
	const { result, validated, whereCalls } = fakeProbe({
		sources: { [system]: GIT_BASH, [wsl]: WSL },
		shellPath: wsl,
		where: [system],
	});
	assert.deepEqual(await result, { available: false, reason: "rejected", path: wsl, detail: "wsl" });
	assert.deepEqual(validated, [wsl]);
	assert.deepEqual(whereCalls, []);
});

test("an explicit shellPath that is not Git Bash is rejected with its path", async () => {
	const explicit = "C:\\tools\\sh.exe";
	const { result } = fakeProbe({ sources: { [explicit]: "Darwin" }, shellPath: explicit });
	assert.deepEqual(await result, { available: false, reason: "rejected", path: explicit, detail: "invalid" });
});

test("an explicit missing shellPath is rejected rather than silently ignored", async () => {
	const explicit = "C:\\missing\\bash.exe";
	const { result } = fakeProbe({ sources: {}, shellPath: explicit });
	assert.deepEqual(await result, { available: false, reason: "rejected", path: explicit, detail: "missing" });
});

test("probe reports not found when no candidate validates", async () => {
	const { result } = fakeProbe({ sources: {}, where: ["C:\\Windows\\System32\\bash.exe"] });
	assert.deepEqual(await result, { available: false, reason: "not-found" });
});

test("a where candidate that resolves to WSL is reported as rejected", async () => {
	const wsl = "C:\\Windows\\System32\\bash.exe";
	const { result } = fakeProbe({ sources: { [wsl]: WSL }, where: [wsl] });
	assert.deepEqual(await result, { available: false, reason: "rejected", path: wsl, detail: "wsl" });
});

test("non-Windows keeps the existing bash behavior without Git Bash validation", async () => {
	const { result, validated } = fakeProbe({ platform: "linux", sources: {} });
	assert.deepEqual(await result, { available: true, path: "bash" });
	assert.deepEqual(validated, []);
});

test("Git Bash version matching accepts MINGW and MSYS only", () => {
	assert.equal(isGitBashVersion(GIT_BASH), true);
	assert.equal(isGitBashVersion("MSYS_NT-10.0"), true);
	assert.equal(isGitBashVersion("Linux"), false);
	assert.equal(isGitBashVersion("Darwin"), false);
	assert.equal(isGitBashVersion(""), false);
});

test("status line uses the exact tri-state strings", () => {
	const available: ShellAvailability = { available: true, path: "C:\\Program Files\\Git\\bin\\bash.exe" };
	const notFound: ShellAvailability = { available: false, reason: "not-found" };
	const rejected: ShellAvailability = {
		available: false,
		reason: "rejected",
		path: "C:\\Windows\\System32\\bash.exe",
		detail: "wsl",
	};
	assert.equal(shellStatusLine(available), "Git Bash: C:\\Program Files\\Git\\bin\\bash.exe");
	assert.equal(shellStatusLine(notFound), "Git Bash: not found — bash tool disabled");
	assert.equal(shellStatusLine(rejected), "Git Bash: rejected (C:\\Windows\\System32\\bash.exe is WSL)");
});

test("probing again picks up a shell installed mid-session", async () => {
	let installed = false;
	const path = "C:\\Program Files\\Git\\bin\\bash.exe";
	const options = {
		platform: "win32" as const,
		env: {},
		exists: async (candidate: string) => installed && candidate === path,
		findOnPath: async () => [],
		validate: async () => (installed ? GIT_BASH : undefined),
	};
	assert.deepEqual(await probeShell(options), { available: false, reason: "not-found" });
	installed = true;
	assert.deepEqual(await probeShell(options), { available: true, path });
});
