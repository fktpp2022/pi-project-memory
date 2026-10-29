import assert from "node:assert/strict";
import { access, chmod, mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, relative } from "node:path";
import test, { type TestContext } from "node:test";
import { type Context, normalizeContext, toToolDeclaration } from "@earendil-works/pi-ai";
import { createFauxCore, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import {
	convertToLlm,
	createReadTool,
	createWriteTool,
	type EntryRenderer,
	type ExtensionAPI,
	type ExtensionContext,
	type KeybindingsManager as ExtensionKeybindingsManager,
	type MessageRenderer,
	SessionManager,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import {
	type Component,
	type EditorComponent,
	KeybindingsManager,
	type TUI,
	TUI_KEYBINDINGS,
} from "@earendil-works/pi-tui";
import projectMemoryExtension from "../index.ts";
import { resolveProjectPaths } from "../src/paths.ts";
import { mainMemoryPrompt } from "../src/prompts.ts";
import { readState } from "../src/store.ts";
import { createTempDirectory, removeTempDirectory } from "./helpers.ts";

type Handler = (event: any, ctx: ExtensionContext) => unknown;

function fakeExtensionApi() {
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, { handler: (args: string, ctx: ExtensionContext) => unknown }>();
	const sentMessages: Array<{ message: any; options: any }> = [];
	const renderers = new Map<string, MessageRenderer>();
	const entryRenderers = new Map<string, EntryRenderer>();
	const entries: Array<{ customType: string; data: any }> = [];
	const api = {
		on(event: string, handler: Handler) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
			return () => {};
		},
		registerCommand(name: string, command: { handler: (args: string, ctx: ExtensionContext) => unknown }) {
			commands.set(name, command);
		},
		registerMessageRenderer(name: string, renderer: MessageRenderer) {
			renderers.set(name, renderer);
		},
		registerEntryRenderer(name: string, renderer: EntryRenderer) {
			entryRenderers.set(name, renderer);
		},
		getActiveTools: () => [],
		getSettings: () => ({}),
		appendEntry(customType: string, data: unknown) {
			entries.push({ customType, data });
		},
		sendMessage(message: any, options: any) {
			sentMessages.push({ message, options });
		},
	} as unknown as ExtensionAPI;
	return {
		api,
		commands,
		sentMessages,
		entries,
		entryRenderers,
		renderers,
		async emit(event: string, value: unknown, ctx: ExtensionContext) {
			if (event === "before_agent_start") value = { messageType: "user", ...(value as object) };
			let result: unknown;
			for (const handler of handlers.get(event) ?? []) result = await handler(value, ctx);
			return result;
		},
	};
}

function deferred<T = void>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	const promise = new Promise<T>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

async function eventually(predicate: () => boolean | Promise<boolean>, message: string): Promise<void> {
	const deadline = Date.now() + 5_000;
	while (Date.now() < deadline) {
		if (await predicate()) return;
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
	assert.fail(message);
}

interface MutableProjection {
	messages: any[];
	entries: any[];
}

async function createLifecycleHarness(
	t: TestContext,
	options: {
		config?: Record<string, unknown>;
		branch?: any[];
		projection?: MutableProjection;
		leafId?: string;
	} = {},
) {
	const root = await mkdtemp(join(tmpdir(), "pi-memory-lifecycle-focused-"));
	const agentDir = join(root, "agent");
	const projectRoot = join(root, "project");
	const sessionDir = join(root, "sessions");
	await Promise.all([
		mkdir(join(agentDir, "project-memory"), { recursive: true }),
		mkdir(projectRoot),
		mkdir(sessionDir),
	]);
	const configFile = join(agentDir, "project-memory", "config.json");
	await writeFile(configFile, JSON.stringify(options.config ?? {}));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	t.after(async () => {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		await removeTempDirectory(root);
	});

	const faux = createFauxCore({ models: [{ id: "lifecycle-model", reasoning: false }] });
	const notices: Array<{ message: string; level: string }> = [];
	const statusUpdates: Array<{ key: string; text: string | undefined }> = [];
	const editorSnapshots: string[] = [];
	let editorFactory: ReturnType<ExtensionContext["ui"]["getEditorComponent"]>;
	let editor: EditorComponent | undefined;
	const tui = {
		terminal: { rows: 32 },
		requestRender: () => {
			if (editor) editorSnapshots.push(editor.render(100).join("\n"));
		},
	} as unknown as TUI;
	const projection =
		options.projection ??
		({
			messages: [{ role: "user", content: "remember this durable project fact", timestamp: 1 }],
			entries: [
				{
					sourceEntry: { id: "turn-1" },
					messages: [{ role: "user", content: "remember this durable project fact", timestamp: 1 }],
				},
			],
		} satisfies MutableProjection);
	let leafId = options.leafId ?? "turn-1";
	const context = {
		cwd: projectRoot,
		hasUI: true,
		isIdle: () => true,
		isProjectTrusted: () => true,
		getSystemPrompt: () => "parent system prompt",
		model: faux.getModel(),
		modelRegistry: {
			streamSimple: faux.streamSimple,
		},
		ui: {
			notify: (message: string, level: string) => notices.push({ message, level }),
			setStatus: (key: string, text: string | undefined) => statusUpdates.push({ key, text }),
			getEditorComponent: () => editorFactory,
			setEditorComponent: (factory: typeof editorFactory) => {
				editorFactory = factory;
				editor = factory?.(
					tui,
					{
						borderColor: (text) => text,
						selectList: {
							selectedPrefix: (text: string) => text,
							selectedText: (text: string) => text,
							description: (text: string) => text,
							scrollInfo: (text: string) => text,
							noMatch: (text: string) => text,
						},
					},
					new KeybindingsManager(TUI_KEYBINDINGS) as ExtensionKeybindingsManager,
				);
			},
		},
		sessionManager: {
			getBranch: () => options.branch ?? [],
			buildSessionProjection: () => projection,
			getLeafId: () => leafId,
			getSessionDir: () => sessionDir,
			getSessionFile: () => undefined,
			getSessionId: () => "11111111-1111-4111-8111-111111111111",
			usesDefaultSessionDir: () => true,
		},
	} as unknown as ExtensionContext;
	const extension = fakeExtensionApi();
	projectMemoryExtension(extension.api);
	await extension.emit("session_start", { type: "session_start" }, context);
	const paths = await resolveProjectPaths(projectRoot);
	return {
		root,
		agentDir,
		projectRoot,
		sessionDir,
		configFile,
		faux,
		notices,
		statusUpdates,
		editorSnapshots,
		projection,
		context,
		extension,
		paths,
		setLeafId(value: string) {
			leafId = value;
		},
	};
}

function mockMemoryPanel(context: ExtensionContext, interact: (component: Component) => Promise<void> | void): void {
	context.mode = "tui";
	context.ui.custom = (factory) =>
		new Promise((resolve, reject) => {
			const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as Theme;
			const tui = { terminal: { rows: 32 }, requestRender() {} } as unknown as TUI;
			let active: (Component & { dispose?(): void }) | undefined;
			const close: typeof resolve = (value) => {
				active?.dispose?.();
				resolve(value);
			};
			void Promise.resolve(
				factory(tui, theme, new KeybindingsManager(TUI_KEYBINDINGS) as ExtensionKeybindingsManager, close),
			)
				.then(async (component) => {
					active = component;
					await interact(component);
				})
				.catch((error) => {
					active?.dispose?.();
					reject(error);
				});
		});
}

test("memory panel previews local files without charging recall or injecting context", async (t) => {
	const h = await createLifecycleHarness(t, { config: { extraction: { enabled: false }, dream: { enabled: false } } });
	await writeFile(
		join(h.paths.memoryDir, "preference.md"),
		"---\nname: preference\ndescription: Chinese typography\nmetadata:\n  type: feedback\n---\nUse readable spacing.\n",
	);
	mockMemoryPanel(h.context, async (component) => {
		const overview = component.render(100).join("\n");
		assert.match(overview, /\[Overview\]/);
		assert.match(overview, /Selector: automatic/);
		assert.match(overview, /Extractor: manual only/);
		assert.match(overview, /Dream: disabled/);
		assert.doesNotMatch(overview, /Consolidat/);
		component.handleInput?.("\t");
		assert.match(component.render(100).join("\n"), /preference.md/);
		component.handleInput?.("\r");
		await eventually(() => component.render(100).join("\n").includes("Use readable spacing."), "preview should load");
		component.handleInput?.("\u001b");
		component.handleInput?.("\t");
		const models = component.render(100).join("\n");
		assert.match(models, /Selector\s+Available/);
		assert.match(models, /Model\s+faux\/lifecycle-model/);
		assert.match(models, /Source\s+Current session/);
		assert.doesNotMatch(models, /Extraction pass:|Background usage:/);
		component.handleInput?.("\u001b");
	});
	await h.extension.commands.get("memory")?.handler("", h.context);
	assert.equal(h.extension.sentMessages.length, 0);
	h.context.mode = "rpc";
	await h.extension.commands.get("memory")?.handler("status", h.context);
	assert.match(h.notices.at(-1)?.message ?? "", /Recall: 0\/61440/);
});

test("memory panel refreshes disabled configuration without initializing memory paths", async (t) => {
	const h = await createLifecycleHarness(t, { config: { enabled: false } });
	let screens = 0;
	mockMemoryPanel(h.context, async (component) => {
		screens++;
		const screen = component.render(100).join("\n");
		assert.match(screen, /Disabled/);
		assert.doesNotMatch(screen, /Extract\s+Save durable facts|Dream\s+Merge duplicates/);
		component.handleInput?.("\u001b[B");
		component.handleInput?.("\r");
		assert.match(component.render(100).join("\n"), /Reloading configuration/);
		await eventually(
			() => component.render(100).join("\n").includes("Reloaded"),
			"reload should complete inside the same panel",
		);
		component.handleInput?.("\u001b");
	});
	await h.extension.commands.get("memory")?.handler("", h.context);
	assert.equal(screens, 1);
	assert.equal(h.notices.length, 0);
	await assert.rejects(access(h.paths.memoryDir));
});

test("manual maintenance stays in one panel and reports completion there", async (t) => {
	for (const action of ["extract", "dream"] as const) {
		const h = await createLifecycleHarness(t, {
			config: { extraction: { idleFlushSeconds: 0 }, dream: { enabled: true } },
		});
		const release = deferred();
		t.after(() => release.resolve());
		let started = false;
		let screens = 0;
		h.faux.setResponses([
			async () => {
				started = true;
				await release.promise;
				return fauxAssistantMessage("No changes needed.");
			},
		]);
		mockMemoryPanel(h.context, async (component) => {
			screens++;
			component.render(100);
			component.handleInput?.("\u001b[B");
			if (action === "dream") component.handleInput?.("\u001b[B");
			component.handleInput?.("\r");
			await eventually(() => started, "panel action should start without closing the screen");
			assert.match(component.render(100).join("\n"), action === "extract" ? /Extracting/ : /Dreaming/);
			assert.equal(h.context.ui.getEditorComponent(), undefined, "progress must not replace the open panel's editor");
			component.handleInput?.("\t");
			component.handleInput?.("\t");
			assert.match(component.render(100).join("\n"), /\[Models\]/);
			if (action === "dream") {
				for (let line = 0; line < 8; line++) component.handleInput?.("\u001b[B");
			}
			assert.match(component.render(100).join("\n"), /Activity\s+Running/);
			release.resolve();
			await eventually(
				() =>
					component
						.render(100)
						.join("\n")
						.toLowerCase()
						.includes(action === "extract" ? "extraction complete" : "dream complete"),
				"completion should appear in the same panel",
			);
			assert.match(component.render(100).join("\n"), /\[Models\]/);
			component.handleInput?.("\u001b");
		});
		await h.extension.commands.get("memory")?.handler("", h.context);
		assert.equal(screens, 1);
		assert.equal(h.notices.length, 0, "panel action results must not go into chat notifications");
	}
});

test("memory list previews reject files replaced by links outside memory", async (t) => {
	const h = await createLifecycleHarness(t, { config: { extraction: { enabled: false }, dream: { enabled: false } } });
	const file = join(h.paths.memoryDir, "replaced.md");
	const outside = join(h.root, "outside.md");
	await writeFile(file, "original memory\n");
	await writeFile(outside, "private outside content\n");
	mockMemoryPanel(h.context, async (component) => {
		assert.match(component.render(100).join("\n"), /\[Topics\]/);
		await rm(file);
		await symlink(outside, file);
		component.handleInput?.("\r");
		await eventually(
			() => component.render(100).join("\n").includes("Unable to preview"),
			"unsafe preview should fail",
		);
		assert.doesNotMatch(component.render(100).join("\n"), /private outside content/);
		component.handleInput?.("\u001b");
		component.handleInput?.("\u001b");
	});
	await h.extension.commands.get("memory")?.handler("list", h.context);
});

test("RPC memory commands keep text output and extraction explains empty input", async (t) => {
	const h = await createLifecycleHarness(t, { projection: { messages: [], entries: [] } });
	h.context.mode = "rpc";
	h.context.ui.custom = () => {
		throw new Error("RPC must not open terminal UI");
	};
	await h.extension.commands.get("memory")?.handler("", h.context);
	assert.match(h.notices.at(-1)?.message ?? "", /Topics: 0/);
	await h.extension.commands.get("memory")?.handler("extract", h.context);
	assert.match(h.notices.at(-1)?.message ?? "", /Nothing to extract/);
	await h.extension.commands.get("memory")?.handler("list", h.context);
	assert.match(h.notices.at(-1)?.message ?? "", /No memory topics/);
});

test("manual extraction reports task progress and completion even without changed files", async (t) => {
	const h = await createLifecycleHarness(t, {
		config: { extraction: { idleFlushSeconds: 0 }, dream: { enabled: false } },
	});
	h.context.mode = "tui";
	h.faux.setResponses([fauxAssistantMessage("No new memory.")]);
	await h.extension.commands.get("memory")?.handler("extract", h.context);
	assert.ok(h.editorSnapshots.some((screen) => screen.includes("Memory: Extracting")));
	assert.doesNotMatch(h.editorSnapshots.at(-1) ?? "", /Memory:/);
	assert.equal(h.statusUpdates.length, 0, "memory must not add a footer status row");
	assert.match(h.notices.at(-1)?.message ?? "", /No memory changes needed\./);
});

test("Pi lifecycle hooks honor trust, inject memory prompts, and drain shutdown", async (t) => {
	const root = await createTempDirectory(t, "pi-memory-lifecycle-");
	const agentDir = join(root, "agent");
	const projectRoot = join(root, "project");
	const sessionDir = join(root, "sessions");
	await Promise.all([
		mkdir(join(agentDir, "project-memory"), { recursive: true }),
		mkdir(projectRoot),
		mkdir(sessionDir),
	]);
	const configFile = join(agentDir, "project-memory", "config.json");
	await writeFile(
		configFile,
		JSON.stringify({ enabled: false, extraction: { enabled: false }, dream: { enabled: false } }),
	);
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	t.after(() => {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	});

	let trusted = false;
	const notices: Array<{ message: string; level: string }> = [];
	const context = {
		cwd: projectRoot,
		hasUI: true,
		isIdle: () => true,
		isProjectTrusted: () => trusted,
		ui: {
			notify: (message: string, level: string) => notices.push({ message, level }),
		},
		sessionManager: {
			getBranch: () => [],
			buildSessionProjection: () => ({ messages: [], entries: [] }),
			getLeafId: () => undefined,
			getSessionDir: () => sessionDir,
			getSessionFile: () => undefined,
			getSessionId: () => "11111111-1111-4111-8111-111111111111",
		},
	} as unknown as ExtensionContext;
	const extension = fakeExtensionApi();
	projectMemoryExtension(extension.api);

	await extension.emit("session_start", { type: "session_start" }, context);
	assert.match(notices.at(-1)?.message ?? "", /not trusted/);

	trusted = true;
	await extension.emit("session_start", { type: "session_start" }, context);
	const paths = await resolveProjectPaths(projectRoot);
	await assert.rejects(access(paths.memoryDir));
	const disabledStart = {
		prompt: "",
		systemPromptOptions: { sections: {} as Record<string, string> },
	};
	await extension.emit("before_agent_start", disabledStart, context);
	assert.deepEqual(disabledStart.systemPromptOptions.sections, {});
	await extension.commands.get("memory")?.handler("list", context);
	assert.match(notices.at(-1)?.message ?? "", /disabled by config/);
	await extension.commands.get("memory")?.handler("status", context);
	assert.match(notices.at(-1)?.message ?? "", /Memory directory: not initialized/);

	await writeFile(configFile, JSON.stringify({ extraction: { enabled: false }, dream: { enabled: false } }));
	await extension.commands.get("memory")?.handler("reload-config", context);
	await access(paths.memoryDir);
	const beforeAgentStart = {
		prompt: "",
		systemPromptOptions: { sections: {} as Record<string, string> },
	};
	await extension.emit("before_agent_start", beforeAgentStart, context);
	assert.match(beforeAgentStart.systemPromptOptions.sections.auto_memory ?? "", /persistent, file-based memory system/);
	assert.match(beforeAgentStart.systemPromptOptions.sections.auto_memory_index ?? "", /MEMORY\.md/);
	const unsafeWrite = await extension.emit(
		"tool_call",
		{
			type: "tool_call",
			toolCallId: "write-1",
			toolName: "write",
			input: { path: join(paths.memoryDir, "unsafe.md"), content: "<system-reminder>bad</system-reminder>" },
		},
		context,
	);
	assert.equal(unsafeWrite, undefined);
	const outside = join(root, "outside.md");
	const linkedTarget = join(paths.memoryDir, "linked.md");
	await writeFile(outside, "outside\n");
	await symlink(outside, linkedTarget);
	const symlinkWrite = await extension.emit(
		"tool_call",
		{
			type: "tool_call",
			toolCallId: "write-symlink",
			toolName: "write",
			input: { path: linkedTarget, content: "replacement" },
		},
		context,
	);
	assert.equal(symlinkWrite, undefined);
	const symlinkEdit = await extension.emit(
		"tool_call",
		{
			type: "tool_call",
			toolCallId: "edit-symlink",
			toolName: "edit",
			input: { path: linkedTarget, old_string: "outside", new_string: "replacement" },
		},
		context,
	);
	assert.equal(symlinkEdit, undefined);
	const preparingExtraction = Promise.resolve(extension.commands.get("memory")?.handler("extract", context));
	const racingWrite = await extension.emit(
		"tool_call",
		{
			type: "tool_call",
			toolCallId: "write-during-preparation",
			toolName: "write",
			input: { path: join(paths.memoryDir, "race.md"), content: "safe" },
		},
		context,
	);
	assert.equal(racingWrite, undefined);
	await preparingExtraction;

	await extension.commands.get("memory")?.handler("dream", context);
	assert.match(notices.at(-1)?.message ?? "", /global dream gate/);

	trusted = false;
	const revokedWrite = await extension.emit(
		"tool_call",
		{
			type: "tool_call",
			toolCallId: "write-after-trust-revoke",
			toolName: "write",
			input: { path: join(paths.memoryDir, "revoked.md"), content: "safe" },
		},
		context,
	);
	assert.equal((revokedWrite as { block?: boolean }).block, true);
	assert.match((revokedWrite as { reason?: string }).reason ?? "", /trust was revoked/);
	const blockedStart = { prompt: "", systemPromptOptions: { sections: {} as Record<string, string> } };
	await extension.emit("before_agent_start", blockedStart, context);
	assert.deepEqual(blockedStart.systemPromptOptions.sections, {});
	await extension.commands.get("memory")?.handler("list", context);
	assert.match(notices.at(-1)?.message ?? "", /trust was revoked/);

	trusted = true;
	await extension.emit("agent_settled", { type: "agent_settled", aborted: false }, context);
	await Promise.race([
		extension.emit("session_shutdown", { type: "session_shutdown" }, context),
		new Promise((_, reject) => setTimeout(() => reject(new Error("shutdown did not drain")), 1_000)),
	]);
});

test("maintenance reads current parent codemode activation and mode without changing parent tools", async (t) => {
	for (const command of ["extract", "dream"] as const) {
		await t.test(command, async (t) => {
			const harness = await createLifecycleHarness(t, { config: { dream: { enabled: command === "dream" } } });
			let activeTools = ["read", "codemode"];
			harness.extension.api.getActiveTools = () => activeTools;
			harness.extension.api.getSettings = () => ({ codemode: { mode: "only", inlineBudget: 2000 } });
			const target = join(harness.paths.memoryDir, "from-script.md");
			harness.faux.setResponses([
				(context) => {
					assert.deepEqual(
						(context as unknown as Context).tools?.map((tool) => tool.name),
						["codemode"],
					);
					return fauxAssistantMessage(
						fauxToolCall("codemode", {
							code: `await tools.write({path: ${JSON.stringify(target)}, content: "saved"});`,
						}),
					);
				},
				fauxAssistantMessage("done"),
			]);
			await harness.extension.commands.get("memory")?.handler(command, harness.context);
			assert.equal(await readFile(target, "utf8"), "saved");
			assert.deepEqual(activeTools, ["read", "codemode"]);
			activeTools = ["read"];
			const message = { role: "user", content: "another durable project preference", timestamp: 2 };
			harness.projection.messages.push(message);
			harness.projection.entries.push({ sourceEntry: { id: "next" }, messages: [message] });
			harness.setLeafId("next");
			harness.faux.setResponses([
				(context) => {
					assert.deepEqual((context as unknown as Context).tools?.map((tool) => tool.name).sort(), [
						"bash",
						"edit",
						"find",
						"grep",
						"read",
						"write",
					]);
					return fauxAssistantMessage("Nothing to save.");
				},
			]);
			await harness.extension.commands.get("memory")?.handler(command, harness.context);
			assert.deepEqual(activeTools, ["read"]);
		});
	}
});

test("manual maintenance after resume supplies memory rules without duplicating inherited rules", async (t) => {
	for (const command of ["extract", "dream"]) {
		for (const inherited of [false, true]) {
			await t.test(
				`${command}: ${inherited ? "rules already inherited" : "before the first ordinary request"}`,
				async (t) => {
					const harness = await createLifecycleHarness(t, {
						config: { extraction: { enabled: false }, dream: { enabled: command === "dream" } },
					});
					const rules = mainMemoryPrompt(harness.paths.memoryDir);
					const parent = inherited ? `parent system prompt\n\n${rules}` : "parent system prompt";
					harness.context.getSystemPrompt = () => parent;
					let systemPrompt = "";
					harness.faux.setResponses([
						(context) => {
							systemPrompt = (context as Context).systemPrompt ?? "";
							return fauxAssistantMessage("Nothing to save.");
						},
					]);

					await harness.extension.commands.get("memory")?.handler(command, harness.context);

					assert.equal(harness.faux.state.callCount, 1);
					assert.ok(systemPrompt.startsWith(`parent system prompt\n\n${rules}`));
					assert.match(systemPrompt, /Background memory task tools/);
					assert.ok(systemPrompt.includes(harness.paths.memoryDir));
					assert.match(systemPrompt, /Types of memory/);
					assert.match(systemPrompt, /frontmatter format/);
					assert.match(systemPrompt, /What NOT to save/);
				},
			);
		}
	}
});

test("a settled turn dispatches extraction and dream independently", async (t) => {
	const harness = await createLifecycleHarness(t, {
		config: {
			extraction: { everyNTurns: 1, idleFlushSeconds: 0 },
			dream: { minimumHours: 1, minimumOtherSessions: 1, scanThrottleSeconds: 0 },
		},
	});
	await writeFile(
		join(harness.sessionDir, "other.jsonl"),
		`${JSON.stringify({ type: "session", id: "other-session", cwd: harness.projectRoot })}\n`,
	);
	const extraction = deferred();
	const dream = deferred();
	const started = new Set<string>();
	const response = async (context: any) => {
		const prompt = JSON.stringify(context.messages.at(-1));
		const role = prompt.includes("Phase 1") ? "dream" : "extractor";
		started.add(role);
		await (role === "dream" ? dream.promise : extraction.promise);
		return fauxAssistantMessage(`${role} complete`);
	};
	harness.faux.setResponses([response, response]);

	await harness.extension.emit("agent_settled", { type: "agent_settled", aborted: false }, harness.context);
	await eventually(() => started.size === 2, "extraction and dream did not both start");
	assert.deepEqual([...started].sort(), ["dream", "extractor"]);

	extraction.resolve();
	dream.resolve();
	await harness.extension.emit("session_shutdown", { type: "session_shutdown" }, harness.context);
	assert.equal(harness.faux.state.callCount, 2);
});

test("invalid dream state stops scheduling and reports the failure without changing state", async (t) => {
	const harness = await createLifecycleHarness(t, {
		config: { extraction: { enabled: false }, dream: { minimumHours: 0, minimumOtherSessions: 0 } },
	});
	const stateFile = harness.paths.dreamStateFile ?? harness.paths.stateFile;
	const invalid = '{"schemaVersion":2,"lastDreamAt":1}';
	await writeFile(stateFile, invalid);
	let calls = 0;
	harness.faux.setResponses([
		() => {
			calls++;
			return fauxAssistantMessage("unexpected");
		},
	]);
	await harness.extension.emit("agent_settled", { aborted: false }, harness.context);
	await eventually(
		() => harness.notices.some((notice) => notice.message.includes("Invalid dream state")),
		"dream state failure was not reported",
	);
	assert.equal(calls, 0);
	assert.equal(await readFile(stateFile, "utf8"), invalid);
});

test("synthetic summaries alone do not trigger extraction", async (t) => {
	const harness = await createLifecycleHarness(t, {
		config: { extraction: { everyNTurns: 1, idleFlushSeconds: 0 }, dream: { enabled: false } },
	});
	harness.projection.messages = [
		{ role: "compactionSummary", summary: "remember this historical fact", tokensBefore: 100, timestamp: 1 },
	];
	harness.projection.entries = [{ sourceEntry: { id: "summary" }, messages: harness.projection.messages }];
	harness.setLeafId("summary");
	let calls = 0;
	harness.faux.setResponses([
		() => {
			calls++;
			return fauxAssistantMessage("unexpected");
		},
	]);
	await harness.extension.emit("session_shutdown", {}, harness.context);
	assert.equal(calls, 0);
});

test("real Pi compaction retains consumed memory writes without skipping subsequent user input", async (t) => {
	for (const trigger of ["agent_settled", "session_shutdown"] as const) {
		await t.test(trigger, async (t) => {
			const harness = await createLifecycleHarness(t, {
				config: { extraction: { everyNTurns: 1, idleFlushSeconds: 0 }, dream: { enabled: false } },
			});
			const manager = SessionManager.inMemory(harness.projectRoot);
			(harness.context as any).sessionManager = manager;
			const first = manager.appendMessage({ role: "user", content: "old durable user fact", timestamp: 1 });
			manager.appendMessage(
				fauxAssistantMessage(
					fauxToolCall(
						"write",
						{
							path: join(harness.paths.memoryDir, "old.md"),
							content: "old fact",
						},
						{ id: "old-write" },
					),
					{ stopReason: "toolUse" },
				),
			);
			manager.appendMessage({
				role: "toolResult",
				toolCallId: "old-write",
				toolName: "write",
				content: [{ type: "text", text: "written" }],
				isError: false,
				timestamp: 2,
			});
			await harness.extension.emit("session_before_compact", {}, harness.context);
			manager.appendCompaction("previous durable history", first, 100);
			assert.equal(manager.buildSessionProjection().messages[0]?.role, "compactionSummary");
			await harness.extension.emit("session_compact", {}, harness.context);
			// Even an empty extraction check must keep the consumed projection boundary.
			await harness.extension.commands.get("memory")?.handler("extract", harness.context);
			manager.appendMessage({ role: "user", content: "new durable user fact", timestamp: 3 });
			const captured: any[] = [];
			harness.faux.setResponses([
				(context) => {
					captured.push(context.messages);
					return fauxAssistantMessage("extracted");
				},
			]);
			await harness.extension.emit(trigger, { aborted: false }, harness.context);
			if (trigger === "agent_settled") await harness.extension.emit("session_shutdown", {}, harness.context);
			assert.equal(captured.length, 1);
			assert.match(JSON.stringify(captured), /new durable user fact/);
			assert.doesNotMatch(JSON.stringify(captured), /old-write|old durable user fact/);
		});
	}
});

test("compaction waits for extraction preparation and applies only successful compact events", async (t) => {
	const harness = await createLifecycleHarness(t, {
		config: {
			extraction: { everyNTurns: 1, idleFlushSeconds: 0 },
			dream: { enabled: false },
		},
	});
	const extraction = deferred();
	let extractionStarted = false;
	harness.faux.setResponses([
		async () => {
			extractionStarted = true;
			await extraction.promise;
			return fauxAssistantMessage("initial extraction complete");
		},
	]);
	await harness.extension.emit("agent_settled", { type: "agent_settled", aborted: false }, harness.context);
	await eventually(() => extractionStarted, "settled extraction did not start");

	let preparationFinished = false;
	const preparation = harness.extension
		.emit("session_before_compact", { type: "session_before_compact" }, harness.context)
		.then(() => {
			preparationFinished = true;
		});
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(preparationFinished, false);
	extraction.resolve();
	await preparation;

	// A failed compaction must clear the prepared outcome, so a later compact
	// event cannot move the cursor to a transcript entry that was never adopted.
	harness.setLeafId("failed-compact");
	await harness.extension.emit("session_compact_failed", { type: "session_compact_failed" }, harness.context);
	await harness.extension.emit("session_compact", { type: "session_compact" }, harness.context);
	harness.projection.messages = [
		{ role: "user", content: "remember this durable project fact", timestamp: 1 },
		{ role: "user", content: "compaction summary still has prose", timestamp: 2 },
		{ role: "user", content: "new durable fact after failed compact", timestamp: 3 },
	];
	harness.projection.entries = [
		{ sourceEntry: { id: "turn-1" }, messages: [harness.projection.messages[0]] },
		{ sourceEntry: { id: "failed-compact" }, messages: [harness.projection.messages[1]] },
		{ sourceEntry: { id: "turn-2" }, messages: [harness.projection.messages[2]] },
	];
	harness.setLeafId("turn-2");
	let failedCompactPrompt = "";
	let replayedTranscript: any[] = [];
	harness.faux.setResponses([
		(context) => {
			failedCompactPrompt = JSON.stringify(context.messages.at(-1));
			replayedTranscript = context.messages;
			return fauxAssistantMessage("retry complete");
		},
	]);
	await harness.extension.commands.get("memory")?.handler("extract", harness.context);
	assert.match(failedCompactPrompt, /most recent ~2 messages/);
	assert.doesNotMatch(JSON.stringify(replayedTranscript), /remember this durable project fact/);
	assert.match(JSON.stringify(replayedTranscript), /new durable fact after failed compact/);

	// Adopt the projection before notifying extensions of successful compaction.
	await harness.extension.emit("session_before_compact", { type: "session_before_compact" }, harness.context);
	harness.setLeafId("successful-compact");
	harness.projection.messages = [{ role: "user", content: "the compacted transcript summary", timestamp: 3 }];
	harness.projection.entries = [{ sourceEntry: { id: "successful-compact" }, messages: harness.projection.messages }];
	await harness.extension.emit("session_compact", { type: "session_compact" }, harness.context);
	const afterCompact = { role: "user", content: "one new fact after successful compact", timestamp: 4 };
	harness.projection.messages = [
		{ role: "user", content: "the compacted transcript summary", timestamp: 3 },
		afterCompact,
	];
	harness.projection.entries = [
		{ sourceEntry: { id: "successful-compact" }, messages: [harness.projection.messages[0]] },
		{ sourceEntry: { id: "turn-3" }, messages: [afterCompact] },
	];
	harness.setLeafId("turn-3");
	let successfulCompactPrompt = "";
	harness.faux.setResponses([
		(context) => {
			successfulCompactPrompt = JSON.stringify(context.messages.at(-1));
			return fauxAssistantMessage("post-compact extraction complete");
		},
	]);
	await harness.extension.commands.get("memory")?.handler("extract", harness.context);
	assert.match(successfulCompactPrompt, /most recent ~1 messages/);
});

test("tree navigation restores recall budget from the destination branch", async (t) => {
	const branch = [
		{
			type: "custom_message",
			customType: "pi-project-memory-recall",
			content: "old branch",
			details: { memories: [{ path: "old.md", mtimeMs: 1, chars: 61_440 }] },
		},
	];
	const harness = await createLifecycleHarness(t, {
		branch,
		config: { extraction: { enabled: false }, dream: { enabled: false } },
	});
	await writeFile(join(harness.paths.memoryDir, "fresh.md"), "---\ndescription: fresh topic\n---\nfresh fact\n");
	branch.splice(0);
	await harness.extension.emit(
		"session_tree",
		{ type: "session_tree", newLeafId: "fresh", oldLeafId: "old" },
		harness.context,
	);
	harness.faux.setResponses([
		fauxAssistantMessage(fauxToolCall("select_memories", { selected_memories: ["fresh.md"] })),
	]);
	const result = (await harness.extension.emit(
		"before_agent_start",
		{ prompt: "fresh topic", systemPromptOptions: { sections: {} } },
		harness.context,
	)) as any;
	assert.match(result.message.content, /fresh fact/);
});

test("successful compaction resets recall state even when extraction is disabled", async (t) => {
	const branch = [
		{
			type: "custom_message",
			customType: "pi-project-memory-recall",
			content: "old recalled attachment",
			details: { recallChars: 61_440, memories: [{ path: "topic.md", mtimeMs: 1, chars: 61_440 }] },
		},
	];
	const harness = await createLifecycleHarness(t, {
		branch,
		config: { extraction: { enabled: false }, dream: { enabled: false } },
	});
	await writeFile(join(harness.paths.memoryDir, "topic.md"), "---\ndescription: current topic\n---\ncurrent fact\n");
	await harness.extension.emit("session_before_compact", { type: "session_before_compact" }, harness.context);
	await harness.extension.emit("session_compact", { type: "session_compact" }, harness.context);
	harness.faux.setResponses([
		fauxAssistantMessage(fauxToolCall("select_memories", { selected_memories: ["topic.md"] })),
	]);
	const result = (await harness.extension.emit(
		"before_agent_start",
		{ prompt: "recall the current topic", systemPromptOptions: { sections: {} } },
		harness.context,
	)) as any;
	assert.match(result.message.content, /current fact/);
	assert.equal(harness.faux.state.callCount, 1);
});

test("recall prefetch waits two seconds, then delivers a late Pi steering message once", async (t) => {
	const harness = await createLifecycleHarness(t, {
		config: { extraction: { enabled: false }, dream: { enabled: false } },
	});
	await writeFile(join(harness.paths.memoryDir, "late.md"), "---\ndescription: late topic\n---\nlate fact\n");
	const selector = deferred<any>();
	harness.faux.setResponses([async () => selector.promise]);
	await harness.extension.emit(
		"input",
		{ type: "input", text: "raw input handled locally", source: "interactive" },
		harness.context,
	);
	assert.equal(harness.faux.state.callCount, 0);
	const start = { prompt: "recall the late topic", systemPromptOptions: { sections: {} as Record<string, string> } };
	const waitStartedAt = Date.now();
	const initial = await harness.extension.emit("before_agent_start", start, harness.context);
	assert.ok(Date.now() - waitStartedAt >= 1_900, "accepted input did not receive its recall wait");
	assert.ok(Date.now() - waitStartedAt < 3_000, "recall exceeded its two-second deadline");
	assert.equal(initial, undefined);
	assert.equal(harness.extension.sentMessages.length, 0);
	selector.resolve(fauxAssistantMessage(fauxToolCall("select_memories", { selected_memories: ["late.md"] })));
	await eventually(() => harness.extension.sentMessages.length === 1, "late recall was not delivered");
	const sent = harness.extension.sentMessages[0]!;
	assert.equal(sent.message.customType, "pi-project-memory-recall");
	assert.equal(sent.message.display, true);
	assert.ok(harness.extension.renderers.has(sent.message.customType));
	assert.match(sent.message.content, /late fact/);
	assert.deepEqual(sent.options, { deliverAs: "steer" });
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(harness.extension.sentMessages.length, 1);
});

test("delayed recall excludes memories fully read while selection is pending without charging them", async (t) => {
	for (const allLoaded of [false, true]) {
		await t.test(
			allLoaded ? "all selected files already loaded" : "late steering retains only unread files",
			async (t) => {
				const harness = await createLifecycleHarness(t, {
					config: { extraction: { enabled: false }, dream: { enabled: false } },
				});
				const loadedPath = join(harness.paths.memoryDir, "loaded.md");
				const loadedContent = "---\ndescription: loaded topic\n---\nalready loaded fact\n";
				const unreadContent = "---\ndescription: unread topic\n---\nstill unread fact\n";
				await Promise.all([
					writeFile(loadedPath, loadedContent),
					writeFile(join(harness.paths.memoryDir, "unread.md"), unreadContent),
				]);
				const selector = deferred<any>();
				harness.faux.setResponses([async () => selector.promise]);
				// A queued message delivers asynchronously; an ordinary request awaits
				// consumption so the all-filtered case can assert no message is produced.
				const pending = allLoaded
					? harness.extension.emit(
							"before_agent_start",
							{ prompt: "recall the loaded topic", systemPromptOptions: { sections: {} } },
							harness.context,
						)
					: harness.extension.emit(
							"message_end",
							{ type: "message_end", message: { role: "user", content: "recall these topics", timestamp: 2 } },
							harness.context,
						);
				await eventually(() => harness.faux.state.callCount === 1, "selector did not start");
				await harness.extension.emit(
					"tool_call",
					{ type: "tool_call", toolCallId: "pending-read", toolName: "read", input: { path: loadedPath } },
					harness.context,
				);
				await harness.extension.emit(
					"tool_result",
					{
						type: "tool_result",
						toolCallId: "pending-read",
						toolName: "read",
						input: { path: loadedPath },
						content: [{ type: "text", text: loadedContent }],
						isError: false,
					},
					harness.context,
				);
				selector.resolve(
					fauxAssistantMessage(
						fauxToolCall("select_memories", {
							selected_memories: allLoaded ? ["loaded.md"] : ["loaded.md", "unread.md"],
						}),
					),
				);
				assert.equal(await pending, undefined);
				let charged = 0;
				if (!allLoaded) {
					await eventually(() => harness.extension.sentMessages.length === 1, "unread memory was not delivered");
					const sent = harness.extension.sentMessages[0]!;
					assert.deepEqual(sent.message.details.files, ["unread.md"]);
					assert.deepEqual(sent.options, { deliverAs: "steer" });
					assert.doesNotMatch(sent.message.content, /already loaded fact/);
					assert.match(sent.message.content, /still unread fact/);
					charged = sent.message.details.memories[0].chars;
					assert.equal(sent.message.details.recallChars, charged);
				} else {
					assert.equal(harness.extension.sentMessages.length, 0);
				}
				await harness.extension.commands.get("memory")?.handler("status", harness.context);
				assert.match(harness.notices.at(-1)?.message ?? "", new RegExp(`Recall: ${charged}/61440 characters`));
			},
		);
	}
});

test("accepted streaming user messages deliver recall without a before_agent_start hook", async (t) => {
	const harness = await createLifecycleHarness(t, {
		config: { extraction: { enabled: false }, dream: { enabled: false } },
	});
	await writeFile(join(harness.paths.memoryDir, "queued.md"), "---\ndescription: queued topic\n---\nqueued fact\n");
	const selector = deferred<any>();
	harness.faux.setResponses([async () => selector.promise]);
	await harness.extension.emit(
		"message_end",
		{ type: "message_end", message: { role: "user", content: "queued topic", timestamp: 2 } },
		harness.context,
	);
	selector.resolve(fauxAssistantMessage(fauxToolCall("select_memories", { selected_memories: ["queued.md"] })));
	await eventually(() => harness.extension.sentMessages.length === 1, "streaming recall was not delivered");
	assert.match(harness.extension.sentMessages[0]!.message.content, /queued fact/);
	assert.deepEqual(harness.extension.sentMessages[0]!.options, { deliverAs: "steer" });
});

test("a newer input cancels an older recall prefetch without late delivery", async (t) => {
	const harness = await createLifecycleHarness(t, {
		config: { extraction: { enabled: false }, dream: { enabled: false } },
	});
	await Promise.all([
		writeFile(join(harness.paths.memoryDir, "first.md"), "---\ndescription: first topic\n---\nfirst fact\n"),
		writeFile(join(harness.paths.memoryDir, "second.md"), "---\ndescription: second topic\n---\nsecond fact\n"),
	]);
	const first = deferred<any>();
	const second = deferred<any>();
	harness.faux.setResponses([async () => first.promise, async () => second.promise]);
	await harness.extension.emit(
		"message_end",
		{ type: "message_end", message: { role: "user", content: "first topic", timestamp: 1 } },
		harness.context,
	);
	await eventually(() => harness.faux.state.callCount === 1, "first selector did not start");
	await harness.extension.emit(
		"message_end",
		{ type: "message_end", message: { role: "user", content: "second topic", timestamp: 2 } },
		harness.context,
	);
	await eventually(() => harness.faux.state.callCount === 2, "second selector did not start");
	second.resolve(fauxAssistantMessage(fauxToolCall("select_memories", { selected_memories: ["second.md"] })));
	await eventually(() => harness.extension.sentMessages.length === 1, "second recall was not delivered");
	const result = harness.extension.sentMessages[0]!;
	assert.match(result.message.content, /second fact/);
	first.resolve(fauxAssistantMessage(fauxToolCall("select_memories", { selected_memories: ["first.md"] })));
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(harness.extension.sentMessages.length, 1);
	assert.doesNotMatch(result.message.content, /first fact/);
});

test("newer user input preserves local extractor writes and queues the newer transcript", async (t) => {
	const harness = await createLifecycleHarness(t, {
		config: { extraction: { idleFlushSeconds: 0, maxTurns: 3 }, dream: { enabled: false } },
	});
	const target = join(harness.paths.memoryDir, "stale.md");
	const releaseResponse = deferred();
	let childStarted = false;
	let trailingMessages: any[] = [];
	harness.faux.setResponses([
		async () => {
			childStarted = true;
			await releaseResponse.promise;
			return fauxAssistantMessage(fauxToolCall("write", { path: target, content: "stale write\n" }), {
				stopReason: "toolUse",
			});
		},
		fauxAssistantMessage("old extraction stopped writing"),
		(context) => {
			trailingMessages = context.messages;
			return fauxAssistantMessage("trailing extraction complete");
		},
	]);
	const extraction = Promise.resolve(harness.extension.commands.get("memory")?.handler("extract", harness.context));
	await eventually(() => childStarted, "extractor did not start");
	const newerMessage = { role: "user", content: "a newer durable project fact", timestamp: 2 } as const;
	harness.projection.messages.push(newerMessage);
	harness.projection.entries.push({ sourceEntry: { id: "turn-2" }, messages: [newerMessage] });
	harness.setLeafId("turn-2");
	await harness.extension.emit("message_end", { type: "message_end", message: newerMessage }, harness.context);
	releaseResponse.resolve();
	await extraction;
	assert.equal(await readFile(target, "utf8"), "stale write\n");
	assert.match(JSON.stringify(trailingMessages.at(-1)), /most recent ~1 messages/);
	assert.match(JSON.stringify(trailingMessages), /newer durable project fact/);
	assert.doesNotMatch(JSON.stringify(trailingMessages), /remember this durable project fact/);
});

test("newer user input preserves dream writes and its cadence reservation", async (t) => {
	const harness = await createLifecycleHarness(t, {
		config: { extraction: { enabled: false }, dream: { enabled: true, maxTurns: 3 } },
	});
	const target = join(harness.paths.memoryDir, "stale-dream.md");
	const releaseResponse = deferred();
	let childStarted = false;
	harness.faux.setResponses([
		async () => {
			childStarted = true;
			await releaseResponse.promise;
			return fauxAssistantMessage(fauxToolCall("write", { path: target, content: "stale dream write\n" }), {
				stopReason: "toolUse",
			});
		},
		fauxAssistantMessage("dream stopped writing"),
	]);
	const dream = Promise.resolve(harness.extension.commands.get("memory")?.handler("dream", harness.context));
	await eventually(() => childStarted, "dream did not start");
	await harness.extension.emit(
		"message_end",
		{ type: "message_end", message: { role: "user", content: "a newer user request", timestamp: 2 } },
		harness.context,
	);
	releaseResponse.resolve();
	await dream;
	assert.equal(await readFile(target, "utf8"), "stale dream write\n");
	assert.ok((await readState(harness.paths)).lastDreamAt > 0);
});

test("reload invalidates an active maintenance child", async (t) => {
	const harness = await createLifecycleHarness(t, {
		config: { extraction: { idleFlushSeconds: 0 }, dream: { enabled: false } },
	});
	harness.context.mode = "tui";
	let childStarted = false;
	let childAborted = false;
	harness.faux.setResponses([
		(_context, options) =>
			new Promise((resolve) => {
				childStarted = true;
				const signal = options?.signal;
				assert.ok(signal);
				signal.addEventListener(
					"abort",
					() => {
						childAborted = true;
						resolve(fauxAssistantMessage("stale child response"));
					},
					{ once: true },
				);
			}),
	]);
	const extraction = Promise.resolve(harness.extension.commands.get("memory")?.handler("extract", harness.context));
	await eventually(() => childStarted, "manual extraction did not start");
	await writeFile(
		harness.configFile,
		JSON.stringify({ extraction: { idleFlushSeconds: 0 }, dream: { enabled: false } }),
	);
	await harness.extension.commands.get("memory")?.handler("reload-config", harness.context);
	await extraction;
	assert.equal(childAborted, true);
	assert.doesNotMatch(harness.editorSnapshots.at(-1) ?? "", /Memory:/, "reload must clear the cancelled task status");
	assert.equal(harness.statusUpdates.length, 0);

	await writeFile(harness.configFile, "{");
	await harness.extension.commands.get("memory")?.handler("reload-config", harness.context);
	assert.match(harness.notices.at(-1)?.message ?? "", /Failed to read/);
	const stillEnabled = { prompt: "", systemPromptOptions: { sections: {} as Record<string, string> } };
	await harness.extension.emit("before_agent_start", stillEnabled, harness.context);
	assert.match(stillEnabled.systemPromptOptions.sections.auto_memory ?? "", /persistent, file-based memory system/);

	const nextRoot = join(harness.root, "next-memory-root");
	await writeFile(
		harness.configFile,
		JSON.stringify({ autoMemoryDirectory: nextRoot, extraction: { idleFlushSeconds: 0 }, dream: { enabled: false } }),
	);
	await harness.extension.commands.get("memory")?.handler("reload-config", harness.context);
	assert.match(harness.notices.at(-1)?.message ?? "", /changes apply after the next session start/);

	const start = { prompt: "", systemPromptOptions: { sections: {} as Record<string, string> } };
	const result = await harness.extension.emit("before_agent_start", start, harness.context);
	assert.equal(result, undefined);
});

test("disabled to enabled reload defers a changed memory root until session start", async (t) => {
	const harness = await createLifecycleHarness(t, {
		config: { enabled: false, extraction: { enabled: false }, dream: { enabled: false } },
	});
	const nextRoot = join(harness.root, "enabled-memory-root");
	await writeFile(
		harness.configFile,
		JSON.stringify({
			enabled: true,
			autoMemoryDirectory: nextRoot,
			extraction: { enabled: false },
			dream: { enabled: false },
		}),
	);
	await harness.extension.commands.get("memory")?.handler("reload-config", harness.context);
	await assert.rejects(access(nextRoot));
	assert.match(harness.notices.at(-1)?.message ?? "", /next session/);
	const start = { prompt: "", systemPromptOptions: { sections: {} as Record<string, string> } };
	await harness.extension.emit("before_agent_start", start, harness.context);
	assert.ok(!(start.systemPromptOptions.sections.auto_memory ?? "").includes(nextRoot));
	await harness.extension.emit("session_start", { type: "session_start" }, harness.context);
	await access(nextRoot);
});

test("recall budget is restored cumulatively from transcript entries", async (t) => {
	const branch = [
		{
			type: "custom_message",
			customType: "pi-project-memory-recall",
			content: "first recalled attachment",
			details: { recallChars: 60_000, memories: [{ path: "first.md", mtimeMs: 1, chars: 30_000 }] },
		},
		{
			type: "custom_message",
			customType: "pi-project-memory-recall",
			content: "second recalled attachment",
			details: {
				memories: [
					{ path: "second.md", mtimeMs: 2, chars: 20_000 },
					{ path: "legacy.md", mtimeMs: 3, bytes: 12_000 },
				],
			},
		},
	];
	const harness = await createLifecycleHarness(t, {
		branch,
		config: { extraction: { enabled: false }, dream: { enabled: false } },
	});
	await writeFile(join(harness.paths.memoryDir, "unseen.md"), "---\ndescription: unseen\n---\nnot selected\n");
	const start = {
		prompt: "find a relevant project memory",
		systemPromptOptions: { sections: {} as Record<string, string> },
	};
	const result = await harness.extension.emit("before_agent_start", start, harness.context);
	assert.equal(result, undefined);
	assert.equal(harness.faux.state.callCount, 0);
	await harness.extension.commands.get("memory")?.handler("status", harness.context);
	assert.match(harness.notices.at(-1)?.message ?? "", /Recall: 62000\/61440 characters/);
});

test("recall accounting includes the truncation notice", async (t) => {
	const harness = await createLifecycleHarness(t, {
		config: { extraction: { enabled: false }, dream: { enabled: false } },
	});
	const topicPath = join(harness.paths.memoryDir, "truncated.md");
	await writeFile(
		topicPath,
		`---\ndescription: truncated topic\n---\n${Array.from({ length: 220 }, (_, index) => `line-${index}`).join("\n")}`,
	);
	harness.faux.setResponses([
		fauxAssistantMessage(fauxToolCall("select_memories", { selected_memories: ["truncated.md"] })),
	]);
	const result = (await harness.extension.emit(
		"before_agent_start",
		{ prompt: "recall the truncated topic", systemPromptOptions: { sections: {} } },
		harness.context,
	)) as any;
	assert.match(result.message.content, /first 200 lines/);
	const body =
		/Memory: [^\n]+:\n\n([\s\S]*?)\n\n> This memory file was truncated/.exec(result.message.content)?.[1] ?? "";
	assert.ok(result.message.details.recallChars > body.length);
	assert.equal(result.message.details.recallChars, result.message.details.memories[0].chars);
	await harness.extension.commands.get("memory")?.handler("status", harness.context);
	assert.match(harness.notices.at(-1)?.message ?? "", /Background usage: selector [1-9]\d* tokens/);
});

test("a full Read suppresses recall while a partial Read remains eligible", async (t) => {
	const harness = await createLifecycleHarness(t, {
		config: { extraction: { enabled: false }, dream: { enabled: false } },
	});
	const fullPath = join(harness.paths.memoryDir, "full.md");
	const partialPath = join(harness.paths.memoryDir, "partial.md");
	const offsetPath = join(harness.paths.memoryDir, "offset.md");
	await Promise.all([
		writeFile(fullPath, "---\ndescription: full topic\n---\nfull contents\n"),
		writeFile(partialPath, "---\ndescription: partial topic\n---\npartial contents\n"),
		writeFile(offsetPath, "---\ndescription: offset topic\n---\noffset contents\n"),
	]);
	const readResult = (filePath: string, partial: boolean) => ({
		type: "tool_result",
		toolCallId: partial ? "partial-read" : "full-read",
		toolName: "read",
		input: { path: filePath },
		content: [{ type: "text", text: partial ? "partial contents\n[Read partial; total 4 lines.]" : "full contents" }],
		details: partial ? { truncation: { truncated: true } } : undefined,
		isError: false,
	});
	for (const event of [readResult(fullPath, false), readResult(partialPath, true)]) {
		await harness.extension.emit(
			"tool_call",
			{ type: "tool_call", toolCallId: event.toolCallId, toolName: "read", input: event.input },
			harness.context,
		);
		await harness.extension.emit("tool_result", event, harness.context);
	}
	await harness.extension.emit(
		"tool_call",
		{ type: "tool_call", toolCallId: "offset-read", toolName: "read", input: { path: offsetPath, offset: 2 } },
		harness.context,
	);
	await harness.extension.emit(
		"tool_result",
		{
			...readResult(offsetPath, false),
			toolCallId: "offset-read",
			input: { path: offsetPath, offset: 2 },
		},
		harness.context,
	);
	harness.faux.setResponses([
		fauxAssistantMessage(
			fauxToolCall("select_memories", { selected_memories: ["partial.md", "offset.md", "full.md"] }),
		),
	]);
	const start = {
		prompt: "which topic contents are relevant",
		systemPromptOptions: { sections: {} as Record<string, string> },
	};
	const result = (await harness.extension.emit("before_agent_start", start, harness.context)) as any;
	assert.deepEqual(result.message.details.files, ["partial.md", "offset.md"]);
	assert.match(result.message.content, /partial contents/);
	assert.match(result.message.content, /offset contents/);
	assert.doesNotMatch(result.message.content, /full contents/);
});

test("navigation and session restoration rebuild complete Read suppression from the active branch", async (t) => {
	for (const hook of ["session_tree", "session_start"]) {
		await t.test(hook, async (t) => {
			const branch: any[] = [];
			const harness = await createLifecycleHarness(t, {
				branch,
				config: { extraction: { enabled: false }, dream: { enabled: false } },
			});
			await mkdir(join(harness.paths.memoryDir, "nested"));
			for (const name of ["nested/full", "partial", "offset", "failed", "changed"]) {
				const path = join(harness.paths.memoryDir, `${name}.md`);
				const content = `---\ndescription: ${name} topic\n---\n${name} fact\n`;
				await writeFile(path, content);
				if (name === "nested/full") {
					const old = new Date(Date.now() - 3 * 86_400_000);
					await utimes(path, old, old);
				}
				const input = {
					path: relative(harness.projectRoot, path),
					...(name === "offset" ? { offset: 2 } : { offset: 1, limit: 20 }),
				};
				const call = fauxToolCall("read", input);
				const message = {
					role: "toolResult",
					toolCallId: call.id,
					toolName: "read",
					content: [
						{
							type: "text",
							text: name === "partial" ? "first page\n[4 more lines in file. Use offset=2 to continue.]" : content,
						},
					],
					isError: name === "failed",
					timestamp: 2,
				};
				await harness.extension.emit(
					"tool_call",
					{ type: "tool_call", toolCallId: call.id, toolName: "read", input },
					harness.context,
				);
				const result = (await harness.extension.emit(
					"tool_result",
					{ ...message, type: "tool_result", input },
					harness.context,
				)) as any;
				branch.push(
					{ type: "message", message: fauxAssistantMessage(call) },
					{ type: "message", message: { ...message, content: result?.content ?? message.content } },
				);
				if (name === "changed") await writeFile(path, `${content}changed after the Read\n`);
			}

			const selected = ["nested/full.md", "partial.md", "offset.md", "failed.md", "changed.md"];
			const expected = selected.slice(1);
			harness.faux.setResponses([
				fauxAssistantMessage(fauxToolCall("select_memories", { selected_memories: selected })),
				fauxAssistantMessage(fauxToolCall("select_memories", { selected_memories: selected })),
				fauxAssistantMessage(fauxToolCall("select_memories", { selected_memories: ["nested/full.md"] })),
			]);
			const start = () =>
				harness.extension.emit(
					"before_agent_start",
					{ prompt: "recall these topics", systemPromptOptions: { sections: {} } },
					harness.context,
				) as Promise<any>;
			assert.deepEqual((await start()).message.details.files, expected);

			await harness.extension.emit(hook, { type: hook }, harness.context);
			assert.deepEqual((await start()).message.details.files, expected);
			assert.equal(harness.faux.state.callCount, 2);

			// Reads outside the destination branch cannot suppress its recall.
			branch.length = 0;
			await harness.extension.emit("session_tree", { type: "session_tree" }, harness.context);
			assert.deepEqual((await start()).message.details.files, ["nested/full.md"]);
		});
	}
});

test("restoration does not reuse complete Reads discarded by compaction", async (t) => {
	const branch: any[] = [];
	const harness = await createLifecycleHarness(t, {
		branch,
		config: { extraction: { enabled: false }, dream: { enabled: false } },
	});
	const path = join(harness.paths.memoryDir, "compacted.md");
	const content = "---\ndescription: compacted topic\n---\ncompacted fact\n";
	await writeFile(path, content);
	const call = fauxToolCall("read", { path });
	branch.push(
		{ type: "message", message: fauxAssistantMessage(call) },
		{
			type: "message",
			message: {
				role: "toolResult",
				toolName: "read",
				toolCallId: call.id,
				content: [{ type: "text", text: content }],
				isError: false,
			},
		},
		{ type: "compaction" },
	);
	await harness.extension.emit("session_start", { type: "session_start" }, harness.context);
	harness.faux.setResponses([
		fauxAssistantMessage(fauxToolCall("select_memories", { selected_memories: ["compacted.md"] })),
	]);
	const result = (await harness.extension.emit(
		"before_agent_start",
		{ prompt: "recall the compacted topic", systemPromptOptions: { sections: {} } },
		harness.context,
	)) as any;
	assert.deepEqual(result.message.details.files, ["compacted.md"]);
});

test("an old memory Read gets an immediate stale reminder and preserves structured content", async (t) => {
	const harness = await createLifecycleHarness(t, {
		config: { extraction: { enabled: false }, dream: { enabled: false } },
	});
	const topicPath = join(harness.paths.memoryDir, "old.md");
	const content = "---\ndescription: old topic\n---\nold fact\n";
	await writeFile(topicPath, content);
	const old = new Date(Date.now() - 3 * 86_400_000);
	await utimes(topicPath, old, old);
	await harness.extension.emit(
		"tool_call",
		{ type: "tool_call", toolCallId: "old-read", toolName: "read", input: { path: topicPath } },
		harness.context,
	);
	const structuredContent = { path: topicPath, truncated: false };
	const result = (await harness.extension.emit(
		"tool_result",
		{
			type: "tool_result",
			toolCallId: "old-read",
			toolName: "read",
			input: { path: topicPath },
			content: [{ type: "text", text: content }],
			structuredContent,
			isError: false,
		},
		harness.context,
	)) as any;
	assert.match(result.content[0].text, /This memory is 3 days old/);
	assert.match(result.content[0].text, /old fact/);
	assert.deepEqual(result.structuredContent, structuredContent);
});

test("a successful memory Write gets an immediate lint reminder", async (t) => {
	const harness = await createLifecycleHarness(t, {
		config: { extraction: { enabled: false }, dream: { enabled: false } },
	});
	const topicPath = join(harness.paths.memoryDir, "missing-description.md");
	const content = "memory without frontmatter\n";
	await harness.extension.emit(
		"tool_call",
		{ type: "tool_call", toolCallId: "lint-write", toolName: "write", input: { path: topicPath, content } },
		harness.context,
	);
	await writeFile(topicPath, content);
	const result = (await harness.extension.emit(
		"tool_result",
		{
			type: "tool_result",
			toolCallId: "lint-write",
			toolName: "write",
			input: { path: topicPath, content },
			content: [{ type: "text", text: "Wrote file" }],
			isError: false,
		},
		harness.context,
	)) as any;
	assert.match(result.content[0].text, /Wrote file/);
	assert.match(result.content[0].text, /has no frontmatter description/);
	assert.equal(
		await harness.extension.emit("agent_before_settle", { type: "agent_before_settle" }, harness.context),
		undefined,
	);
});

test("an external change invalidates full-read recall suppression before selection", async (t) => {
	const harness = await createLifecycleHarness(t, {
		config: { extraction: { enabled: false }, dream: { enabled: false } },
	});
	const topicPath = join(harness.paths.memoryDir, "external.md");
	const original = "---\ndescription: external topic\n---\nold fact\n";
	const updated = "---\ndescription: external topic\n---\nnew fact\n";
	await writeFile(topicPath, original);
	await harness.extension.emit(
		"tool_call",
		{ type: "tool_call", toolCallId: "full-read", toolName: "read", input: { path: topicPath } },
		harness.context,
	);
	await harness.extension.emit(
		"tool_result",
		{
			type: "tool_result",
			toolCallId: "full-read",
			toolName: "read",
			input: { path: topicPath },
			content: [{ type: "text", text: original }],
			isError: false,
		},
		harness.context,
	);
	await writeFile(topicPath, updated);
	// This test exercises mtime-based recall invalidation, including on fast filesystems.
	await utimes(topicPath, new Date(), new Date(Date.now() + 2_000));
	harness.faux.setResponses([
		fauxAssistantMessage(fauxToolCall("select_memories", { selected_memories: ["external.md"] })),
	]);
	const result = (await harness.extension.emit(
		"before_agent_start",
		{ prompt: "recall the external topic", systemPromptOptions: { sections: {} } },
		harness.context,
	)) as any;
	assert.match(result.message.content, /new fact/);
	assert.match(result.message.content, /External memory change detection/);
	assert.doesNotMatch(result.message.content, /loaded copy of external\.md is now stale/);
});

test("background updates report changed files and stale loaded memories", async (t) => {
	const harness = await createLifecycleHarness(t, {
		config: {
			extraction: { enabled: false, idleFlushSeconds: 0, maxTurns: 3 },
			dream: { enabled: false },
		},
	});
	const topicPath = join(harness.paths.memoryDir, "loaded.md");
	const original = "---\ndescription: loaded topic\n---\nold fact\n";
	const updated = "---\ndescription: loaded topic\n---\nnew fact\n";
	await writeFile(topicPath, original);
	await harness.extension.emit(
		"tool_call",
		{ type: "tool_call", toolCallId: "host-read", toolName: "read", input: { path: topicPath } },
		harness.context,
	);
	await harness.extension.emit(
		"tool_result",
		{
			type: "tool_result",
			toolCallId: "host-read",
			toolName: "read",
			input: { path: topicPath },
			content: [{ type: "text", text: original }],
			details: undefined,
			isError: false,
		},
		harness.context,
	);
	const releaseWrite = deferred();
	let childStarted = false;
	harness.faux.setResponses([
		async () => {
			childStarted = true;
			await releaseWrite.promise;
			return fauxAssistantMessage(fauxToolCall("read", { path: topicPath }), { stopReason: "toolUse" });
		},
		fauxAssistantMessage(fauxToolCall("write", { path: topicPath, content: updated }), {
			stopReason: "toolUse",
		}),
		fauxAssistantMessage("memory updated"),
	]);
	const extraction = Promise.resolve(harness.extension.commands.get("memory")?.handler("extract", harness.context));
	await eventually(() => childStarted, "background extraction did not start");
	await harness.extension.emit(
		"before_agent_start",
		{
			messageType: "custom",
			systemPromptOptions: { sections: {} },
		},
		harness.context,
	);
	releaseWrite.resolve();
	await extraction;
	assert.equal(await readFile(topicPath, "utf8"), updated);
	for (let round = 0; round < 2; round++) {
		await harness.extension.emit("turn_start", {}, harness.context);
		const context = (await harness.extension.emit("context", { messages: [] }, harness.context)) as any;
		assert.match(context.messages.at(-1).content, /Background memory extraction/);
		assert.match(context.messages.at(-1).content, /loaded copy of loaded\.md is now stale/);
		assert.equal(context.messages.at(-1).display, false, "request-local reminders must not create UI entries");
	}

	const start = { prompt: "", systemPromptOptions: { sections: {} as Record<string, string> } };
	const result = (await harness.extension.emit("before_agent_start", start, harness.context)) as any;
	assert.equal(result.message.customType, "pi-project-memory-update");
	assert.equal(harness.extension.entries.length, 1);
	assert.equal(harness.extension.entries[0]?.customType, "pi-project-memory-update");
	assert.deepEqual(harness.extension.entries[0]?.data.updates[0].paths, ["loaded.md"]);
	const entry = {
		type: "custom" as const,
		id: "update-entry",
		parentId: null,
		timestamp: new Date().toISOString(),
		...harness.extension.entries[0]!,
	};
	const renderer = harness.extension.entryRenderers.get(entry.customType)!;
	const theme = { fg: (_color: string, text: string) => text } as Theme;
	assert.match(renderer(entry, { expanded: false }, theme)!.render(80).join("\n"), /Memory · Saved 1 topic/);
	assert.match(renderer(entry, { expanded: true }, theme)!.render(80).join("\n"), /loaded.md/);
	assert.ok(!harness.notices.some((notice) => notice.message.startsWith("Project memory updated:")));
	assert.equal(result.message.display, false, "the immediate entry already displayed this update");
	assert.deepEqual(result.message.details.updates[0], {
		source: "extract",
		summary: "saved 1 topic memory",
		paths: ["loaded.md"],
		displayed: true,
	});
	assert.deepEqual(result.message.details.stalePaths, ["loaded.md"]);
	assert.deepEqual(result.message.details.updatedPaths, ["loaded.md"]);
	assert.match(result.message.content, /Background memory extraction/);
	assert.match(result.message.content, /Files changed: loaded\.md/);
	assert.match(result.message.content, /loaded copy of loaded\.md is now stale relative to disk/);
	assert.match(result.message.content, /Do not quote it to the user/);

	const repeated = (await harness.extension.emit(
		"before_agent_start",
		{ prompt: "", systemPromptOptions: { sections: {} } },
		harness.context,
	)) as any;
	assert.match(repeated.message.content, /loaded copy of loaded\.md is now stale relative to disk/);
	assert.equal(repeated.message.display, false, "unchanged stale reminders remain in context without another UI entry");

	await writeFile(topicPath, `${updated}another external change\n`);
	const changedAgain = (await harness.extension.emit(
		"before_agent_start",
		{ prompt: "", systemPromptOptions: { sections: {} } },
		harness.context,
	)) as any;
	assert.equal(changedAgain.message.display, true, "another edit of the same stale file must be visible");
	assert.equal(changedAgain.message.details.updates[0].source, "external");
});

test("extraction requires three words in one user string or text block and consumes skipped ranges", async (t) => {
	const cases = [
		{ name: "one word", contents: ["word"], qualifies: false },
		{ name: "two words", contents: ["remember this"], qualifies: false },
		{ name: "unspaced Chinese", contents: ["以后用中文回答"], qualifies: false },
		{ name: "two Chinese words", contents: ["以后 中文"], qualifies: false },
		{ name: "blank", contents: [" \t\n "], qualifies: false },
		{ name: "separate messages", contents: ["one two", "three four"], qualifies: false },
		{
			name: "separate text blocks",
			contents: [
				[
					{ type: "text", text: "one two" },
					{ type: "text", text: "three four" },
				],
			],
			qualifies: false,
		},
		{ name: "image only", contents: [[{ type: "image", data: "image", mimeType: "image/png" }]], qualifies: false },
		{ name: "three words", contents: ["remember this fact"], qualifies: true },
		{ name: "Unicode whitespace", contents: [" one\ttwo\nthree\u3000four "], qualifies: true },
		{ name: "spaced Chinese", contents: ["以后 使用 中文"], qualifies: true },
		{
			name: "one qualifying text block",
			contents: [
				[
					{ type: "text", text: "short" },
					{ type: "text", text: "remember this fact" },
				],
			],
			qualifies: true,
		},
	];
	for (const { name, contents, qualifies } of cases) {
		await t.test(name, async (t) => {
			const messages = contents.map((content, index) => ({ role: "user", content, timestamp: index + 1 }));
			const harness = await createLifecycleHarness(t, {
				config: { extraction: { idleFlushSeconds: 0 }, dream: { enabled: false } },
				projection: { messages, entries: [{ sourceEntry: { id: "turn-1" }, messages }] },
			});
			const captured: any[][] = [];
			harness.faux.setResponses(
				[0, 1].map(() => (context: Context) => {
					captured.push(context.messages);
					return fauxAssistantMessage("Nothing to save.");
				}),
			);
			if (!qualifies) {
				await harness.extension.commands.get("memory")?.handler("extract", harness.context);
				assert.equal(harness.faux.state.callCount, 0, "manual extraction bypassed the prose gate");
			}
			await harness.extension.emit("session_before_compact", { type: "session_before_compact" }, harness.context);
			assert.equal(harness.faux.state.callCount, qualifies ? 1 : 0);

			const next = { role: "user", content: "new durable project fact", timestamp: 100 };
			harness.projection.messages.push(next);
			harness.projection.entries.push({ sourceEntry: { id: "turn-2" }, messages: [next] });
			harness.setLeafId("turn-2");
			await harness.extension.commands.get("memory")?.handler("extract", harness.context);
			assert.equal(captured.length, qualifies ? 2 : 1);
			assert.equal(captured.at(-1)![0].content, next.content);
			assert.equal(captured.at(-1)!.length, 2, "consumed messages were replayed after the cursor");
		});
	}
});

test("extraction freezes its input snapshot before asynchronous preparation", async (t) => {
	const harness = await createLifecycleHarness(t, {
		config: { extraction: { idleFlushSeconds: 0 }, dream: { enabled: false } },
	});
	const contexts: any[][] = [];
	harness.faux.setResponses(
		[0, 1].map(() => (context: any) => {
			contexts.push(context.messages);
			return fauxAssistantMessage("Nothing to save.");
		}),
	);
	const buildProjection = harness.context.sessionManager.buildSessionProjection;
	(harness.context.sessionManager as any).buildSessionProjection = () => {
		(harness.context.sessionManager as any).buildSessionProjection = buildProjection;
		queueMicrotask(() => {
			const newer = { role: "user", content: "new snapshot fact", timestamp: 2 };
			harness.projection.messages.push(newer);
			harness.projection.entries.push({ sourceEntry: { id: "turn-2" }, messages: [newer] });
			harness.setLeafId("turn-2");
			void harness.extension.emit("message_end", { type: "message_end", message: newer }, harness.context);
		});
		return buildProjection();
	};
	await harness.extension.commands.get("memory")?.handler("extract", harness.context);
	assert.equal(contexts.length, 2);
	assert.doesNotMatch(JSON.stringify(contexts[0]), /new snapshot fact/);
	assert.match(JSON.stringify(contexts[1]), /new snapshot fact/);
	assert.doesNotMatch(JSON.stringify(contexts[1]), /remember this durable project fact/);
});

test("external memory edits do not consume pending user prose as direct writes", async (t) => {
	const harness = await createLifecycleHarness(t, {
		config: { extraction: { idleFlushSeconds: 0 }, dream: { enabled: false } },
	});
	await writeFile(join(harness.paths.memoryDir, "external.md"), "external change\n");
	harness.faux.setResponses([fauxAssistantMessage("Nothing to save.")]);
	await harness.extension.emit("agent_before_settle", { type: "agent_before_settle" }, harness.context);
	await harness.extension.emit("agent_settled", { type: "agent_settled", aborted: false }, harness.context);
	await eventually(() => harness.faux.state.callCount === 1, "external change incorrectly skipped extraction");
	await harness.extension.emit("session_shutdown", { type: "session_shutdown" }, harness.context);
	assert.equal(harness.faux.state.callCount, 1);
});

test("memory index stays cached until compaction, navigation, reload, or session start", async (t) => {
	for (const reset of ["session_compact", "session_tree", "reload-config", "session_start"]) {
		const harness = await createLifecycleHarness(t, {
			config: { extraction: { enabled: false }, dream: { enabled: false } },
		});
		await writeFile(join(harness.paths.memoryDir, "MEMORY.md"), "initial index\n");
		const initial = { prompt: "", systemPromptOptions: { sections: {} as Record<string, string> } };
		await harness.extension.emit("before_agent_start", initial, harness.context);
		await writeFile(join(harness.paths.memoryDir, "MEMORY.md"), "custom startup index\n");
		const event = { messageType: "custom", systemPromptOptions: { sections: {} as Record<string, string> } };
		const result = (await harness.extension.emit("before_agent_start", event, harness.context)) as any;
		assert.equal(event.systemPromptOptions.sections.auto_memory, mainMemoryPrompt(harness.paths.memoryDir));
		assert.deepEqual(event.systemPromptOptions.sections, initial.systemPromptOptions.sections);
		assert.match(event.systemPromptOptions.sections.auto_memory_index!, /initial index/);
		assert.match(result.message.content, /MEMORY\.md/);
		assert.match(result.message.content, /loaded copy of MEMORY\.md is now stale/);
		if (reset === "reload-config") await harness.extension.commands.get("memory")?.handler(reset, harness.context);
		else await harness.extension.emit(reset, {}, harness.context);
		const refreshed = { prompt: "", systemPromptOptions: { sections: {} as Record<string, string> } };
		await harness.extension.emit("before_agent_start", refreshed, harness.context);
		assert.match(refreshed.systemPromptOptions.sections.auto_memory_index!, /custom startup index/);
		assert.equal(harness.faux.state.callCount, 0);
	}
});

test("maintenance forks preserve the parent prefix and cache while executing only restricted tools", async (t) => {
	for (const command of ["extract", "dream"]) {
		const harness = await createLifecycleHarness(t, {
			config: { extraction: { enabled: false, idleFlushSeconds: 0 }, dream: { enabled: true } },
		});
		harness.context.model = { ...harness.context.model!, reasoning: true };
		harness.context.thinkingLevel = "high";
		const outside = join(harness.projectRoot, "source.md");
		const target = join(harness.paths.memoryDir, "saved.md");
		await writeFile(outside, "project source\n");
		const messages: any[] = [
			{
				role: "system",
				content: "cached parent prompt",
				sections: { auto_memory_index: "cached index" },
				toolsAdded: [
					toToolDeclaration(createReadTool(harness.projectRoot)),
					toToolDeclaration(createWriteTool(harness.projectRoot)),
					{ name: "parent_only", description: "Parent extension tool", parameters: { type: "object", properties: {} } },
				].map((declaration) => ({
					...declaration,
					parameters: JSON.parse(
						JSON.stringify(declaration.parameters, (_key, value) =>
							value && typeof value === "object" && !Array.isArray(value)
								? Object.fromEntries(Object.entries(value).reverse())
								: value,
						),
					),
				})),
				timestamp: 1,
			},
			{ role: "user", content: "old parent history", timestamp: 2 },
			{ role: "system", content: "later system patch", timestamp: 3 },
			{
				role: "custom",
				customType: "pi-project-memory-recall",
				content: "recalled memory",
				display: false,
				timestamp: 4,
			},
			...harness.projection.messages,
		];
		const expected = structuredClone(convertToLlm(messages));
		await harness.extension.emit("context_with_system", { messages }, harness.context);
		messages[0].sections.auto_memory_index = "mutated after capture";
		harness.faux.setResponses([fauxAssistantMessage("parent final answer")]);
		const parentAnswer = await harness.faux
			.streamSimple(harness.faux.getModel(), { messages: expected } as any, {
				cacheRetention: "short",
				sessionId: harness.context.sessionManager.getSessionId(),
			})
			.result();
		await harness.extension.emit("message_end", { message: parentAnswer }, harness.context);
		expected.push(parentAnswer);
		const usages: number[] = [];
		const reasoningLevels: unknown[] = [];
		(harness.context.modelRegistry as any).streamSimple = (model: any, context: Context, options: any) => {
			reasoningLevels.push(options.reasoning);
			const stream = harness.faux.streamSimple(model, normalizeContext(context), options);
			return {
				result: async () => {
					const result = await stream.result();
					usages.push(result.usage.cacheRead);
					return result;
				},
			};
		};
		harness.faux.setResponses([
			(context, options) => {
				assert.deepEqual(context.messages.slice(0, expected.length), expected);
				assert.equal(options?.sessionId, harness.context.sessionManager.getSessionId());
				assert.equal(options?.cacheRetention, "short");
				return fauxAssistantMessage([
					fauxToolCall("parent_only", {}),
					fauxToolCall("write", { path: outside, content: "must be denied" }),
				]);
			},
			(context) => {
				const denied = context.messages.slice(-2);
				assert.ok(denied.every((message) => message.role === "toolResult" && message.isError));
				return fauxAssistantMessage(fauxToolCall("write", { path: target, content: "saved memory\n" }));
			},
			fauxAssistantMessage("done"),
		]);
		await harness.extension.commands.get("memory")?.handler(command, harness.context);
		assert.equal(usages.length, 3);
		assert.deepEqual(reasoningLevels, ["high", "high", "high"]);
		assert.ok(usages[0]! > 0, "Fork failed to reuse the Faux provider's parent cache");
		assert.equal(await readFile(outside, "utf8"), "project source\n");
		assert.equal(await readFile(target, "utf8"), "saved memory\n");
	}
});

test("maintenance uses an independent prefix when the model, schema, or context policy differs", async (t) => {
	for (const reason of [
		"model",
		"schema",
		"schema-type",
		"schema-required",
		"schema-constraint",
		"schema-array-order",
		"recentMessages",
		"blockImages",
		"compaction",
	]) {
		const harness = await createLifecycleHarness(t, {
			config: {
				extraction: {
					enabled: false,
					idleFlushSeconds: 0,
					recentMessages: reason === "recentMessages" ? 3 : "inherit",
				},
				dream: { enabled: false },
			},
		});
		if (reason === "blockImages") harness.extension.api.getSettings = () => ({ images: { blockImages: true } });
		const declaration = structuredClone(toToolDeclaration(createWriteTool(harness.projectRoot)));
		const parameters = declaration.parameters as any;
		if (reason === "schema-type") parameters.properties.path.type = "number";
		if (reason === "schema-required") parameters.required = ["path"];
		if (reason === "schema-constraint") parameters.properties.path.minLength = 2;
		if (reason === "schema-array-order") parameters.required.reverse();
		const messages = [
			{
				role: "system",
				content: "parent prefix",
				timestamp: 1,
				toolsAdded:
					reason === "schema"
						? [{ name: "read", description: "custom", parameters: { type: "object", properties: {} } }]
						: [declaration],
			},
			{ role: "user", content: "old parent-only history", timestamp: 2 },
		];
		await harness.extension.emit("context_with_system", { messages }, harness.context);
		if (reason === "model") harness.context.model = { ...harness.context.model!, id: "different-model" };
		if (reason === "compaction") await harness.extension.emit("session_compact", {}, harness.context);
		let request: { context: Context; options: any } | undefined;
		harness.faux.setResponses([
			(context, options) => {
				request = { context: context as unknown as Context, options };
				return fauxAssistantMessage("done");
			},
		]);
		await harness.extension.commands.get("memory")?.handler("extract", harness.context);
		assert.equal(harness.faux.state.callCount, 1);
		assert.ok(request, reason);
		assert.equal(request.context.tools?.length, 6, reason);
		assert.match(request.context.systemPrompt ?? "", /Background memory task tools/, reason);
		assert.doesNotMatch(JSON.stringify(request.context.messages), /old parent-only history/, reason);
		assert.notEqual(request.options?.sessionId, harness.context.sessionManager.getSessionId(), reason);
		assert.equal(request.options?.cacheRetention, "short", reason);
	}
});

test("restored writes deduplicate only matching successful memory results after the cursor", async (t) => {
	for (const toolName of ["write", "edit"]) {
		for (const outcome of ["success", "error", "missing", "unmatched", "outside"]) {
			const harness = await createLifecycleHarness(t, {
				config: { extraction: { idleFlushSeconds: 0 }, dream: { enabled: false } },
			});
			const path = join(outcome === "outside" ? harness.projectRoot : harness.paths.memoryDir, "direct.md");
			const messages = [
				...harness.projection.messages,
				fauxAssistantMessage(fauxToolCall(toolName, { path }, { id: "restored-write" })),
				...(outcome === "missing"
					? []
					: [
							{
								role: "toolResult",
								toolCallId: outcome === "unmatched" ? "other" : "restored-write",
								toolName,
								content: [{ type: "text", text: "outcome" }],
								isError: outcome === "error",
								timestamp: 2,
							},
						]),
			];
			harness.projection.messages = messages;
			harness.projection.entries = messages.map((message, i) => ({
				sourceEntry: { id: `entry-${i}` },
				messages: [message],
			}));
			harness.setLeafId(`entry-${messages.length - 1}`);
			await harness.extension.emit("session_start", { type: "session_start" }, harness.context);
			harness.faux.setResponses([fauxAssistantMessage("Nothing to save."), fauxAssistantMessage("Next fact saved.")]);
			await harness.extension.emit("session_before_compact", { type: "session_before_compact" }, harness.context);
			const expected = outcome === "success" ? 0 : 1;
			assert.equal(harness.faux.state.callCount, expected, `${toolName}: ${outcome}`);
			const next = { role: "user", content: "another durable project fact", timestamp: 3 };
			harness.projection.messages.push(next);
			harness.projection.entries.push({ sourceEntry: { id: "next" }, messages: [next] });
			harness.setLeafId("next");
			await harness.extension.emit("session_before_compact", { type: "session_before_compact" }, harness.context);
			assert.equal(harness.faux.state.callCount, expected + 1, "old writes must not suppress new prose");
		}
	}
});

test("successful direct writes skip extraction but failed writes do not", async (t) => {
	for (const isError of [false, true]) {
		const harness = await createLifecycleHarness(t, {
			config: { extraction: { idleFlushSeconds: 0 }, dream: { enabled: false } },
		});
		const target = join(harness.paths.memoryDir, "direct.md");
		if (!isError) await writeFile(target, "direct fact\n");
		await harness.extension.emit(
			"tool_result",
			{
				type: "tool_result",
				toolCallId: "direct-write",
				toolName: "write",
				input: { path: `~/${relative(homedir(), target)}`, content: "direct fact\n" },
				content: [{ type: "text", text: "write outcome" }],
				isError,
			},
			harness.context,
		);
		harness.faux.setResponses([fauxAssistantMessage("Nothing to save.")]);
		await harness.extension.emit("agent_settled", { type: "agent_settled", aborted: false }, harness.context);
		await harness.extension.emit("session_before_compact", { type: "session_before_compact" }, harness.context);
		assert.equal(harness.faux.state.callCount, isError ? 1 : 0);
	}
});

test("writes and completed usage survive a later thrown extractor request", async (t) => {
	const harness = await createLifecycleHarness(t, {
		config: { extraction: { idleFlushSeconds: 0 }, dream: { enabled: false } },
	});
	const target = join(harness.paths.memoryDir, "landed.md");
	await harness.extension.commands.get("memory")?.handler("status", harness.context);
	const beforeTokens = Number(/extractor (\d+) tokens/.exec(harness.notices.at(-1)!.message)?.[1]);
	harness.faux.setResponses([fauxAssistantMessage(fauxToolCall("write", { path: target, content: "landed fact\n" }))]);
	const originalStream = harness.context.modelRegistry.streamSimple;
	let calls = 0;
	harness.context.modelRegistry.streamSimple = ((...args: any[]) => {
		if (++calls === 1) return (originalStream as any)(...args);
		return {
			result: async () => {
				throw new Error("second request failed");
			},
		};
	}) as any;
	await harness.extension.commands.get("memory")?.handler("extract", harness.context);
	assert.equal(await readFile(target, "utf8"), "landed fact\n");
	const next = (await harness.extension.emit(
		"before_agent_start",
		{ prompt: "", systemPromptOptions: { sections: {} } },
		harness.context,
	)) as any;
	assert.deepEqual(next.message.details.updatedPaths, ["landed.md"]);
	assert.match(next.message.content, /Background memory extraction/);
	await harness.extension.commands.get("memory")?.handler("status", harness.context);
	assert.ok(Number(/extractor (\d+) tokens/.exec(harness.notices.at(-1)!.message)?.[1]) > beforeTokens);
});

test("terminal selector failures reach the warning handler", async (t) => {
	const harness = await createLifecycleHarness(t, {
		config: { extraction: { enabled: false }, dream: { enabled: false } },
	});
	await writeFile(join(harness.paths.memoryDir, "fact.md"), "A relevant fact\n");
	harness.context.modelRegistry.streamSimple = (() => ({
		result: async () => {
			throw Object.assign(new Error("authentication rejected"), { status: 401 });
		},
	})) as any;
	await harness.extension.emit(
		"before_agent_start",
		{ prompt: "recall the fact", systemPromptOptions: { sections: {} } },
		harness.context,
	);
	assert.ok(
		harness.notices.some(
			(notice) => notice.level === "warning" && /memory selector.*authentication rejected/.test(notice.message),
		),
	);
});

test("dream reads live session transcripts without staging or pre-parsing omitted files", async (t) => {
	const harness = await createLifecycleHarness(t, {
		config: { extraction: { enabled: false }, dream: { enabled: true } },
	});
	const source = join(harness.sessionDir, "approved.jsonl");
	const malformed = join(harness.sessionDir, "omitted.jsonl");
	const header = JSON.stringify({ type: "session", id: "approved", cwd: harness.projectRoot });
	await writeFile(source, `${header}\noriginal content\n`);
	await writeFile(malformed, "{\n");
	harness.faux.setResponses([
		async (context) => {
			assert.match(JSON.stringify(context.messages.at(-1)?.content), /approved/);
			assert.ok(JSON.stringify(context.messages.at(-1)?.content).includes(harness.sessionDir));
			await writeFile(source, `${header}\nlive content\n`);
			return fauxAssistantMessage(fauxToolCall("read", { path: source }));
		},
		(context) => {
			assert.match(JSON.stringify(context.messages.at(-1)?.content), /live content/);
			return fauxAssistantMessage(fauxToolCall("read", { path: malformed }));
		},
		(context) => {
			assert.equal((context.messages.at(-1) as any).isError, false);
			return fauxAssistantMessage(fauxToolCall("write", { path: source, content: "must not write" }));
		},
		(context) => {
			assert.equal((context.messages.at(-1) as any).isError, true);
			return fauxAssistantMessage("Nothing to consolidate.");
		},
	]);
	await harness.extension.commands.get("memory")?.handler("dream", harness.context);
	assert.equal(harness.faux.state.callCount, 4);
	assert.equal(await readFile(source, "utf8"), `${header}\nlive content\n`);
	assert.ok((await readState(harness.paths)).lastDreamAt > 0);
	assert.ok(harness.notices.some((notice) => notice.message === "No memory changes needed."));
});

test("an unreadable dream transcript returns a tool error without rolling back the attempt", async (t) => {
	if (process.getuid?.() === 0) return t.skip("root can read files without permission");
	const harness = await createLifecycleHarness(t, {
		config: { extraction: { enabled: false }, dream: { enabled: true } },
	});
	const source = join(harness.sessionDir, "approved.jsonl");
	await writeFile(
		source,
		`${JSON.stringify({ type: "session", id: "approved", cwd: harness.projectRoot })}\ncontent\n`,
	);
	harness.faux.setResponses([
		async () => {
			// The scheduler already selected this transcript; access is lost when
			// the model tries to read it, rather than during a separate copy phase.
			await chmod(source, 0);
			return fauxAssistantMessage(fauxToolCall("read", { path: source }));
		},
		(context) => {
			assert.equal((context.messages.at(-1) as any).isError, true);
			return fauxAssistantMessage("Transcript unavailable; nothing to consolidate.");
		},
	]);
	try {
		await harness.extension.commands.get("memory")?.handler("dream", harness.context);
		assert.equal(harness.faux.state.callCount, 2);
		assert.ok((await readState(harness.paths)).lastDreamAt > 0);
	} finally {
		await chmod(source, 0o600);
	}
});

test("dream writes remain visible after a later thrown request rolls back cadence", async (t) => {
	const harness = await createLifecycleHarness(t, {
		config: { extraction: { enabled: false }, dream: { enabled: true } },
	});
	const target = join(harness.paths.memoryDir, "dream-landed.md");
	harness.faux.setResponses([
		fauxAssistantMessage(fauxToolCall("write", { path: target, content: "landed dream fact\n" })),
	]);
	const stream = harness.context.modelRegistry.streamSimple;
	let calls = 0;
	harness.context.modelRegistry.streamSimple = ((...args: any[]) =>
		++calls === 1
			? (stream as any)(...args)
			: {
					result: async () => {
						throw new Error("dream request failed after write");
					},
				}) as any;
	await harness.extension.commands.get("memory")?.handler("dream", harness.context);
	assert.equal((await readState(harness.paths)).lastDreamAt, 0);
	assert.equal(await readFile(target, "utf8"), "landed dream fact\n");
	const next = (await harness.extension.emit(
		"before_agent_start",
		{ prompt: "", systemPromptOptions: { sections: {} } },
		harness.context,
	)) as any;
	assert.deepEqual(next.message.details.updatedPaths, ["dream-landed.md"]);
	assert.match(next.message.content, /Background memory consolidation/);
});

test("background usage survives session_start within one extension instance", async (t) => {
	const harness = await createLifecycleHarness(t, {
		config: { extraction: { idleFlushSeconds: 0 }, dream: { enabled: false } },
	});
	harness.faux.setResponses([fauxAssistantMessage("Nothing to save.")]);
	await harness.extension.commands.get("memory")?.handler("extract", harness.context);
	await harness.extension.commands.get("memory")?.handler("status", harness.context);
	const before = harness.notices.at(-1)!.message.match(/Background usage:.*/)?.[0];
	assert.match(before ?? "", /extractor [1-9]\d* tokens/);
	await harness.extension.emit("session_start", { type: "session_start" }, harness.context);
	await harness.extension.commands.get("memory")?.handler("status", harness.context);
	assert.equal(harness.notices.at(-1)!.message.match(/Background usage:.*/)?.[0], before);
	const reloaded = fakeExtensionApi();
	projectMemoryExtension(reloaded.api);
	await reloaded.emit("session_start", { type: "session_start" }, harness.context);
	await reloaded.commands.get("memory")?.handler("status", harness.context);
	assert.equal(harness.notices.at(-1)!.message.match(/Background usage:.*/)?.[0], before);
});

test("dream reserves lock acquisition time rather than session enumeration time", async (t) => {
	const harness = await createLifecycleHarness(t, {
		config: { extraction: { enabled: false }, dream: { enabled: true } },
	});
	harness.faux.setResponses([fauxAssistantMessage("Nothing to consolidate.")]);
	const originalNow = Date.now;
	const originalDirectory = harness.context.sessionManager.getSessionDir;
	const beforeScan = originalNow();
	let clock = beforeScan;
	Date.now = () => clock;
	(harness.context.sessionManager as any).getSessionDir = () => {
		clock += 5_000;
		return originalDirectory();
	};
	try {
		await harness.extension.commands.get("memory")?.handler("dream", harness.context);
		assert.equal((await readState(harness.paths)).lastDreamAt, beforeScan + 5_000);
	} finally {
		Date.now = originalNow;
	}
});

test("dream keeps reservations for returned errors, aborts and completion notification failures", async (t) => {
	for (const outcome of ["error", "aborted", "notification"] as const) {
		const harness = await createLifecycleHarness(t, {
			config: { extraction: { enabled: false }, dream: { enabled: true } },
		});
		harness.faux.setResponses([
			fauxAssistantMessage("dream outcome", {
				stopReason: outcome === "notification" ? "stop" : outcome,
				...(outcome === "error" ? { errorMessage: "returned API failure" } : {}),
			}),
		]);
		if (outcome === "notification") {
			const notify = harness.context.ui.notify;
			harness.context.ui.notify = (message, level) => {
				if (message === "No memory changes needed.") throw new Error("notification failed");
				notify(message, level);
			};
		}
		await harness.extension.commands.get("memory")?.handler("dream", harness.context);
		assert.ok((await readState(harness.paths)).lastDreamAt > 0, `${outcome} rolled back the attempt`);
	}
});

test("only non-aborted thrown dream forks roll back their reservations", async (t) => {
	const thrown = await createLifecycleHarness(t, {
		config: { extraction: { enabled: false }, dream: { enabled: true } },
	});
	thrown.context.modelRegistry.streamSimple = (() => ({
		result: async () => {
			throw new Error("fork failed");
		},
	})) as any;
	await thrown.extension.commands.get("memory")?.handler("dream", thrown.context);
	assert.equal((await readState(thrown.paths)).lastDreamAt, 0);

	const aborted = await createLifecycleHarness(t, {
		config: { extraction: { enabled: false }, dream: { enabled: true } },
	});
	let started = false;
	aborted.faux.setResponses([
		(_context, options) =>
			new Promise((resolve) => {
				started = true;
				options!.signal!.addEventListener(
					"abort",
					() => resolve(fauxAssistantMessage("aborted", { stopReason: "aborted" })),
					{ once: true },
				);
			}),
	]);
	const pass = Promise.resolve(aborted.extension.commands.get("memory")?.handler("dream", aborted.context));
	await eventually(() => started, "dream did not start");
	await aborted.extension.commands.get("memory")?.handler("reload-config", aborted.context);
	await pass;
	assert.ok((await readState(aborted.paths)).lastDreamAt > 0);
});

test("selector applies Claude's traditional whitespace gate to final and queued user text", async (t) => {
	for (const source of ["final", "queued"] as const) {
		for (const [query, qualifies] of [
			["", false],
			[" \t\n ", false],
			["word", false],
			[" \tword\n ", false],
			["以后用中文回答", false],
			["かな", false],
			["한국어", false],
			["two words", true],
			["中文 文本", true],
			["two\twords", true],
			["two\nwords", true],
			["two\u3000words", true],
		] as const) {
			await t.test(`${source}: ${JSON.stringify(query)}`, async (t) => {
				const harness = await createLifecycleHarness(t, {
					config: { extraction: { enabled: false }, dream: { enabled: false } },
				});
				await writeFile(join(harness.paths.memoryDir, "topic.md"), "---\ndescription: topic\n---\nfact\n");
				harness.faux.setResponses([
					fauxAssistantMessage(fauxToolCall("select_memories", { selected_memories: ["topic.md"] })),
				]);
				if (source === "final") {
					const result = (await harness.extension.emit(
						"before_agent_start",
						{ prompt: query, systemPromptOptions: { sections: {} } },
						harness.context,
					)) as any;
					assert.equal(Boolean(result?.message), qualifies);
				} else {
					await harness.extension.emit(
						"message_end",
						{ type: "message_end", message: { role: "user", content: query, timestamp: 2 } },
						harness.context,
					);
					if (qualifies)
						await eventually(() => harness.extension.sentMessages.length === 1, "queued recall was not delivered");
				}
				assert.equal(harness.faux.state.callCount, qualifies ? 1 : 0);
			});
		}
	}
});

test("raw handled input and non-user messages do not select, while accepted transformed text selects once", async (t) => {
	const harness = await createLifecycleHarness(t, {
		config: { extraction: { enabled: false }, dream: { enabled: false } },
	});
	await writeFile(join(harness.paths.memoryDir, "topic.md"), "---\ndescription: topic\n---\nfact\n");
	await harness.extension.emit(
		"input",
		{ type: "input", text: "handled locally", source: "extension" },
		harness.context,
	);
	await harness.extension.emit(
		"message_end",
		{
			type: "message_end",
			message: { role: "custom", customType: "pi-project-memory-update", content: "memory bookkeeping", timestamp: 2 },
		},
		harness.context,
	);
	await harness.extension.emit(
		"message_end",
		{ type: "message_end", message: { role: "toolResult", content: [{ type: "text", text: "result" }] } },
		harness.context,
	);
	assert.equal(harness.faux.state.callCount, 0);
	let selectedQuery = "";
	harness.faux.setResponses([
		(context) => {
			selectedQuery = JSON.stringify(context.messages.at(-1));
			return fauxAssistantMessage(fauxToolCall("select_memories", { selected_memories: [] }));
		},
	]);
	await harness.extension.emit(
		"before_agent_start",
		{ prompt: "最终 文本", systemPromptOptions: { sections: {} } },
		harness.context,
	);
	await harness.extension.emit(
		"message_end",
		{ type: "message_end", message: { role: "user", content: "最终 文本", timestamp: 3 } },
		harness.context,
	);
	assert.equal(harness.faux.state.callCount, 1);
	assert.match(selectedQuery, /最终 文本/);
	assert.doesNotMatch(selectedQuery, /handled locally/);
});

test("image normalization keeps one selector call and subsequent streaming input selects independently", async (t) => {
	const harness = await createLifecycleHarness(t, {
		config: { extraction: { enabled: false }, dream: { enabled: false } },
	});
	await writeFile(join(harness.paths.memoryDir, "topic.md"), "---\ndescription: topic\n---\nfact\n");
	const selector = deferred<any>();
	harness.faux.setResponses([async () => selector.promise]);
	await harness.extension.emit(
		"before_agent_start",
		{ prompt: "explain this image", systemPromptOptions: { sections: {} } },
		harness.context,
	);
	assert.equal(harness.faux.state.callCount, 1);
	await harness.extension.emit(
		"message_end",
		{
			type: "message_end",
			message: {
				role: "user",
				content: [
					{ type: "text", text: "explain this image\n\n[Image resized from 4000x3000 to 2000x1500]" },
					{ type: "image", data: "normalized", mimeType: "image/png" },
				],
				timestamp: 2,
			},
		},
		harness.context,
	);
	selector.resolve(fauxAssistantMessage(fauxToolCall("select_memories", { selected_memories: ["topic.md"] })));
	await eventually(() => harness.extension.sentMessages.length === 1, "original image recall was not delivered");
	assert.equal(harness.faux.state.callCount, 1);
	assert.match(harness.extension.sentMessages[0]!.message.content, /fact/);

	await writeFile(join(harness.paths.memoryDir, "queued.md"), "---\ndescription: queued topic\n---\nqueued fact\n");
	harness.faux.setResponses([fauxAssistantMessage(fauxToolCall("select_memories", { selected_memories: [] }))]);
	await harness.extension.emit(
		"message_end",
		{ type: "message_end", message: { role: "user", content: "a queued request", timestamp: 3 } },
		harness.context,
	);
	await eventually(() => harness.faux.state.callCount === 2, "queued input did not start its own selector");
});

test("stale Read reminders match Claude's floored-day threshold", async (t) => {
	const harness = await createLifecycleHarness(t, {
		config: { extraction: { enabled: false }, dream: { enabled: false } },
	});
	const topic = join(harness.paths.memoryDir, "age.md");
	await writeFile(topic, "fact\n");
	for (const [hours, expected] of [
		[36, false],
		[48.1, true],
	] as const) {
		const time = new Date(Date.now() - hours * 3_600_000);
		await utimes(topic, time, time);
		const id = `age-${hours}`;
		await harness.extension.emit(
			"tool_call",
			{ type: "tool_call", toolCallId: id, toolName: "read", input: { path: topic } },
			harness.context,
		);
		const result = (await harness.extension.emit(
			"tool_result",
			{
				type: "tool_result",
				toolCallId: id,
				toolName: "read",
				input: { path: topic },
				content: [{ type: "text", text: "fact\n" }],
				isError: false,
			},
			harness.context,
		)) as any;
		assert.equal(Boolean(result), expected);
	}
});
