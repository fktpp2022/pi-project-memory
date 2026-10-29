// Throwaway prototype for pi-project-memory #11.
// Implements the decided path contract and checks it against a table of inputs.

import { homedir } from "node:os";
import { win32 } from "node:path";
import { realpathSync } from "node:fs";

const DRIVE = /^[a-zA-Z]:/;
const MSYS = /^\/(?:cygdrive\/)?([a-zA-Z])(?:\/|$)/; // /c/... and /cygdrive/c/...
const WSL = /^\/mnt\/([a-zA-Z])(?:\/|$)/;

function stripExtended(p) {
	if (/^\\\\\?\\UNC\\/i.test(p)) return "\\\\" + p.slice(8);
	if (/^\\\\\?\\/i.test(p)) return p.slice(4);
	if (/^\\\\\.\\/i.test(p)) return p.slice(4);
	return p;
}

function expandHome(p) {
	if (p === "~") return homedir();
	if (/^~[\\/]/.test(p)) return win32.join(homedir(), p.slice(2));
	return p;
}

export function normalizeInput(cwd, input) {
	let p = input.trim();
	p = stripExtended(p);
	p = expandHome(p);

	const wsl = WSL.exec(p);
	if (wsl) p = `${wsl[1].toUpperCase()}:\\` + p.slice(wsl[0].length);
	else {
		const msys = MSYS.exec(p);
		if (msys) p = `${msys[1].toUpperCase()}:\\` + p.slice(msys[0].length);
	}

	// Drive-relative: C:foo (no separator after the colon) is rejected.
	if (DRIVE.test(p) && !/^[a-zA-Z]:[\\/]/.test(p)) {
		throw new Error("drive-relative paths are not supported: " + input);
	}

	const resolved = win32.resolve(cwd, p);

	// ADS guard: any colon beyond the drive prefix.
	const afterDrive = resolved.slice(2);
	if (afterDrive.includes(":")) {
		throw new Error("alternate data streams are not supported: " + input);
	}
	return resolved;
}

export function isContained(root, candidate) {
	let realRoot, realCandidate;
	try {
		realRoot = realpathSync.native(win32.resolve(root));
	} catch {
		realRoot = win32.resolve(root);
	}
	try {
		realCandidate = realpathSync.native(win32.resolve(candidate));
	} catch {
		realCandidate = win32.resolve(candidate);
	}
	const rel = win32.relative(realRoot.toLowerCase(), realCandidate.toLowerCase());
	return rel === "" || (!rel.startsWith("..") && !win32.isAbsolute(rel));
}

if (process.argv[1]?.endsWith("proto.mjs")) {
	const cwd = "D:\\Projects\\pi-project-memory";
	const cases = [
		["C:\\mem\\a.md", "C:\\mem\\a.md"],
		["C:/mem/a.md", "C:\\mem\\a.md"],
		["/c/mem/a.md", "C:\\mem\\a.md"],
		["/d/mem/a.md", "D:\\mem\\a.md"],
		["/mnt/c/mem/a.md", "C:\\mem\\a.md"],
		["/cygdrive/c/mem/a.md", "C:\\mem\\a.md"],
		["~/mem/a.md", win32.join(homedir(), "mem", "a.md")],
		["~\\mem\\a.md", win32.join(homedir(), "mem", "a.md")],
		["\\\\?\\C:\\mem\\a.md", "C:\\mem\\a.md"],
		["\\\\?\\UNC\\srv\\share\\a.md", "\\\\srv\\share\\a.md"],
	];
	let failures = 0;
	for (const [input, expected] of cases) {
		const actual = normalizeInput(cwd, input);
		const ok = actual === expected;
		if (!ok) failures++;
		console.log(`${ok ? "ok  " : "FAIL"} ${input} -> ${actual}`);
	}

	const rejects = [
		["C:foo", "drive-relative"],
		["C:", "drive-relative"],
		["C:\\mem\\notes.md:stream.md", "ADS"],
		["C:\\mem\\a.md::$DATA", "ADS"],
	];
	for (const [input, label] of rejects) {
		try {
			const out = normalizeInput(cwd, input);
			console.log(`FAIL ${label} accepted: ${input} -> ${out}`);
			failures++;
		} catch (error) {
			console.log(`ok   ${label} rejected: ${input}`);
		}
	}

	console.log(failures === 0 ? "\nALL NORMALIZATION CASES PASS" : `\n${failures} FAILURES`);
	process.exitCode = failures === 0 ? 0 : 1;
}
