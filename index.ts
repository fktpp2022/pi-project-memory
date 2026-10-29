import { lstat, realpath } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";
import {
	convertToLlm,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	type ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import type { ChildCodemodeOptions } from "./src/child-codemode.ts";
import { configPath, loadConfig } from "./src/config.ts";
import { type MemoryMessageDetails, renderMemoryMessage } from "./src/memory-message.ts";
import { MemoryStatus } from "./src/memory-status.ts";
import {
	addUsage,
	effectiveThinkingLevel,
	emptyUsage,
	modelReference,
	type ParentMemoryContext,
	resolveRoleModel,
	runChildAgent,
	type SelectorHistoryEntry,
	sanitizeRecentMessages,
	selectRelevantMemories,
} from "./src/models.ts";
import { assertContainedMarkdown, displayPath, initializeProjectPaths, resolveProjectPaths } from "./src/paths.ts";
import {
	dreamPrompt,
	extractionPrompt,
	indexPrompt,
	mainMemoryPrompt,
	recalledMemoriesPrompt,
	recalledMemoryBudgetContent,
	staleMemoryWarning,
} from "./src/prompts.ts";
import { sanitizeMemoryText } from "./src/sanitize.ts";
import { probeShell, type ShellAvailability, shellStatusLine } from "./src/shell.ts";
import {
	acquireLock,
	compareAndSwapLastDreamAt,
	diffSnapshots,
	lintMemoryContent,
	listOtherSessionIds,
	type MarkdownSnapshotEntry,
	memoryPathFromToolInput,
	readIndex,
	readMarkdownFileSnapshot,
	readState,
	recallTopic,
	scanTopics,
	sha256,
	snapshotMarkdown,
	snapshotMarkdownFile,
} from "./src/store.ts";
import type { ChildRunResult, MemoryRole, ProjectMemoryConfig, ProjectPaths, RecallItem } from "./src/types.ts";
import { type MemoryModelView, type MemoryPanelData, openMemoryPanel } from "./src/ui.ts";

const RECALL_MESSAGE = "pi-project-memory-recall";
const UPDATE_MESSAGE = "pi-project-memory-update";
const RECALL_BUDGET = 61_440;
const RECALL_PREFETCH_DEADLINE_MS = 2_000;
const USAGE_KEY = Symbol.for("pi-project-memory.backgroundUsage");
type BackgroundUsage = Record<"selector" | "extractor" | "dream", Usage>;

function processBackgroundUsage(): BackgroundUsage {
	const processState = globalThis as typeof globalThis & { [USAGE_KEY]?: BackgroundUsage };
	processState[USAGE_KEY] ??= { selector: emptyUsage(), extractor: emptyUsage(), dream: emptyUsage() };
	return processState[USAGE_KEY];
}

interface PendingMemoryUpdate {
	source: "extract" | "dream" | "external";
	summary: string;
	paths: string[];
	displayed?: boolean;
}

interface RecallPrefetchResult {
	recalls: RecallItem[];
	failed?: unknown;
}

interface RecallPrefetch {
	generation: number;
	query: string;
	startedAt: number;
	deliverAs: "steer" | "followUp";
	controller: AbortController;
	selectorHistory: SelectorHistoryEntry[];
	selectorHistoryStart: number;
	promise: Promise<RecallPrefetchResult>;
	result?: RecallPrefetchResult;
	consuming: boolean;
	consumed: boolean;
	waiting: boolean;
}

interface RuntimeState {
	appendEntry: ExtensionAPI["appendEntry"];
	config: ProjectMemoryConfig;
	getCodemode: () => ChildCodemodeOptions | undefined;
	/** Directory configuration is pinned for the whole session, including disabled periods. */
	sessionMemoryDirectory: string | null;
	/** Undefined while the global enabled gate is off. No memory directory is resolved or created in that state. */
	paths?: ProjectPaths;
	generation: number;
	/** Process-local; never persisted across extension reloads or resumed sessions. */
	cursorEntryId?: string;
	turnsSinceExtraction: number;
	directWriteEpoch: number;
	handledDirectWriteEpoch: number;
	inputSerial: number;
	prefetch?: RecallPrefetch;
	/** before_agent_start prepares the next user message before Pi normalizes images. */
	awaitingPreparedUserMessage: boolean;
	recalled: Map<string, number>;
	recallBytes: number;
	loadedMemoryPaths: Set<string>;
	staleLoadedMemoryPaths: Set<string>;
	lastDisplayedStalePaths: string;
	selectorHistory: SelectorHistoryEntry[];
	turnSnapshot: Map<string, MarkdownSnapshotEntry>;
	memoryIndexPrompt?: string;
	parentContext?: ParentMemoryContext;
	idleTimer?: NodeJS.Timeout;
	maintenanceStatus?: MemoryStatus;
	panelOpen?: boolean;
	activeExtraction?: Promise<ChildRunResult | null>;
	extractionAbortController?: AbortController;
	activeDream?: Promise<ChildRunResult | null>;
	dreamAbortController?: AbortController;
	maintenancePasses: Set<Promise<unknown>>;
	extractionPreparations: Set<Promise<unknown>>;
	maintenanceSnapshots: Map<string, string | null>;
	readSnapshots: Map<string, { path: string; snapshot: MarkdownSnapshotEntry }>;
	captureMemoryChanges?: Promise<void>;
	pendingMemoryUpdates: PendingMemoryUpdate[];
	trailingExtraction: boolean;
	shuttingDown: boolean;
	shutdownTimedOut: boolean;
	selectorWarningShown: boolean;
	recallWarningShown: boolean;
	/** Probe result from the most recent background run, or a status-time probe. */
	shell?: ShellAvailability;
	shellNoticeShown: boolean;
	lastDreamScanAt: number;
	lastExtractionError?: string;
	lastDreamError?: string;
	backgroundUsage: BackgroundUsage;
	compactionCursorOutcome?: "consumed" | "failed";
}

export default function projectMemoryExtension(pi: ExtensionAPI) {
	let runtime: RuntimeState | undefined;
	let blockedByTrust = false;
	const backgroundUsage = processBackgroundUsage();
	pi.registerMessageRenderer(RECALL_MESSAGE, renderMemoryMessage);
	pi.registerMessageRenderer(UPDATE_MESSAGE, renderMemoryMessage);
	const entryMessages = new WeakMap<object, Parameters<typeof renderMemoryMessage>[0]>();
	pi.registerEntryRenderer<MemoryMessageDetails>(UPDATE_MESSAGE, (entry, options, theme) => {
		let message = entryMessages.get(entry);
		if (!message) {
			message = {
				role: "custom",
				customType: UPDATE_MESSAGE,
				content: "",
				details: entry.data,
				display: true,
				timestamp: Date.parse(entry.timestamp),
			};
			entryMessages.set(entry, message);
		}
		return renderMemoryMessage(message, { ...options, outputPad: pi.getSettings().outputPad ?? 1 }, theme);
	});

	pi.on("session_start", async (_event, ctx) => {
		runtime?.maintenanceStatus?.dispose();
		runtime?.prefetch?.controller.abort();
		blockedByTrust = !ctx.isProjectTrusted();
		if (blockedByTrust) {
			runtime = undefined;
			ctx.ui.notify("Project memory is disabled because this project is not trusted", "warning");
			return;
		}
		const config = await loadConfig();
		const paths = config.enabled ? await initializeRuntimePaths(ctx, config) : undefined;
		const recalled = await restoreRecalledPaths(ctx, paths?.memoryDir);
		runtime = {
			config,
			getCodemode: () => {
				if (!pi.getActiveTools().includes("codemode")) return undefined;
				const settings = pi.getSettings().codemode;
				return { mode: settings?.mode ?? "on", inlineBudget: settings?.inlineBudget };
			},
			sessionMemoryDirectory: config.autoMemoryDirectory,
			paths,
			generation: 0,
			cursorEntryId: undefined,
			turnsSinceExtraction: 0,
			directWriteEpoch: 0,
			handledDirectWriteEpoch: 0,
			inputSerial: 0,
			awaitingPreparedUserMessage: false,
			recalled,
			recallBytes: restoreRecallBytes(ctx),
			loadedMemoryPaths: new Set(recalled.keys()),
			staleLoadedMemoryPaths: new Set(),
			lastDisplayedStalePaths: "",
			selectorHistory: [],
			turnSnapshot: paths ? await snapshotMarkdown(paths.memoryDir) : new Map(),
			maintenancePasses: new Set(),
			extractionPreparations: new Set(),
			maintenanceSnapshots: new Map(),
			readSnapshots: new Map(),
			appendEntry: pi.appendEntry.bind(pi),
			pendingMemoryUpdates: [],
			trailingExtraction: false,
			shuttingDown: false,
			shutdownTimedOut: false,
			selectorWarningShown: false,
			recallWarningShown: false,
			shellNoticeShown: false,
			lastDreamScanAt: 0,
			backgroundUsage,
			compactionCursorOutcome: undefined,
		};
	});

	function cancelRecallPrefetch(state: RuntimeState): void {
		state.prefetch?.controller.abort();
		state.prefetch = undefined;
		state.awaitingPreparedUserMessage = false;
	}

	function startRecallPrefetch(
		state: RuntimeState,
		query: string,
		ctx: ExtensionContext,
		deliverAs: "steer" | "followUp" = "steer",
	): RecallPrefetch | undefined {
		cancelRecallPrefetch(state);
		const paths = state.paths;
		const normalized = query.trim();
		// Claude C7r's traditional selector requires whitespace inside the trimmed query.
		// Its CJK exception shares the BM25 gate, which this extension excludes.
		if (!paths || !/\s/.test(normalized) || state.recallBytes >= RECALL_BUDGET || !ctx.isProjectTrusted())
			return undefined;
		const controller = new AbortController();
		const preparation = captureExternalMemoryChanges(state);
		const prefetch: RecallPrefetch = {
			generation: state.generation,
			query: normalized,
			startedAt: Date.now(),
			deliverAs,
			controller,
			selectorHistory: [...state.selectorHistory],
			selectorHistoryStart: state.selectorHistory.length,
			promise: Promise.resolve({ recalls: [] }),
			consuming: false,
			consumed: false,
			waiting: false,
		};
		prefetch.promise = (async (): Promise<RecallPrefetchResult> => {
			try {
				await preparation;
				if (controller.signal.aborted) return { recalls: [] };
				const recalled = new Map(state.recalled);
				const topics = await scanTopics(paths.memoryDir);
				const selected = await selectRelevantMemories(
					normalized,
					topics,
					recalled,
					state.config,
					ctx,
					prefetch.selectorHistory,
					controller.signal,
					(usage) => addUsage(state.backgroundUsage.selector, usage),
				);
				if (controller.signal.aborted) return { recalls: [] };
				const selectedTopics = selected.flatMap((filename) => {
					const topic = topics.find((candidate) => candidate.filename === filename);
					return topic ? [topic] : [];
				});
				const settled = await Promise.allSettled(selectedTopics.map(recallTopic));
				return {
					recalls: settled.flatMap((result) => (result.status === "fulfilled" ? [result.value] : [])),
					failed: settled.find((result) => result.status === "rejected"),
				};
			} catch (error) {
				if (controller.signal.aborted) return { recalls: [] };
				throw error;
			}
		})();
		prefetch.promise.then(
			async (result) => {
				prefetch.result = result;
				if (prefetch.waiting && !prefetch.consumed && state.prefetch === prefetch) {
					const message = await consumeRecallPrefetch(state, prefetch, ctx);
					if (message) pi.sendMessage(message, { deliverAs: prefetch.deliverAs });
				}
			},
			(error) => {
				if (controller.signal.aborted) return;
				if (!state.selectorWarningShown) {
					state.selectorWarningShown = true;
					notifyError(ctx, "memory selector", error);
				}
			},
		);
		state.prefetch = prefetch;
		return prefetch;
	}

	async function consumeRecallPrefetch(state: RuntimeState, prefetch: RecallPrefetch, ctx: ExtensionContext) {
		if (
			prefetch.consuming ||
			prefetch.consumed ||
			!prefetch.result ||
			state.prefetch !== prefetch ||
			prefetch.generation !== state.generation ||
			!ctx.isProjectTrusted()
		)
			return undefined;
		prefetch.consuming = true;
		const settledCurrent = await Promise.all(
			prefetch.result.recalls.map(async (recall) => {
				try {
					const info = await lstat(recall.path);
					return info.isFile() && info.mtimeMs === recall.mtimeMs ? recall : undefined;
				} catch {
					// Optional recall delivery boundary: a removed or unreadable file
					// cannot be validated, so omit it without charging recall budget.
					return undefined;
				}
			}),
		);
		if (state.prefetch !== prefetch || prefetch.generation !== state.generation || !ctx.isProjectTrusted())
			return undefined;
		prefetch.consumed = true;
		const appendedHistory = prefetch.selectorHistory.slice(prefetch.selectorHistoryStart);
		state.selectorHistory.push(...appendedHistory);
		if (prefetch.result.failed && !state.recallWarningShown) {
			state.recallWarningShown = true;
			const failed = prefetch.result.failed as PromiseRejectedResult;
			notifyError(ctx, "memory recall", failed.reason ?? failed);
		}
		const recalls = settledCurrent.filter((recall): recall is RecallItem => {
			if (!recall) return false;
			// The main agent can complete a Read while the selector is pending.
			const loadedMtime = state.recalled.get(recall.filename);
			return !state.recalled.has(recall.filename) || (Number.isFinite(loadedMtime) && loadedMtime !== recall.mtimeMs);
		});
		for (const recall of recalls) {
			state.recalled.set(recall.filename, recall.mtimeMs);
			state.loadedMemoryPaths.add(recall.filename);
			state.staleLoadedMemoryPaths.delete(recall.filename);
		}
		const update = drainMemoryUpdates(state);
		if (recalls.length === 0) return updateMessage(update)?.message;
		const recalledChars = recalls.reduce((total, recall) => total + recalledMemoryChargedContent(recall).length, 0);
		state.recallBytes += recalledChars;
		return {
			customType: RECALL_MESSAGE,
			content: [update.content, recalledMemoriesPrompt(recalls)].filter(Boolean).join("\n\n"),
			display: true,
			details: {
				updates: update.updates,
				stalePaths: update.stalePaths,
				recallChars: recalledChars,
				files: recalls.map((recall) => recall.filename),
				memories: recalls.map((recall) => ({
					path: recall.filename,
					mtimeMs: recall.mtimeMs,
					chars: recalledMemoryChargedContent(recall).length,
				})),
				updatedPaths: update.paths,
			},
		};
	}

	// Raw input can still be transformed or handled by another extension.
	pi.on("message_end", (event, ctx) => {
		const state = runtime;
		if (!state?.config.enabled || !state.paths || !ctx.isProjectTrusted() || state.shuttingDown) return;
		state.parentContext?.messages.push(...structuredClone(convertToLlm([event.message])));
		if (event.message.role !== "user") return;
		const prepared = state.awaitingPreparedUserMessage;
		state.awaitingPreparedUserMessage = false;
		const query = userProse(event.message);
		if (!query) return;
		state.inputSerial++;
		if (state.activeExtraction || state.extractionPreparations.size > 0) state.trailingExtraction = true;
		if (prepared) return;
		const prefetch = startRecallPrefetch(state, query, ctx);
		if (prefetch) prefetch.waiting = true;
	});

	pi.on("before_agent_start", async (event, ctx) => {
		const state = runtime;
		const paths = state?.paths;
		if (state && !ctx.isProjectTrusted()) {
			cancelRecallPrefetch(state);
			invalidatePasses(state);
			updateMaintenanceStatus(ctx, state);
			return;
		}
		if (!state?.config.enabled || !paths) return;
		// Custom startup events in Pi 1.2 have no user prompt.
		let prefetch: RecallPrefetch | undefined;
		if (event.messageType === "user") {
			const query = event.prompt.trim();
			prefetch = state.prefetch;
			if (!prefetch || prefetch.consumed || prefetch.query !== query || prefetch.generation !== state.generation)
				prefetch = startRecallPrefetch(state, query, ctx);
			state.awaitingPreparedUserMessage = true;
		}
		if (!prefetch) await captureExternalMemoryChanges(state);
		if (state.memoryIndexPrompt === undefined) {
			state.memoryIndexPrompt = indexPrompt(await readIndex(paths.memoryDir), paths.memoryDir);
			const indexSnapshot = await snapshotMarkdownFile(
				paths.memoryDir,
				"MEMORY.md",
				state.turnSnapshot.get("MEMORY.md"),
			);
			if (indexSnapshot) state.turnSnapshot.set("MEMORY.md", indexSnapshot);
			else state.turnSnapshot.delete("MEMORY.md");
			state.loadedMemoryPaths.add("MEMORY.md");
			state.staleLoadedMemoryPaths.delete("MEMORY.md");
		}
		event.systemPromptOptions.sections.auto_memory = mainMemoryPrompt(paths.memoryDir);
		event.systemPromptOptions.sections.auto_memory_index = state.memoryIndexPrompt;

		if (!prefetch) return updateMessage(drainMemoryUpdates(state));
		if (!prefetch.result) {
			const remaining = Math.max(0, prefetch.startedAt + RECALL_PREFETCH_DEADLINE_MS - Date.now());
			await waitWithTimeout(
				prefetch.promise.catch(() => undefined),
				remaining,
			);
		}
		if (prefetch.result) {
			const message = await consumeRecallPrefetch(state, prefetch, ctx);
			return message ? { message } : undefined;
		}
		prefetch.waiting = true;
		return updateMessage(drainMemoryUpdates(state));
	});

	pi.on("context", (event, ctx) => {
		const state = runtime;
		if (!state?.config.enabled || !state.paths || !ctx.isProjectTrusted()) return;
		// Context transformations are request-local. Retain updates until the next
		// before_agent_start persists them, so every call in this run sees them.
		const update = updateMessage(drainMemoryUpdates(state, false));
		if (!update) return;
		return {
			messages: [...event.messages, { role: "custom" as const, ...update.message, timestamp: Date.now() }],
		};
	});

	pi.on("context_with_system", (event, ctx) => {
		const state = runtime;
		if (!state?.config.enabled || !state.paths || !ctx.isProjectTrusted() || !ctx.model) return;
		// Image blocking runs after this hook. In that mode, use the independent
		// request path rather than claiming this is the provider's exact prefix.
		state.parentContext = pi.getSettings().images?.blockImages
			? undefined
			: {
					model: ctx.model,
					messages: structuredClone(convertToLlm(event.messages)),
					sessionId: ctx.sessionManager.getSessionId(),
				};
	});

	pi.on("turn_start", async (_event, ctx) => {
		const state = runtime;
		const paths = state?.paths;
		if (!state?.config.enabled || !paths || !ctx.isProjectTrusted()) return;
		// before_agent_start already captured the request boundary. Keep that
		// baseline so a write racing between the two hooks is not hidden.
		for (const [path, expected] of state.maintenanceSnapshots) {
			const current = await snapshotMarkdownFile(paths.memoryDir, path, state.turnSnapshot.get(path));
			if ((current?.hash ?? null) === expected) {
				state.maintenanceSnapshots.delete(path);
				// Advance only our own writes so later change detection does not
				// announce them again as external edits.
				if (current) state.turnSnapshot.set(path, current);
				else state.turnSnapshot.delete(path);
			}
		}
	});

	pi.on("tool_call", async (event, ctx) => {
		const state = runtime;
		const paths = state?.paths;
		if (!state?.config.enabled || !paths) return;
		if (!ctx.isProjectTrusted()) {
			if (
				["read", "write", "edit"].includes(event.toolName) &&
				memoryPathFromToolInput(paths.memoryDir, ctx.cwd, event.input)
			)
				return { block: true, reason: "Project trust was revoked; project memory file access is denied" };
			return;
		}
		if (event.toolName === "read") {
			const filePath = memoryPathFromToolInput(paths.memoryDir, ctx.cwd, event.input);
			if (!filePath) return;
			const relativePath = relative(paths.memoryDir, filePath).split(sep).join("/");
			const snapshot = await snapshotMarkdownFile(paths.memoryDir, relativePath, state.turnSnapshot.get(relativePath));
			if (snapshot) state.readSnapshots.set(event.toolCallId, { path: relativePath, snapshot });
			return;
		}
	});

	pi.on("tool_result", async (event, ctx) => {
		const state = runtime;
		const paths = state?.paths;
		if (!state?.config.enabled || !paths) return;
		if (event.isError) {
			if (event.toolName === "read") state.readSnapshots.delete(event.toolCallId);
			return;
		}
		const filePath = memoryPathFromToolInput(paths.memoryDir, ctx.cwd, event.input);
		if (!filePath) return;
		const relativePath = relative(paths.memoryDir, filePath).split(sep).join("/");
		if (event.toolName === "read") {
			const resultText = event.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
			const beforeRead = state.readSnapshots.get(event.toolCallId);
			state.readSnapshots.delete(event.toolCallId);
			const currentSnapshot = await snapshotMarkdownFile(paths.memoryDir, relativePath, beforeRead?.snapshot);
			const unchangedDuringRead =
				beforeRead?.path === relativePath &&
				currentSnapshot !== undefined &&
				beforeRead.snapshot.hash === currentSnapshot.hash;
			if (unchangedDuringRead) state.turnSnapshot.set(relativePath, currentSnapshot);
			// Claude suppresses recall only after the ordinary Read state records a
			// complete view. Partial pages remain eligible for automatic recall.
			if (isCompleteMemoryRead(event.input, event) && unchangedDuringRead) {
				state.recalled.set(relativePath, currentSnapshot.mtimeMs);
				state.loadedMemoryPaths.add(relativePath);
				state.staleLoadedMemoryPaths.delete(relativePath);
			}
			if (unchangedDuringRead) {
				const reminder = staleMemoryToolReminder(currentSnapshot.mtimeMs);
				if (reminder) return replaceToolResultText(event, `${reminder}\n${resultText}`);
			}
			return;
		}
		if (event.toolName !== "write" && event.toolName !== "edit") return;
		state.directWriteEpoch++;
		state.loadedMemoryPaths.add(relativePath);
		state.staleLoadedMemoryPaths.delete(relativePath);
		try {
			const current = await readMarkdownFileSnapshot(paths.memoryDir, relativePath);
			if (!current) return;
			state.turnSnapshot.set(relativePath, current.snapshot);
			const warnings = lintMemoryContent(filePath, current.content, new Set(state.turnSnapshot.keys()));
			if (warnings.length > 0) {
				const reminder = `<system-reminder source="project-memory-lint">\nThe memory write succeeded, but it needs correction:\n${warnings.map((value) => `- ${value}`).join("\n")}\n</system-reminder>`;
				const existing = event.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
				return replaceToolResultText(event, `${existing}\n\n${reminder}`);
			}
		} catch {}
	});

	pi.on("agent_before_settle", async (_event, ctx) => {
		const state = runtime;
		if (!state?.config.enabled || !state.paths || !ctx.isProjectTrusted()) return;
		await captureExternalMemoryChanges(state);
	});

	pi.on("agent_settled", async (event, ctx) => {
		const state = runtime;
		if (!state?.config.enabled || !state.paths || !ctx.isProjectTrusted() || event.aborted || state.shuttingDown)
			return;
		await captureExternalMemoryChanges(state);
		// Claude dispatches extraction and dream from the same settled turn, but
		// does not serialize the two independent lock domains.
		void trackExtractionPreparation(state, () => scheduleExtraction(ctx, state, "cadence")).catch((error) =>
			notifyError(ctx, "memory extraction", error),
		);
		void trackMaintenance(state, () => maybeDream(ctx, state, false)).catch((error) =>
			notifyError(ctx, "memory dream", error),
		);
	});

	pi.on("session_before_compact", async (_event, ctx) => {
		const state = runtime;
		if (!state?.config.enabled || !state.paths || !ctx.isProjectTrusted() || state.shuttingDown) return;
		// Join extraction while its tracked operation is still preparing topics or
		// acquiring the lock, before activeExtraction has been installed. Loop so a
		// dispatch registered while an earlier preparation settles is also joined.
		while (state.extractionPreparations.size > 0) await Promise.allSettled([...state.extractionPreparations]);
		if (state.activeExtraction) await state.activeExtraction;
		state.compactionCursorOutcome = "failed";
		const outcome = await trackExtractionPreparation(state, () => scheduleExtraction(ctx, state, "compact"));
		state.compactionCursorOutcome = outcome;
	});

	pi.on("session_compact", (_event, ctx) => {
		const state = runtime;
		if (!state) return;
		const extractionConsumed = state.compactionCursorOutcome === "consumed";
		state.compactionCursorOutcome = undefined;
		if (extractionConsumed) {
			// Pi projects the compaction summary before retained, already-consumed messages.
			state.cursorEntryId = ctx.sessionManager.buildSessionProjection().entries.at(-1)?.sourceEntry.id;
		}
		// A successful compaction removes earlier recall messages from the model
		// context even when pre-compaction extraction was disabled or failed.
		cancelRecallPrefetch(state);
		state.memoryIndexPrompt = undefined;
		state.parentContext = undefined;
		state.selectorHistory.length = 0;
		state.recalled.clear();
		state.recallBytes = 0;
		state.loadedMemoryPaths.clear();
		state.staleLoadedMemoryPaths.clear();
	});

	pi.on("session_compact_failed", () => {
		if (runtime) runtime.compactionCursorOutcome = undefined;
	});

	const cancelPrefetchForNavigation = () => {
		if (runtime) cancelRecallPrefetch(runtime);
	};
	pi.on("session_before_switch", cancelPrefetchForNavigation);
	pi.on("session_before_fork", cancelPrefetchForNavigation);
	pi.on("session_before_tree", cancelPrefetchForNavigation);
	pi.on("session_tree", async (_event, ctx) => {
		const state = runtime;
		if (!state) return;
		cancelRecallPrefetch(state);
		state.recalled = await restoreRecalledPaths(ctx, state.paths?.memoryDir);
		state.recallBytes = restoreRecallBytes(ctx);
		state.loadedMemoryPaths = new Set(state.recalled.keys());
		state.staleLoadedMemoryPaths.clear();
		state.memoryIndexPrompt = undefined;
		state.parentContext = undefined;
		state.selectorHistory.length = 0;
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		const state = runtime;
		if (!state) return;
		state.shuttingDown = true;
		updateMaintenanceStatus(ctx, state);
		cancelRecallPrefetch(state);
		cancelIdleTimer(state);
		const drain = (async () => {
			await Promise.allSettled([...state.maintenancePasses]);
			if (state.paths && !state.shutdownTimedOut)
				await trackExtractionPreparation(state, () => scheduleExtraction(ctx, state, "shutdown"));
			await Promise.allSettled(
				[state.activeExtraction, state.activeDream].filter((value): value is Promise<ChildRunResult | null> => !!value),
			);
		})();
		// Claude Code's extraction drainer waits up to 60 seconds before teardown.
		const completed = await waitWithTimeout(
			drain.then(() => true),
			60_000,
		);
		if (!completed) {
			state.shutdownTimedOut = true;
			invalidatePasses(state);
			await waitWithTimeout(
				drain.catch(() => {}),
				1_000,
			);
		}
		state.maintenanceStatus?.dispose();
		runtime = undefined;
	});

	async function runMemoryCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
		const state = runtime;
		if (!state)
			return ctx.ui.notify(
				blockedByTrust
					? "Project memory is disabled until this project is trusted"
					: "Project memory has not initialized",
				"error",
			);
		if (!ctx.isProjectTrusted()) {
			invalidatePasses(state);
			updateMaintenanceStatus(ctx, state);
			return ctx.ui.notify("Project trust was revoked; project memory is disabled", "error");
		}
		const command = args.trim() || "status";
		if (command === "status") state.shell ??= await probeShell({ shellPath: state.config.shellPath });
		if (command === "reload-config") {
			const previous = state.config;
			let next: ProjectMemoryConfig;
			try {
				next = await loadConfig();
			} catch (error) {
				return ctx.ui.notify(errorMessage(error), "error");
			}
			const deferredDirectoryChange = next.autoMemoryDirectory !== state.sessionMemoryDirectory;
			next.autoMemoryDirectory = state.sessionMemoryDirectory;
			const enabledPaths = !previous.enabled && next.enabled ? await initializeRuntimePaths(ctx, next) : undefined;
			cancelRecallPrefetch(state);
			cancelIdleTimer(state);
			if (previous.enabled && next.enabled) invalidatePasses(state);
			state.config = next;
			state.shell = undefined;
			state.memoryIndexPrompt = undefined;
			state.parentContext = undefined;
			state.selectorHistory.length = 0;
			state.lastDreamScanAt = 0;
			if (previous.enabled && !next.enabled) {
				invalidatePasses(state);
				state.paths = undefined;
				state.turnSnapshot = new Map();
				state.pendingMemoryUpdates.length = 0;
			} else if (!previous.enabled && next.enabled && enabledPaths) {
				state.paths = enabledPaths;
				state.turnSnapshot = await snapshotMarkdown(enabledPaths.memoryDir);
			}
			if (
				state.config.enabled &&
				state.config.extraction.enabled &&
				hasUserProse(cursorSlice(ctx, state.cursorEntryId))
			)
				scheduleIdle(ctx, state);
			updateMaintenanceStatus(ctx, state);
			return ctx.ui.notify(
				`Reloaded ${configPath()}${deferredDirectoryChange ? "; autoMemoryDirectory changes apply after the next session start" : ""}`,
				"info",
			);
		}
		if (command === "status" && (!state.config.enabled || !state.paths)) {
			return ctx.ui.notify(
				[
					`Project: ${ctx.cwd}`,
					...(state.shell ? [shellStatusLine(state.shell)] : []),
					"Auto-memory: disabled",
					`Extraction: ${state.config.extraction.enabled ? "enabled, held by auto-memory" : "disabled"}`,
					`Auto-dream: ${state.config.dream.enabled ? "enabled, held by auto-memory" : "disabled"}`,
					"Memory directory: not initialized",
				].join("\n"),
				"info",
			);
		}
		if (!state.config.enabled || !state.paths) {
			return ctx.ui.notify(
				"Project memory is disabled by config; only status and reload-config are available",
				"error",
			);
		}
		if (command === "list") {
			const topics = await scanTopics(state.paths.memoryDir);
			return ctx.ui.notify(
				topics.length
					? topics
							.map((topic) => `[${topic.type}] ${topic.filename} — ${topic.description || "(no description)"}`)
							.join("\n")
					: "No memory topics",
				"info",
			);
		}
		if (command === "extract") {
			await trackExtractionPreparation(state, () => scheduleExtraction(ctx, state, "manual"));
			return;
		}
		if (command === "dream") {
			if (!state.config.dream.enabled)
				return ctx.ui.notify("Memory dream is disabled by the global dream gate", "warning");
			await trackMaintenance(state, () => maybeDream(ctx, state, true));
			return;
		}
		if (command !== "status") return ctx.ui.notify("Usage: /memory status|list|extract|dream|reload-config", "error");
		const topics = await scanTopics(state.paths.memoryDir);
		ctx.ui.notify(memoryStatusLines(state, ctx, topics.length).join("\n"), "info");
	}

	pi.registerCommand("memory", {
		description: "Open project memory: browse, search, preview, extract, or dream",
		getArgumentCompletions: (prefix) =>
			["status", "list", "extract", "dream", "reload-config"]
				.filter((command) => command.startsWith(prefix))
				.map((command) => ({ value: command, label: command })),
		handler: async (args, ctx) => {
			const command = args.trim();
			if (ctx.mode !== "tui" || !["", "status", "list"].includes(command)) return runMemoryCommand(args, ctx);
			if (!runtime || !ctx.isProjectTrusted()) return runMemoryCommand(args, ctx);
			const state = runtime;
			const loadPanelData = async (): Promise<MemoryPanelData> => {
				if (runtime !== state || !ctx.isProjectTrusted())
					throw new Error("Memory session changed. Close and reopen /memory.");
				const paths = state.paths;
				const topics = paths ? await scanTopics(paths.memoryDir) : [];
				return {
					project: paths?.projectRoot ?? ctx.cwd,
					configFile: displayPath(configPath()),
					enabled: state.config.enabled,
					dreamEnabled: state.config.dream.enabled,
					extracting: !!state.activeExtraction,
					dreaming: !!state.activeDream,
					recallCharacters: state.recallBytes,
					recallBudget: RECALL_BUDGET,
					topics,
					overview: [
						...(state.config.enabled
							? [
									`Selector: ${state.prefetch && !state.prefetch.result && !state.prefetch.controller.signal.aborted ? "running" : "automatic"}`,
									`Extractor: ${state.activeExtraction ? "running" : state.config.extraction.enabled ? "automatic" : "manual only"}`,
									`Dream: ${state.activeDream ? "running" : state.config.dream.enabled ? "automatic" : "disabled"}`,
								]
							: ["Memory is disabled. Edit config.json and reload configuration to enable it."]),
						`Memory: ${paths ? displayPath(paths.memoryDir) : "not initialized; enable memory in config.json"}`,
						...(state.lastExtractionError ? [`Extractor error: ${state.lastExtractionError}`] : []),
						...(state.lastDreamError ? [`Dream error: ${state.lastDreamError}`] : []),
					],
					models: memoryModelViews(state, ctx),
				};
			};
			const data = await loadPanelData();
			state.panelOpen = true;
			updateMaintenanceStatus(ctx, state);
			try {
				await openMemoryPanel(
					ctx,
					data,
					async (topic) => {
						const paths = state.paths;
						const generation = state.generation;
						if (!paths || runtime !== state || !ctx.isProjectTrusted())
							throw new Error("Memory session changed. Close and reopen /memory.");
						assertContainedMarkdown(paths.memoryDir, topic.filePath);
						if (!(await safeMainMemoryTarget(paths.memoryDir, topic.filePath)))
							throw new Error("Memory file is no longer a regular file inside the memory directory.");
						const item = await recallTopic(topic);
						if (runtime !== state || state.generation !== generation || !ctx.isProjectTrusted())
							throw new Error("Memory session changed. Close and reopen /memory.");
						return `File: ${topic.filePath}\nType: ${topic.type}\n${topic.description}\n\n${item.content}${item.truncated ? "\n\nPreview limited to 200 lines or 4 KiB. Open the file directly for its full contents." : ""}`;
					},
					command === "list" ? "topics" : "overview",
					async (action, notify) => {
						if (runtime !== state || !ctx.isProjectTrusted())
							throw new Error("Memory session changed. Close and reopen /memory.");
						if (action !== "refresh") {
							const panelContext = {
								...ctx,
								ui: {
									...ctx.ui,
									notify: (message: string, level: "info" | "warning" | "error" = "info") => {
										if (state.panelOpen) notify(message, level);
										else ctx.ui.notify(message, level);
									},
								},
							};
							await runMemoryCommand(action, panelContext);
						}
						return loadPanelData();
					},
				);
			} finally {
				state.panelOpen = false;
				if (runtime === state) updateMaintenanceStatus(ctx, state);
			}
		},
	});
}

async function initializeRuntimePaths(ctx: ExtensionContext, config: ProjectMemoryConfig): Promise<ProjectPaths> {
	const paths = await resolveProjectPaths(ctx.cwd, config.autoMemoryDirectory);
	await initializeProjectPaths(paths);
	return paths;
}

async function captureExternalMemoryChanges(state: RuntimeState): Promise<void> {
	const previous = state.captureMemoryChanges ?? Promise.resolve();
	const current = previous.catch(() => {}).then(() => captureExternalMemoryChangesPass(state));
	state.captureMemoryChanges = current;
	try {
		await current;
	} finally {
		if (state.captureMemoryChanges === current) state.captureMemoryChanges = undefined;
	}
}

async function captureExternalMemoryChangesPass(state: RuntimeState): Promise<void> {
	const paths = state.paths;
	if (!paths) return;
	const currentSnapshot = await snapshotMarkdown(paths.memoryDir, state.turnSnapshot);
	const changed = diffSnapshots(state.turnSnapshot, currentSnapshot);
	const externalChanges = changed.filter((path) => {
		if (!state.maintenanceSnapshots.has(path)) return true;
		const expected = state.maintenanceSnapshots.get(path) ?? null;
		state.maintenanceSnapshots.delete(path);
		return (currentSnapshot.get(path)?.hash ?? null) !== expected;
	});
	const staleExternalPaths: string[] = [];
	for (const relativePath of externalChanges) {
		state.recalled.delete(relativePath);
		if (state.loadedMemoryPaths.has(relativePath)) {
			state.staleLoadedMemoryPaths.add(relativePath);
			staleExternalPaths.push(relativePath);
		}
	}
	if (staleExternalPaths.length > 0) queueMemoryUpdate(state, "external", staleExternalPaths);
	state.turnSnapshot = currentSnapshot;
}

async function safeMainMemoryTarget(memoryDir: string, filePath: string): Promise<boolean> {
	try {
		const root = await realpath(memoryDir);
		try {
			const target = await lstat(filePath);
			if (target.isSymbolicLink() || !target.isFile()) return false;
			const canonicalTarget = await realpath(filePath);
			if (canonicalTarget !== root && !canonicalTarget.startsWith(`${root}${sep}`)) return false;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
		}
		let parent = dirname(filePath);
		for (;;) {
			try {
				const canonical = await realpath(parent);
				return canonical === root || canonical.startsWith(`${root}${sep}`);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
				const next = dirname(parent);
				if (next === parent) return false;
				parent = next;
			}
		}
	} catch {
		return false;
	}
}

function activeBranchEntries(ctx: ExtensionContext): ReturnType<ExtensionContext["sessionManager"]["getBranch"]> {
	const branch = ctx.sessionManager.getBranch();
	const compact = branch.findLastIndex((entry) => entry.type === "compaction");
	return compact < 0 ? branch : branch.slice(compact);
}

function isCompleteMemoryRead(
	input: Record<string, unknown>,
	result: { content: readonly { type: string; text?: string }[]; details?: unknown },
): boolean {
	const offset = input.offset;
	const details = result.details;
	return (
		!(typeof offset === "number" && Number.isFinite(offset) && offset > 1) &&
		!(details && typeof details === "object" && "truncation" in details && details.truncation) &&
		result.content.every((block) => block.type === "text") &&
		!result.content.some((block) => /\[(?:Showing lines|\d+ more lines in file\.|Read partial)/.test(block.text ?? ""))
	);
}

async function restoreRecalledPaths(ctx: ExtensionContext, memoryDir?: string): Promise<Map<string, number>> {
	const recalled = new Map<string, number>();
	const readCalls = new Map<string, Record<string, unknown>>();
	for (const entry of activeBranchEntries(ctx)) {
		if (memoryDir && entry.type === "message") {
			const message = entry.message;
			if (message.role === "assistant") {
				for (const block of message.content) {
					if (block.type === "toolCall" && block.name === "read") readCalls.set(block.id, block.arguments);
				}
			} else if (message.role === "toolResult" && message.toolName === "read") {
				const input = readCalls.get(message.toolCallId);
				readCalls.delete(message.toolCallId);
				if (!input || message.isError || !isCompleteMemoryRead(input, message)) continue;
				const filePath = memoryPathFromToolInput(memoryDir, ctx.cwd, input);
				if (!filePath) continue;
				const relativePath = relative(memoryDir, filePath).split(sep).join("/");
				const snapshot = await snapshotMarkdownFile(memoryDir, relativePath);
				if (!snapshot) continue;
				const text = message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
				// The stale reminder is prepended to the tool result, not stored in the file.
				const withoutReminder = text.replace(
					/^<system-reminder>\nThis memory is \d+ days old\.[^\n]*\n<\/system-reminder>\n/,
					"",
				);
				if (sha256(text) === snapshot.hash || sha256(withoutReminder) === snapshot.hash)
					recalled.set(relativePath, snapshot.mtimeMs);
			}
			continue;
		}
		if (entry.type !== "custom_message" || entry.customType !== RECALL_MESSAGE) continue;
		const details = entry.details && typeof entry.details === "object" ? entry.details : {};
		const typed = details as { files?: unknown; memories?: unknown };
		if (Array.isArray(typed.memories)) {
			for (const value of typed.memories) {
				if (!value || typeof value !== "object") continue;
				const item = value as { path?: unknown; mtimeMs?: unknown };
				if (typeof item.path === "string" && typeof item.mtimeMs === "number") recalled.set(item.path, item.mtimeMs);
			}
		} else if (Array.isArray(typed.files)) {
			// Backward-compatible entries had no mtime; suppress those files for this branch.
			for (const file of typed.files) if (typeof file === "string") recalled.set(file, Number.NaN);
		}
	}
	return recalled;
}

function restoreRecallBytes(ctx: ExtensionContext): number {
	let total = 0;
	for (const entry of activeBranchEntries(ctx)) {
		if (entry.type !== "custom_message" || entry.customType !== RECALL_MESSAGE) continue;
		const details = entry.details && typeof entry.details === "object" ? entry.details : {};
		const memories = (details as { memories?: unknown }).memories;
		if (!Array.isArray(memories)) {
			const recallChars = (details as { recallChars?: unknown }).recallChars;
			if (typeof recallChars === "number" && Number.isSafeInteger(recallChars) && recallChars > 0) total += recallChars;
			else total += typeof entry.content === "string" ? entry.content.length : 0;
			continue;
		}
		for (const value of memories) {
			if (!value || typeof value !== "object") continue;
			const item = value as { chars?: unknown; bytes?: unknown };
			const chars = item.chars ?? item.bytes;
			if (typeof chars === "number" && Number.isSafeInteger(chars) && chars > 0) total += chars;
		}
	}
	return total;
}

function cursorSlice(
	ctx: ExtensionContext,
	cursorEntryId: string | undefined,
	projection = ctx.sessionManager.buildSessionProjection(),
): AgentMessage[] {
	if (!cursorEntryId) return projection.messages;
	const position = projection.entries.findIndex((entry) => entry.sourceEntry.id === cursorEntryId);
	// A cursor omitted by compaction or branch navigation is stale. Replaying the
	// whole active projection is safer than silently skipping durable user prose.
	return position < 0 ? projection.messages : projection.entries.slice(position + 1).flatMap((entry) => entry.messages);
}

function hasSuccessfulMemoryWrite(messages: AgentMessage[], memoryDir: string, cwd: string): boolean {
	const calls = new Map<string, string>();
	for (const message of messages) {
		if (message.role === "assistant") {
			for (const block of message.content) {
				if (
					block.type === "toolCall" &&
					(block.name === "write" || block.name === "edit") &&
					memoryPathFromToolInput(memoryDir, cwd, block.arguments)
				)
					calls.set(block.id, block.name);
			}
		} else if (message.role === "toolResult") {
			const name = calls.get(message.toolCallId);
			calls.delete(message.toolCallId);
			if (name === message.toolName && !message.isError) return true;
		}
	}
	return false;
}

function userProse(message: AgentMessage): string {
	if (message.role !== "user") return "";
	return (
		typeof message.content === "string"
			? message.content
			: message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join(" ")
	).trim();
}

function hasUserProse(messages: AgentMessage[]): boolean {
	// Claude Ie/Le checks each string or text block separately, without CJK segmentation.
	const hasThreeWords = (text: string) => text.split(/\s+/).filter(Boolean).length >= 3;
	return messages.some(
		(message) =>
			message.role === "user" &&
			(typeof message.content === "string"
				? hasThreeWords(message.content)
				: message.content.some((block) => block.type === "text" && hasThreeWords(block.text))),
	);
}

type ExtractionTrigger = "cadence" | "idle" | "trailing" | "manual" | "compact" | "shutdown";

interface OperationIdentity {
	generation: number;
	paths: ProjectPaths;
	config: ProjectMemoryConfig;
	lockIsValid?: () => boolean;
}

function operationIsCurrent(state: RuntimeState, ctx: ExtensionContext, identity: OperationIdentity): boolean {
	return (
		state.config.enabled &&
		state.paths === identity.paths &&
		state.config === identity.config &&
		state.generation === identity.generation &&
		ctx.isProjectTrusted() &&
		(identity.lockIsValid?.() ?? true)
	);
}

async function scheduleExtraction(
	ctx: ExtensionContext,
	state: RuntimeState,
	trigger: ExtractionTrigger,
): Promise<"consumed" | "failed"> {
	const manual = trigger === "manual";
	const paths = state.paths;
	if (!paths || !state.config.enabled || (!state.config.extraction.enabled && !manual) || state.shutdownTimedOut)
		return "failed";
	const identity: OperationIdentity = { generation: state.generation, paths, config: state.config };
	const inputSerial = state.inputSerial;
	const trailingAtEntry = state.trailingExtraction;
	if (state.shuttingDown && trigger !== "shutdown") return "failed";
	if (!ctx.isProjectTrusted()) return "failed";

	const projection = ctx.sessionManager.buildSessionProjection();
	const sinceCursor = [...cursorSlice(ctx, state.cursorEntryId, projection)];
	const parentContext = state.parentContext && { ...state.parentContext, messages: [...state.parentContext.messages] };
	const leafId = projection.entries.at(-1)?.sourceEntry.id;
	const directWriteEpoch = state.directWriteEpoch;
	if (
		!manual &&
		(directWriteEpoch > state.handledDirectWriteEpoch ||
			hasSuccessfulMemoryWrite(sinceCursor, paths.memoryDir, ctx.cwd))
	) {
		state.cursorEntryId = leafId;
		state.turnsSinceExtraction = 0;
		state.handledDirectWriteEpoch = directWriteEpoch;
		return "consumed";
	}
	if (!hasUserProse(sinceCursor)) {
		if (manual && ctx.hasUI)
			ctx.ui.notify(
				"Nothing to extract. Add a user message with at least three whitespace-separated words, or ask the agent to save a memory directly.",
				"info",
			);
		if (!manual) state.cursorEntryId = leafId;
		return "consumed";
	}
	if (trigger === "cadence") state.turnsSinceExtraction++;
	if (trigger === "cadence" && state.turnsSinceExtraction < state.config.extraction.everyNTurns) {
		scheduleIdle(ctx, state);
		return "failed";
	}
	if (state.activeExtraction) {
		if (manual && ctx.hasUI) ctx.ui.notify("Memory extraction is already running; pending input will follow.", "info");
		state.trailingExtraction = true;
		return "failed";
	}
	cancelIdleTimer(state);
	if (state.shuttingDown && trigger !== "shutdown") return "failed";

	const release = await acquireLock(join(paths.locksDir, "extract.lock"), 15 * 60_000);
	if (!release) {
		if (manual && ctx.hasUI) ctx.ui.notify("Memory extraction is already running in another process", "warning");
		else if (!state.shuttingDown) scheduleIdle(ctx, state);
		return "failed";
	}
	identity.lockIsValid = release.isValid;
	try {
		const abandoned = () =>
			state.shutdownTimedOut ||
			(state.shuttingDown && trigger !== "shutdown") ||
			!operationIsCurrent(state, ctx, identity);
		await release.assertValid();
		if (abandoned()) return "failed";
		const topics = await scanTopics(paths.memoryDir);
		if (abandoned()) return "failed";
		const shell = await refreshShell(ctx, state);
		if (abandoned()) return "failed";
		const recentLimit =
			state.config.extraction.recentMessages === "inherit"
				? Number.MAX_SAFE_INTEGER
				: state.config.extraction.recentMessages;
		const source = sanitizeRecentMessages(sinceCursor, recentLimit);
		const sourceMessageCount = source.filter(
			(message) => message.role === "user" || message.role === "assistant",
		).length;
		// Reload may turn auto-memory off or replace the operation's config while
		// topic scanning and transcript preparation are in flight. Consume only the
		// trailing request that this new pass is about; input during the child sets
		// the flag again for the controller to flush afterward.
		if (!operationIsCurrent(state, ctx, identity)) return "failed";
		state.trailingExtraction = state.inputSerial !== inputSerial || (trigger !== "trailing" && trailingAtEntry);
		const abortController = new AbortController();
		const stopValidityMonitor = monitorOperationValidity(state, ctx, identity, abortController);
		state.extractionAbortController = abortController;
		// A resumed session can extract before before_agent_start installs these rules.
		const pass = runChildAgent({
			role: "extractor",
			prompt: extractionPrompt(sourceMessageCount, topics, paths.memoryDir, shell.available),
			sourceMessages: source,
			systemPrompt: childSystemPrompt(ctx, paths.memoryDir),
			parentContext: identity.config.extraction.recentMessages === "inherit" ? parentContext : undefined,
			codemode: state.getCodemode(),
			config: identity.config,
			paths,
			shell,
			isCurrentGeneration: () => operationIsCurrent(state, ctx, identity),
			onUsage: (usage) => addUsage(state.backgroundUsage.extractor, usage),
			onTouched: (path, hash) => {
				state.maintenanceSnapshots.set(path, hash);
				queueMemoryUpdate(state, "extract", [path]);
			},
			signal: abortController.signal,
			ctx,
		})
			.then((result) => {
				if (!operationIsCurrent(state, ctx, identity) || abortController.signal.aborted) return result;
				// Claude's local file-mode branch advances its cursor after the fork
				// returns, including API-error/max-turn outcomes. Only a thrown fork
				// leaves the cursor for retry.
				state.lastExtractionError = result.error;
				if (result.error) notifyError(ctx, "memory extraction", result.error);
				state.cursorEntryId = leafId;
				state.turnsSinceExtraction = 0;
				state.handledDirectWriteEpoch = Math.max(state.handledDirectWriteEpoch, directWriteEpoch);
				if (result.touchedPaths.length > 0) showMemoryUpdate(ctx, state, "extract");
				else if (manual && !result.error && ctx.hasUI && !state.panelOpen)
					ctx.ui.notify("No memory changes needed.", "info");
				return result;
			})
			.catch((error) => {
				state.lastExtractionError = errorMessage(error);
				notifyError(ctx, "memory extraction", error);
				return null;
			})
			.finally(() => {
				stopValidityMonitor();
				if (state.extractionAbortController === abortController) state.extractionAbortController = undefined;
				if (state.activeExtraction === pass) state.activeExtraction = undefined;
				if (operationIsCurrent(state, ctx, identity)) updateMaintenanceStatus(ctx, state);
			});
		state.activeExtraction = pass;
		updateMaintenanceStatus(ctx, state);
		const result = await pass;
		if (!result || !operationIsCurrent(state, ctx, identity) || abortController.signal.aborted) return "failed";
	} finally {
		await release();
		if (state.trailingExtraction && !state.shuttingDown) scheduleIdle(ctx, state);
	}
	await flushTrailingExtraction(ctx, state);
	return "consumed";
}

async function flushTrailingExtraction(ctx: ExtensionContext, state: RuntimeState): Promise<void> {
	if (!state.trailingExtraction || state.shuttingDown || !ctx.isIdle()) return;
	state.trailingExtraction = false;
	const outcome = await trackExtractionPreparation(state, () => scheduleExtraction(ctx, state, "trailing"));
	if (outcome !== "consumed") {
		state.trailingExtraction = true;
		scheduleIdle(ctx, state);
	}
}

async function maybeDream(ctx: ExtensionContext, state: RuntimeState, manual: boolean): Promise<void> {
	const paths = state.paths;
	// The dream setting is a global gate: manual invocation skips cadence gates,
	// not the user's explicit off switch.
	if (!paths || !state.config.enabled || !state.config.dream.enabled || state.shuttingDown || !ctx.isProjectTrusted())
		return;
	const identity: OperationIdentity = { generation: state.generation, paths, config: state.config };
	const parentContext = state.parentContext && { ...state.parentContext, messages: [...state.parentContext.messages] };
	if (state.activeDream) {
		if (manual) ctx.ui.notify("Memory dream is already running", "warning");
		return;
	}
	const persistent = await readState(paths);
	const now = Date.now();
	if (!manual && now - persistent.lastDreamAt < state.config.dream.minimumHours * 3_600_000) return;
	if (!manual && now - state.lastDreamScanAt < state.config.dream.scanThrottleSeconds * 1000) return;
	state.lastDreamScanAt = now;
	const sessionDir = ctx.sessionManager.getSessionDir();
	const sessionManagerScope = ctx.sessionManager as typeof ctx.sessionManager & {
		usesDefaultSessionDir?: () => boolean;
	};
	const projectFilter =
		typeof sessionManagerScope.usesDefaultSessionDir === "function" && sessionManagerScope.usesDefaultSessionDir()
			? undefined
			: paths.projectRoot;
	const sessionIds = await listOtherSessionIds(
		sessionDir,
		ctx.sessionManager.getSessionFile(),
		ctx.sessionManager.getSessionId(),
		persistent.lastDreamAt,
		projectFilter,
	);
	if (!manual && sessionIds.length < state.config.dream.minimumOtherSessions) return;
	if (state.shuttingDown || !ctx.isProjectTrusted()) return;
	const release = await acquireLock(join(paths.locksDir, "dream.lock"), 3_600_000);
	if (!release) {
		if (manual) ctx.ui.notify("Dream is already running in another process", "warning");
		return;
	}
	identity.lockIsValid = release.isValid;
	const previousDreamAt = persistent.lastDreamAt;
	const startedAt = Date.now();
	const abortController = new AbortController();
	const stopValidityMonitor = monitorOperationValidity(state, ctx, identity, abortController);
	let reservationCommitted = false;
	let phase: "fork" | "completion" = "fork";
	const rollbackReservation = async () => {
		if (reservationCommitted && phase === "fork" && !abortController.signal.aborted)
			await compareAndSwapLastDreamAt(paths, startedAt, previousDreamAt);
	};
	try {
		await release.assertValid();
		if ((!manual && !ctx.isIdle()) || state.shuttingDown || !operationIsCurrent(state, ctx, identity)) return;
		if (!(await compareAndSwapLastDreamAt(paths, previousDreamAt, startedAt, () => release.assertValid()))) return;
		reservationCommitted = true;
		if (!operationIsCurrent(state, ctx, identity)) {
			abortController.abort();
			return;
		}
		state.dreamAbortController = abortController;
		const shell = await refreshShell(ctx, state);
		const dreamSource = sanitizeRecentMessages(
			ctx.sessionManager.buildSessionProjection().messages,
			Number.POSITIVE_INFINITY,
		);
		const pass = runChildAgent({
			role: "dream",
			prompt: dreamPrompt(paths, sessionDir, sessionIds, shell.available),
			sourceMessages: dreamSource,
			systemPrompt: childSystemPrompt(ctx, paths.memoryDir),
			parentContext,
			codemode: state.getCodemode(),
			config: identity.config,
			paths,
			sessionDir,
			shell,
			isCurrentGeneration: () => operationIsCurrent(state, ctx, identity),
			onUsage: (usage) => addUsage(state.backgroundUsage.dream, usage),
			onTouched: (path, hash) => {
				state.maintenanceSnapshots.set(path, hash);
				queueMemoryUpdate(state, "dream", [path]);
			},
			signal: abortController.signal,
			ctx,
		})
			.then((result) => {
				// Any returned fork keeps its attempt time, including API errors and aborts.
				phase = "completion";
				if (!operationIsCurrent(state, ctx, identity) || abortController.signal.aborted) return result;
				state.lastDreamError = result.error;
				if (result.error) notifyError(ctx, "memory dream", result.error);
				if (result.touchedPaths.length > 0) showMemoryUpdate(ctx, state, "dream");
				else if (!result.error && manual && ctx.hasUI && !state.panelOpen)
					ctx.ui.notify("No memory changes needed.", "info");
				return result;
			})
			.catch(async (error) => {
				state.lastDreamError = errorMessage(error);
				await rollbackReservation();
				notifyError(ctx, "memory dream", error);
				return null;
			})
			.finally(() => {
				if (state.activeDream === pass) state.activeDream = undefined;
				if (operationIsCurrent(state, ctx, identity)) updateMaintenanceStatus(ctx, state);
			});
		state.activeDream = pass;
		updateMaintenanceStatus(ctx, state);
		await pass;
	} catch (error) {
		await rollbackReservation();
		throw error;
	} finally {
		stopValidityMonitor();
		if (state.dreamAbortController === abortController) state.dreamAbortController = undefined;
		await release();
	}
}

function childSystemPrompt(ctx: ExtensionContext, memoryDir: string): string {
	const parent = ctx.getSystemPrompt();
	const memory = mainMemoryPrompt(memoryDir);
	return parent.includes(memory) ? parent : `${parent}\n\n${memory}`;
}

function cancelIdleTimer(state: RuntimeState): void {
	if (state.idleTimer) clearTimeout(state.idleTimer);
	state.idleTimer = undefined;
}

function scheduleIdle(ctx: ExtensionContext, state: RuntimeState): void {
	if (state.config.extraction.idleFlushSeconds === 0 || state.idleTimer || state.shuttingDown) return;
	const deadline = Date.now() + state.config.extraction.idleFlushSeconds * 1000;
	const arm = () => {
		state.idleTimer = setTimeout(
			() => {
				state.idleTimer = undefined;
				if (state.shuttingDown) return;
				if (Date.now() < deadline) {
					arm();
					return;
				}
				if (ctx.isIdle())
					void trackExtractionPreparation(state, () => scheduleExtraction(ctx, state, "idle")).catch((error) =>
						notifyError(ctx, "memory idle extraction", error),
					);
			},
			Math.min(2_147_483_647, Math.max(1, deadline - Date.now())),
		);
		state.idleTimer.unref();
	};
	arm();
}

function monitorOperationValidity(
	state: RuntimeState,
	ctx: ExtensionContext,
	identity: OperationIdentity,
	controller: AbortController,
): () => void {
	const check = () => {
		if (!operationIsCurrent(state, ctx, identity)) controller.abort();
	};
	const timer = setInterval(check, 100);
	timer.unref();
	return () => clearInterval(timer);
}

function trackMaintenance<T>(state: RuntimeState, operation: () => Promise<T>): Promise<T> {
	return trackPass(state.maintenancePasses, Promise.resolve().then(operation));
}

function trackExtractionPreparation<T>(state: RuntimeState, operation: () => Promise<T>): Promise<T> {
	return trackPass(state.extractionPreparations, trackMaintenance(state, operation));
}

async function trackPass<T>(passes: Set<Promise<unknown>>, current: Promise<T>): Promise<T> {
	passes.add(current);
	try {
		return await current;
	} finally {
		passes.delete(current);
	}
}

function invalidatePasses(state: RuntimeState): void {
	state.generation++;
	state.parentContext = undefined;
	state.extractionAbortController?.abort();
	state.dreamAbortController?.abort();
	state.trailingExtraction = false;
}

function queueMemoryUpdate(state: RuntimeState, source: PendingMemoryUpdate["source"], paths: string[]): void {
	const changed = [...new Set(paths)].sort();
	if (changed.length === 0) return;
	for (const path of changed) {
		state.recalled.delete(path);
		if (state.loadedMemoryPaths.has(path)) state.staleLoadedMemoryPaths.add(path);
	}
	const pending = state.pendingMemoryUpdates.find((update) => update.source === source && !update.displayed);
	const unique = [...new Set([...(pending?.paths ?? []), ...changed])].sort();
	let summary: string;
	if (source === "external") {
		summary = `detected external changes to ${unique.join(", ")}`;
	} else if (unique.length === 1 && unique[0] === "MEMORY.md") {
		summary = "updated the MEMORY.md index without saving a topic memory";
	} else {
		const topicCount = unique.filter((path) => path !== "MEMORY.md").length;
		const action = source === "dream" ? "consolidated" : "saved";
		const topics = topicCount === 1 ? "topic memory" : "topic memories";
		const indexUpdate = unique.includes("MEMORY.md") ? " and updated MEMORY.md" : "";
		summary = `${action} ${topicCount} ${topics}${indexUpdate}`;
	}
	if (pending) {
		pending.summary = summary;
		pending.paths = unique;
	} else state.pendingMemoryUpdates.push({ source, summary, paths: unique });
}

function showMemoryUpdate(ctx: ExtensionContext, state: RuntimeState, source: PendingMemoryUpdate["source"]): void {
	if (!ctx.hasUI || state.shuttingDown) return;
	const updates = state.pendingMemoryUpdates.filter((update) => update.source === source && !update.displayed);
	if (!updates.length) return;
	if (!state.panelOpen)
		state.appendEntry(UPDATE_MESSAGE, {
			updates: structuredClone(updates),
			stalePaths: [...state.staleLoadedMemoryPaths].sort(),
		});
	for (const update of updates) update.displayed = true;
	state.lastDisplayedStalePaths = JSON.stringify([...state.staleLoadedMemoryPaths].sort());
}

interface MemoryUpdateMessage {
	content: string;
	paths: string[];
	updates: PendingMemoryUpdate[];
	stalePaths: string[];
	display: boolean;
}

function drainMemoryUpdates(state: RuntimeState, consume = true): MemoryUpdateMessage {
	if (state.pendingMemoryUpdates.length === 0 && state.staleLoadedMemoryPaths.size === 0) {
		if (consume) state.lastDisplayedStalePaths = "";
		return { content: "", paths: [], updates: [], stalePaths: [], display: false };
	}
	const updates = consume ? state.pendingMemoryUpdates.splice(0) : state.pendingMemoryUpdates;
	const paths = [...new Set(updates.flatMap((update) => update.paths))].sort();
	const stale = [...state.staleLoadedMemoryPaths].sort();
	const staleKey = JSON.stringify(stale);
	const display =
		consume &&
		(updates.some((update) => !update.displayed) || (stale.length > 0 && staleKey !== state.lastDisplayedStalePaths));
	if (consume) state.lastDisplayedStalePaths = staleKey;
	const labels: Record<PendingMemoryUpdate["source"], string> = {
		extract: "Background memory extraction",
		dream: "Background memory consolidation",
		external: "External memory change detection",
	};
	const lines = updates.map((update) => `${labels[update.source]} updated your memory directory: ${update.summary}`);
	if (paths.length > 0) lines.push(`Files changed: ${paths.join(", ")}`);
	if (stale.length > 0)
		lines.push(
			`Your loaded copy of ${stale.join(", ")} is now stale relative to disk — Read it again if you need current contents.`,
		);
	lines.push("This is machine-generated bookkeeping. Do not quote it to the user.");
	return {
		content: `<system-reminder source="project-memory-update">\n${lines.join("\n")}\n</system-reminder>`,
		paths,
		updates: structuredClone(updates),
		stalePaths: stale,
		display,
	};
}

function updateMessage(update: MemoryUpdateMessage) {
	if (!update.content) return undefined;
	return {
		message: {
			customType: UPDATE_MESSAGE,
			content: update.content,
			display: update.display,
			details: { updatedPaths: update.paths, updates: update.updates, stalePaths: update.stalePaths },
		},
	};
}

function replaceToolResultText(event: ToolResultEvent, text: string) {
	return {
		content: [{ type: "text" as const, text }],
		details: event.details,
		...(event.structuredContent === undefined ? {} : { structuredContent: event.structuredContent }),
	};
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function notifyError(ctx: ExtensionContext, operation: string, error: unknown): void {
	ctx.ui.notify(`${operation} failed: ${errorMessage(error)}`, "warning");
}

function recalledMemoryChargedContent(item: RecallItem): string {
	const content = recalledMemoryBudgetContent(item);
	if (!item.truncated) return content;
	const safePath = sanitizeMemoryText(item.path).replaceAll("\n", "\\n");
	return `${content}\n\n> This memory file was truncated (${item.truncatedByBytes ? "4096 byte limit" : "first 200 lines"}). Use the Read tool to view the complete file at: ${safePath}`;
}

function staleMemoryToolReminder(mtimeMs: number): string {
	const warning = staleMemoryWarning(mtimeMs);
	return warning ? `<system-reminder>\n${warning}\n</system-reminder>` : "";
}

/**
 * Re-probe once at the start of each background run. The tool set and prompt are
 * frozen for that run; a missing shell only turns future runs into no-bash runs.
 */
async function refreshShell(ctx: ExtensionContext, state: RuntimeState): Promise<ShellAvailability> {
	const shell = await probeShell({ shellPath: state.config.shellPath });
	state.shell = shell;
	if (!shell.available && !state.shellNoticeShown && ctx.mode === "tui") {
		state.shellNoticeShown = true;
		ctx.ui.notify(shellStatusLine(shell), "warning");
	}
	return shell;
}

function updateMaintenanceStatus(ctx: ExtensionContext, state: RuntimeState): void {
	if (ctx.mode !== "tui") return;
	if (state.panelOpen) {
		state.maintenanceStatus?.setMessage(undefined);
		return;
	}
	const tasks =
		state.config.enabled && !state.shuttingDown && ctx.isProjectTrusted()
			? [
					state.activeExtraction && !state.extractionAbortController?.signal.aborted ? "Extracting" : "",
					state.activeDream && !state.dreamAbortController?.signal.aborted ? "Dreaming" : "",
				].filter(Boolean)
			: [];
	if (tasks.length) state.maintenanceStatus ??= new MemoryStatus(ctx.ui);
	state.maintenanceStatus?.setMessage(tasks.length ? `Memory: ${tasks.join(" · ")}` : undefined);
}

function memoryModelViews(state: RuntimeState, ctx: ExtensionContext): MemoryModelView[] {
	return (["selector", "extractor", "dream"] as const).map((role) => {
		const configured = state.config.models[role];
		const active =
			role === "selector"
				? state.prefetch && !state.prefetch.result && !state.prefetch.controller.signal.aborted
				: role === "extractor"
					? state.activeExtraction
					: state.activeDream;
		const activity = !state.config.enabled
			? "Disabled with auto-memory"
			: active
				? "Running"
				: role === "extractor" && !state.config.extraction.enabled
					? "Idle / manual only"
					: role === "dream" && !state.config.dream.enabled
						? "Disabled"
						: "Idle / automatic";
		const view: MemoryModelView = {
			role,
			model: configured.model === "inherit" && ctx.model ? modelReference(ctx.model) : configured.model,
			inherited: configured.model === "inherit",
			thinking: "Not resolved",
			maxTokens: configured.maxTokens,
			outputMode:
				role === "selector"
					? state.config.models.selector.structuredOutput
						? "Auto (native JSON Schema / schema tool)"
						: "Schema tool"
					: undefined,
			activity,
			lastError: role === "extractor" ? state.lastExtractionError : role === "dream" ? state.lastDreamError : undefined,
			totalTokens: state.backgroundUsage[role].totalTokens,
			cost: state.backgroundUsage[role].cost.total,
		};
		try {
			const model = resolveRoleModel(role, configured, ctx);
			view.model = modelReference(model);
			const thinking = effectiveThinkingLevel(model, configured.thinkingLevel, ctx.thinkingLevel);
			view.thinking =
				configured.thinkingLevel === "inherit"
					? `${thinking} (from session)`
					: thinking !== configured.thinkingLevel
						? `${thinking} (requested ${configured.thinkingLevel})`
						: thinking;
		} catch (error) {
			view.availabilityError = errorMessage(error);
		}
		return view;
	});
}

function memoryStatusLines(state: RuntimeState, ctx: ExtensionContext, topicCount: number): string[] {
	const modelStatus = (role: MemoryRole) => {
		const configured = state.config.models[role];
		try {
			const model = resolveRoleModel(role, configured, ctx);
			const thinking = effectiveThinkingLevel(model, configured.thinkingLevel, ctx.thinkingLevel);
			return `${formatModel(configured.model, ctx)} [available: ${modelReference(model)}; thinking ${configured.thinkingLevel} → ${thinking}; maxTokens ${configured.maxTokens}]`;
		} catch (error) {
			return `${formatModel(configured.model, ctx)} [unavailable: ${errorMessage(error)}]`;
		}
	};
	return [
		`Project: ${state.paths?.projectRoot ?? ctx.cwd}`,
		`Memory: ${state.paths ? displayPath(state.paths.memoryDir) : "not initialized"}`,
		...(state.shell ? [shellStatusLine(state.shell)] : []),
		`Topics: ${topicCount}`,
		`Selector: ${modelStatus("selector")} (${state.config.models.selector.structuredOutput ? "native JSON Schema when supported, otherwise same-model schema tool" : "JSON Schema tool"}, ${state.config.models.selector.maxTokens} output tokens)`,
		`Extractor: ${modelStatus("extractor")}`,
		`Dream: ${modelStatus("dream")}`,
		`Extraction: ${state.config.extraction.enabled ? "enabled" : "disabled"}`,
		`Auto-memory: ${state.config.enabled ? "enabled" : "disabled"}`,
		`Auto-dream: ${state.config.dream.enabled ? "enabled" : "disabled"}`,
		`Recall: ${state.recallBytes}/${RECALL_BUDGET} characters`,
		`Background usage: selector ${formatUsage(state.backgroundUsage.selector)}; extractor ${formatUsage(state.backgroundUsage.extractor)}; dream ${formatUsage(state.backgroundUsage.dream)}`,
		`Extraction pass: ${state.activeExtraction ? "running" : "idle"}${state.lastExtractionError ? `; last error: ${state.lastExtractionError}` : ""}`,
		`Dream pass: ${state.activeDream ? "running" : "idle"}${state.lastDreamError ? `; last error: ${state.lastDreamError}` : ""}`,
	];
}

function formatUsage(usage: Usage): string {
	return `${usage.totalTokens} tokens, $${usage.cost.total.toFixed(6)}`;
}

function formatModel(model: string, ctx: ExtensionContext): string {
	if (model !== "inherit") return model;
	if (!ctx.model) return "inherit (no active model)";
	return `inherit (${modelReference(ctx.model)})`;
}

async function waitWithTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
	let timer: NodeJS.Timeout | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<null>((resolve) => {
				timer = setTimeout(() => resolve(null), ms);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}
