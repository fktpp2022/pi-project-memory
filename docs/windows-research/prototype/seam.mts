// Throwaway prototype for pi-project-memory #11: exercise the real seams.
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertContainedMarkdown } from "file:///D:/Projects/pi-project-memory/src/paths.ts";
import { prepareRestrictedBash } from "file:///D:/Projects/pi-project-memory/src/restricted-bash.ts";
import { normalizeInput, isContained } from "./proto.mjs";

const root = mkdtempSync(join(tmpdir(), "winpath-seam-"));
const memory = join(root, "memory");
mkdirSync(join(memory, "topics"), { recursive: true });
writeFileSync(join(memory, "topics", "a.md"), "# a\n");

async function attempt(label, command) {
	try {
		await prepareRestrictedBash(command, { memoryDir: memory, cwd: memory });
		console.log(`ok   ${label}: accepted`);
		return true;
	} catch (error) {
		console.log(`fail ${label}: ${error.message}`);
		return false;
	}
}

console.log("--- current behavior ---");
await attempt("native backslash", `rm ${join(memory, "topics", "a.md")}`);
await attempt("native forward slash", `rm ${join(memory, "topics", "a.md").replace(/\\/g, "/")}`);
await attempt("MSYS /c/", `rm /c/${join(memory, "topics", "a.md").slice(3).replace(/\\/g, "/")}`);
await attempt("relative", "rm topics/a.md");

console.log("\n--- normalized operand through assertContainedMarkdown ---");
for (const input of [
	join(memory, "topics", "a.md"),
	join(memory, "topics", "a.md").replace(/\\/g, "/"),
	`/c/${join(memory, "topics", "a.md").slice(3).replace(/\\/g, "/")}`,
]) {
	try {
		const normalized = normalizeInput(memory, input);
		const contained = assertContainedMarkdown(memory, normalized);
		console.log(`ok   ${input} -> ${contained} (isContained=${isContained(memory, contained)})`);
	} catch (error) {
		console.log(`fail ${input}: ${error.message}`);
	}
}

console.log("\n--- rejected after normalization ---");
for (const input of [join(root, "outside.md"), join(memory, "topics", "a.txt")]) {
	try {
		assertContainedMarkdown(memory, normalizeInput(memory, input));
		console.log(`FAIL accepted outside/non-md: ${input}`);
	} catch (error) {
		console.log(`ok   rejected: ${input} (${error.message.split("\n")[0]})`);
	}
}

console.log(`\nmemory dir exists: ${existsSync(memory)}`);
