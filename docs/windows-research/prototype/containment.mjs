// Throwaway prototype for pi-project-memory #11: containment and reparse behavior.
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isContained, normalizeInput } from "./proto.mjs";

const root = mkdtempSync(join(tmpdir(), "winpath-proto-"));
const memory = join(root, "memory");
mkdirSync(join(memory, "topics"), { recursive: true });
writeFileSync(join(memory, "topics", "a.md"), "# a\n");
const outside = join(root, "outside");
mkdirSync(outside);
writeFileSync(join(outside, "secret.md"), "# secret\n");
symlinkSync(outside, join(memory, "link"), "junction");

const cases = [
	["exact", true, join(memory, "topics", "a.md")],
	["case-folded root", true, join(memory, "topics", "A.MD").toLowerCase()],
	["forward slashes", true, join(memory, "topics", "a.md").replace(/\\/g, "/")],
	["sibling prefix", false, join(root, "memory-evil", "a.md")],
	["outside", false, join(outside, "secret.md")],
	["junction escape", false, join(memory, "link", "secret.md")],
];

let failures = 0;
for (const [label, expected, candidate] of cases) {
	const actual = isContained(memory, candidate);
	const ok = actual === expected;
	if (!ok) failures++;
	console.log(`${ok ? "ok  " : "FAIL"} ${label}: contained=${actual} (expected ${expected})`);
}

// Prove the normalization+containment pair agrees for MSYS input.
const msys = normalizeInput(memory, "/c/" + join(memory, "topics", "a.md").slice(3).replace(/\\/g, "/"));
console.log(`ok   MSYS round-trip -> ${msys} contained=${isContained(memory, msys)}`);
if (!isContained(memory, msys)) failures++;

console.log(failures === 0 ? "\nALL CONTAINMENT CASES PASS" : `\n${failures} FAILURES`);
process.exitCode = failures === 0 ? 0 : 1;
