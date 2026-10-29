import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { Context } from "@earendil-works/pi-ai";
import { createFauxCore, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ChildCodemodeOptions } from "../src/child-codemode.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { runChildAgent } from "../src/models.ts";
import { createToolWorkspace } from "./helpers.ts";

async function workspace(t: TestContext) {
	const { root, memoryDir, projectRoot, locksDir } = await createToolWorkspace(t, "pi-memory-child-codemode-");
	const faux = createFauxCore({ models: [{ id: "child-codemode", reasoning: false }] });
	const ctx = {
		cwd: projectRoot,
		model: faux.getModel(),
		isProjectTrusted: () => true,
		modelRegistry: { streamSimple: faux.streamSimple },
		sessionManager: {
			getBranch: () => {
				throw new Error("Child scripts must not read the parent store");
			},
		},
	} as unknown as ExtensionContext;
	return {
		root,
		faux,
		ctx,
		paths: { projectRoot, projectKey: "test", baseDir: root, memoryDir, stateFile: join(root, "state.json"), locksDir },
	};
}

for (const role of ["extractor", "dream"] as const) {
	for (const mode of ["on", "only"] as const) {
		test(`${role} codemode ${mode} uses only local tools and preserves baselines, store, and parent instructions`, async (t) => {
			const { root, faux, ctx, paths } = await workspace(t);
			const topic = join(paths.memoryDir, "fact.md");
			const output = join(paths.memoryDir, "saved.md");
			const outside = join(root, "outside.md");
			await writeFile(topic, "old fact\n");
			await writeFile(outside, "outside\n");
			const script = `
				const names = ALL_TOOLS.map(tool => tool.name).sort();
				if (JSON.stringify(names) !== JSON.stringify(["bash", "edit", "find", "grep", "read", "write"])) throw Error("Unexpected tools");
				if (typeof models !== "undefined") throw Error("Model access leaked");
				if (load("secret") !== undefined) throw Error("Store leaked");
				await tools.read({path: ${JSON.stringify(outside)}});
				const denied = await Promise.allSettled([
					tools.write({path: ${JSON.stringify(outside)}, content: "bad"}),
					tools.edit({path: ${JSON.stringify(topic)}, edits: [{oldText: "old", newText: "bad"}]}),
					tools.bash({command: "touch forbidden"})
				]);
				if (denied.some(result => result.status !== "rejected")) throw Error("Policy bypassed");
				await tools.read({path: ${JSON.stringify(topic)}});
				await tools.edit({path: ${JSON.stringify(topic)}, edits: [{oldText: "old", newText: "new"}]});
				store("secret", "task-local");
				return "POLICY_OK";
			`;
			faux.setResponses([
				(context) => {
					const request = context as unknown as Context;
					assert.ok(request.systemPrompt?.startsWith("Keep the user's project instructions.\n<tools>(none)</tools>"));
					assert.match(request.systemPrompt ?? "", /Earlier tool inventories/);
					assert.deepEqual(
						request.tools?.map((tool) => tool.name).sort(),
						mode === "only" ? ["codemode"] : ["bash", "codemode", "edit", "find", "grep", "read", "write"],
					);
					for (const tool of request.tools ?? [])
						assert.ok(request.systemPrompt?.includes(`- ${tool.name}: ${tool.description}`));
					return fauxAssistantMessage(fauxToolCall("codemode", { code: script }));
				},
				(context) => {
					const result = context.messages.at(-1);
					assert.equal(result?.role, "toolResult");
					assert.match(JSON.stringify(result), /POLICY_OK/);
					return fauxAssistantMessage(
						fauxToolCall("codemode", {
							code: `if (load("secret") !== "task-local") throw Error("Store missing"); await tools.write({path: ${JSON.stringify(output)}, content: "saved"}); return "STORE_OK";`,
						}),
					);
				},
				(context) => {
					assert.match(JSON.stringify(context.messages.at(-1)), /STORE_OK/);
					return fauxAssistantMessage("done");
				},
			]);
			const options = {
				role,
				prompt: "save memories",
				sourceMessages: [],
				systemPrompt: "Keep the user's project instructions.\n<tools>(none)</tools>",
				config: structuredClone(DEFAULT_CONFIG),
				paths,
				ctx,
				codemode: { mode } satisfies ChildCodemodeOptions,
				isCurrentGeneration: () => true,
			};
			const result = await runChildAgent(options);
			assert.equal(await readFile(topic, "utf8"), "new fact\n");
			assert.equal(await readFile(output, "utf8"), "saved");
			assert.equal(await readFile(outside, "utf8"), "outside\n");
			assert.deepEqual(result.touchedPaths, ["fact.md", "saved.md"]);
			faux.setResponses([
				fauxAssistantMessage(
					fauxToolCall("codemode", {
						code: 'if (load("secret") !== undefined) throw Error("Previous task store leaked"); return "ISOLATED";',
					}),
				),
				(context) => {
					assert.match(JSON.stringify(context.messages.at(-1)), /ISOLATED/);
					return fauxAssistantMessage("done");
				},
			]);
			await runChildAgent(options);
		});
	}
}

test("background runs freeze their shell availability per run and expose the no-bash codemode text", async (t) => {
	const { faux, ctx, paths } = await workspace(t);
	const requested: Array<{ tools: string[]; systemPrompt: string }> = [];
	const respond = (context: any) => {
		requested.push({
			tools: (context.tools ?? []).map((tool: { name: string }) => tool.name).sort(),
			systemPrompt: context.systemPrompt ?? "",
		});
		return fauxAssistantMessage("done");
	};
	const options = {
		role: "extractor" as const,
		prompt: "save memories",
		sourceMessages: [],
		systemPrompt: "system",
		config: structuredClone(DEFAULT_CONFIG),
		paths,
		ctx,
		codemode: { mode: "on" as const },
		isCurrentGeneration: () => true,
	};

	faux.setResponses([respond]);
	await runChildAgent({
		...options,
		shell: { available: false, reason: "not-found" },
	});
	assert.deepEqual(requested[0]!.tools, ["codemode", "edit", "find", "grep", "read", "write"]);
	assert.match(requested[0]!.systemPrompt, /Shell access is unavailable in this run/);
	assert.doesNotMatch(requested[0]!.systemPrompt, /restricted bash/);

	faux.setResponses([respond]);
	await runChildAgent({
		...options,
		shell: { available: true, path: "C:\\Program Files\\Git\\bin\\bash.exe" },
	});
	assert.deepEqual(requested[1]!.tools, ["bash", "codemode", "edit", "find", "grep", "read", "write"]);
	assert.match(requested[1]!.systemPrompt, /restricted bash/);
	assert.doesNotMatch(requested[1]!.systemPrompt, /Shell access is unavailable/);
});

test("codemode output spill remains readable during the task and is cleaned up afterward", async (t) => {
	const { faux, ctx, paths } = await workspace(t);
	let spilled = "";
	faux.setResponses([
		fauxAssistantMessage(
			fauxToolCall("codemode", { code: '// @options: {"max_output_tokens": 10}\ntext("OUTPUT_MARKER".repeat(1000));' }),
		),
		(context) => {
			const result = context.messages.at(-1) as unknown as { details: { fullOutputPath: string } };
			spilled = result.details.fullOutputPath;
			assert.ok(spilled);
			return fauxAssistantMessage(
				fauxToolCall("codemode", {
					code: `const output = await tools.read({path: ${JSON.stringify(spilled)}}); if (!output.includes("OUTPUT_MARKER")) throw Error("Output missing"); return "SPILL_READ_OK";`,
				}),
			);
		},
		(context) => {
			assert.match(JSON.stringify(context.messages.at(-1)), /SPILL_READ_OK/);
			return fauxAssistantMessage("done");
		},
	]);
	await runChildAgent({
		role: "dream",
		prompt: "check output",
		sourceMessages: [],
		systemPrompt: "system",
		config: DEFAULT_CONFIG,
		paths,
		ctx,
		codemode: { mode: "only" },
		isCurrentGeneration: () => true,
	});
	await assert.rejects(readFile(spilled));
});

test("aborting a script preserves completed memory writes and stops later calls", async (t) => {
	const { faux, ctx, paths } = await workspace(t);
	const controller = new AbortController();
	const saved = join(paths.memoryDir, "saved.md");
	const late = join(paths.memoryDir, "late.md");
	faux.setResponses([
		fauxAssistantMessage(
			fauxToolCall("codemode", {
				code: `await tools.write({path: ${JSON.stringify(saved)}, content: "saved"}); await tools.write({path: ${JSON.stringify(late)}, content: "late"});`,
			}),
		),
	]);
	const result = await runChildAgent({
		role: "extractor",
		prompt: "save",
		sourceMessages: [],
		systemPrompt: "system",
		config: DEFAULT_CONFIG,
		paths,
		ctx,
		codemode: { mode: "only" },
		signal: controller.signal,
		isCurrentGeneration: () => true,
		onTouched: () => controller.abort(),
	});
	assert.equal(result.stopReason, "aborted");
	assert.deepEqual(result.touchedPaths, ["saved.md"]);
	assert.equal(await readFile(saved, "utf8"), "saved");
	await assert.rejects(readFile(late));
});

test("codemode only rejects direct calls and rechecks generation within a script", async (t) => {
	const { faux, ctx, paths } = await workspace(t);
	let current = true;
	const target = join(paths.memoryDir, "stale.md");
	const committed = join(paths.memoryDir, "committed.md");
	faux.setResponses([
		fauxAssistantMessage(fauxToolCall("write", { path: target, content: "forbidden" })),
		(context) => {
			assert.match(JSON.stringify(context.messages.at(-1)), /not found|Unknown tool/i);
			return fauxAssistantMessage(
				fauxToolCall("codemode", {
					code: `await tools.write({path: ${JSON.stringify(committed)}, content: "saved"}); await tools.write({path: ${JSON.stringify(target)}, content: "stale"});`,
				}),
			);
		},
		(context) => {
			assert.match(JSON.stringify(context.messages.at(-1)), /stale/);
			return fauxAssistantMessage("done");
		},
	]);
	const result = await runChildAgent({
		role: "dream",
		prompt: "run checks",
		sourceMessages: [],
		systemPrompt: "system",
		config: DEFAULT_CONFIG,
		paths,
		ctx,
		codemode: { mode: "only" },
		isCurrentGeneration: () => current,
		onTouched: () => {
			current = false;
		},
	});
	assert.deepEqual(result.touchedPaths, ["committed.md"]);
	await assert.rejects(readFile(target));
});
