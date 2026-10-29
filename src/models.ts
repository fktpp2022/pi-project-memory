import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { type AgentMessage, runToolCall, type ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
	type Api,
	type AssistantMessage,
	clampThinkingLevel,
	getCurrentTools,
	type Message,
	type Model,
	type Tool,
	type ToolCall,
	type Usage,
} from "@earendil-works/pi-ai";
import { convertToLlm, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { backgroundToolPrompt, type ChildCodemodeOptions, createChildCodemode } from "./child-codemode.ts";
import { createChildTools } from "./child-tools.ts";
import { SELECTOR_SYSTEM_PROMPT, selectorCatalogMessage } from "./prompts.ts";
import { probeShell, type ShellAvailability } from "./shell.ts";
import type {
	ChildRunResult,
	MemoryRole,
	MemoryTopic,
	ProjectMemoryConfig,
	ProjectPaths,
	RoleModelConfig,
} from "./types.ts";

export function modelReference(model: Pick<Model<Api>, "provider" | "id">): string {
	return `${model.provider}/${model.id}`;
}

export function resolveRoleModel(role: MemoryRole, roleConfig: RoleModelConfig, ctx: ExtensionContext): Model<Api> {
	if (roleConfig.model === "inherit") {
		if (!ctx.model) throw new Error(`No active model is available for the ${role} role`);
		return ctx.model;
	}
	const slash = roleConfig.model.indexOf("/");
	const provider = roleConfig.model.slice(0, slash);
	const modelId = roleConfig.model.slice(slash + 1);
	const model = ctx.modelRegistry.find(provider, modelId);
	if (!model) throw new Error(`Configured ${role} model was not found: ${roleConfig.model}`);
	if (!ctx.modelRegistry.hasConfiguredAuth(model))
		throw new Error(`Configured ${role} model has no available credentials: ${roleConfig.model}`);
	return model;
}

function responseText(message: AssistantMessage): string {
	return message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
}

// Exact output schema used by Claude Code 2.1.296's memory selector.
export const SELECTOR_OUTPUT_SCHEMA = {
	type: "object",
	properties: {
		selected_memories: { type: "array", items: { type: "string" } },
	},
	required: ["selected_memories"],
	additionalProperties: false,
} as const;

const SELECTOR_TOOL_NAME = "select_memories";
const NATIVE_STRUCTURED_OUTPUT_APIS = new Set<Api>([
	"anthropic-messages",
	"openai-completions",
	"openai-responses",
	"openai-codex-responses",
	"azure-openai-responses",
	"google-generative-ai",
	"google-vertex",
	"mistral-conversations",
	"bedrock-converse-stream",
]);

export function supportsSelectorOutputSchema(model: Model<Api>): boolean {
	return NATIVE_STRUCTURED_OUTPUT_APIS.has(model.api);
}

export interface SelectorHistoryEntry {
	query: string;
	answer: string;
	response: AssistantMessage;
}

function object(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

export function applySelectorOutputSchema(payload: unknown, model: Model<Api>): unknown {
	const source = object(payload);
	if (!source) return payload;
	if (model.api === "anthropic-messages") {
		const existingBetas = Array.isArray(source.betas)
			? source.betas.filter((value): value is string => typeof value === "string")
			: [];
		return {
			...source,
			betas: [...new Set([...existingBetas, "structured-outputs-2025-12-15"])],
			output_config: {
				...object(source.output_config),
				format: { type: "json_schema", schema: SELECTOR_OUTPUT_SCHEMA },
			},
		};
	}
	if (
		model.api === "openai-responses" ||
		model.api === "openai-codex-responses" ||
		model.api === "azure-openai-responses"
	) {
		return {
			...source,
			text: {
				...object(source.text),
				format: { type: "json_schema", name: "memory_selector", strict: true, schema: SELECTOR_OUTPUT_SCHEMA },
			},
		};
	}
	if (model.api === "openai-completions") {
		return {
			...source,
			response_format: {
				type: "json_schema",
				json_schema: { name: "memory_selector", strict: true, schema: SELECTOR_OUTPUT_SCHEMA },
			},
		};
	}
	if (model.api === "google-generative-ai" || model.api === "google-vertex") {
		return {
			...source,
			config: {
				...object(source.config),
				responseMimeType: "application/json",
				responseJsonSchema: SELECTOR_OUTPUT_SCHEMA,
			},
		};
	}
	if (model.api === "mistral-conversations") {
		return {
			...source,
			responseFormat: {
				type: "json_schema",
				jsonSchema: { name: "memory_selector", strict: true, schemaDefinition: SELECTOR_OUTPUT_SCHEMA },
			},
		};
	}
	if (model.api === "bedrock-converse-stream") {
		return {
			...source,
			outputConfig: {
				...object(source.outputConfig),
				textFormat: {
					type: "json_schema",
					structure: { jsonSchema: { name: "memory_selector", schema: JSON.stringify(SELECTOR_OUTPUT_SCHEMA) } },
				},
			},
		};
	}
	// pi-messages and unknown custom APIs have no verified native structured
	// output contract. Callers route them directly to the schema tool instead.
	return payload;
}

function selectorTool(): Tool<typeof SELECTOR_OUTPUT_SCHEMA> {
	return {
		name: SELECTOR_TOOL_NAME,
		description: "Return the selected memory filenames.",
		parameters: SELECTOR_OUTPUT_SCHEMA,
		constrainedSampling: { type: "json_schema", strict: "prefer" },
	};
}

function responseSelectorJson(message: AssistantMessage): string {
	const call = message.content.find((block) => block.type === "toolCall" && block.name === SELECTOR_TOOL_NAME);
	return call?.type === "toolCall" ? JSON.stringify(call.arguments) : responseText(message);
}

export function effectiveThinkingLevel(
	model: Model<Api>,
	configured: RoleModelConfig["thinkingLevel"],
	inherited: ThinkingLevel = "off",
): ThinkingLevel {
	return clampThinkingLevel(model, configured === "inherit" ? inherited : configured);
}

function reasoning(level: ThinkingLevel): Exclude<ThinkingLevel, "off"> | undefined {
	return level === "off" ? undefined : level;
}

function errorStatus(value: unknown): number | undefined {
	const record = object(value);
	if (!record) return undefined;
	const status = record.status ?? record.statusCode;
	if (typeof status === "number") return status;
	if (Array.isArray(record.diagnostics)) {
		for (const diagnostic of record.diagnostics) {
			const details = object(object(diagnostic)?.details);
			const diagnosticStatus = details?.status ?? details?.statusCode;
			if (typeof diagnosticStatus === "number") return diagnosticStatus;
		}
	}
	return record.cause === value ? undefined : errorStatus(record.cause);
}

const NETWORK_ERROR_CODES = new Set([
	"ABORT_ERR",
	"EAI_AGAIN",
	"ECONNABORTED",
	"ECONNREFUSED",
	"ECONNRESET",
	"EHOSTUNREACH",
	"ENETDOWN",
	"ENETRESET",
	"ENETUNREACH",
	"ENOTFOUND",
	"EPIPE",
	"ESOCKETTIMEDOUT",
	"ETIMEDOUT",
	"ERR_CANCELED",
	"ERR_NETWORK",
	"UND_ERR_CONNECT_TIMEOUT",
	"UND_ERR_HEADERS_TIMEOUT",
	"UND_ERR_SOCKET",
]);
const NON_FORMAT_STOP_REASONS = new Set([
	"blocklist",
	"cancelled",
	"content_filter",
	"content_filtered",
	"guardrail_intervened",
	"image_prohibited_content",
	"image_safety",
	"incomplete.content_filter",
	"prohibited_content",
	"recitation",
	"refusal",
	"safety",
	"sensitive",
	"spii",
]);

function errorCode(value: unknown): string | undefined {
	const record = object(value);
	if (!record) return undefined;
	if (typeof record.code === "string") return record.code.toUpperCase();
	return errorCode(record.cause);
}

function errorMessages(value: unknown, seen = new Set<unknown>()): string[] {
	if (seen.has(value)) return [];
	seen.add(value);
	const record = object(value);
	if (!record) return value instanceof Error ? [value.message] : [];
	const messages = typeof record.message === "string" ? [record.message] : [];
	for (const diagnostic of Array.isArray(record.diagnostics) ? record.diagnostics : [])
		messages.push(...errorMessages(diagnostic, seen));
	messages.push(...errorMessages(record.cause, seen));
	return messages;
}

const STRUCTURED_OUTPUT_ERROR = /structured[ _-]?output|json[ _-]?schema|response[ _-]?format|output[ _-]?config/i;
const NON_FALLBACK_HTTP_STATUS = new Set([401, 403, 408, 409, 423, 425, 429]);
const NON_FORMAT_ERROR_MESSAGE =
	/\b(?:unauthorized|authentication[ _-](?:error|failed)|authorization[ _-](?:error|failed)|invalid[ _-]api[ _-]?key|invalid[ _-]credentials|permission[ _-](?:denied|error)|forbidden|rate[ _-]?limit|too many requests|timed? out|timeout|network[ _-]error|fetch failed|connection (?:refused|reset)|server[ _-]error|service unavailable)\b/i;

function reportedErrorStatus(value: unknown, message: string): number | undefined {
	return (
		errorStatus(value) ??
		(Number(/(?:\b(?:http|status(?: code)?)\s*[:=]?\s*|^\s*)([45]\d\d)\b/i.exec(message)?.[1]) || undefined)
	);
}

function statusAllowsSelectorToolFallback(status: number | undefined): boolean {
	if (status === undefined) return true;
	if (NON_FALLBACK_HTTP_STATUS.has(status) || status >= 500) return false;
	return status === 400 || status === 404 || status === 405 || status === 406 || status === 415 || status === 422;
}

function messageAllowsSelectorToolFallback(value: unknown, message: string): boolean {
	const normalized = message.toLowerCase();
	if (
		[...NON_FORMAT_STOP_REASONS].some((reason) => normalized.includes(reason)) ||
		NON_FORMAT_ERROR_MESSAGE.test(normalized)
	)
		return false;
	const status = reportedErrorStatus(value, normalized);
	if (NON_FALLBACK_HTTP_STATUS.has(status ?? 0) || (status !== undefined && status >= 500)) return false;
	return statusAllowsSelectorToolFallback(status) || STRUCTURED_OUTPUT_ERROR.test(normalized);
}

export function selectorShouldFallbackToTool(value: unknown): boolean {
	const record = object(value);
	if (record?.name === "AbortError" || NETWORK_ERROR_CODES.has(errorCode(value) ?? "")) return false;
	return messageAllowsSelectorToolFallback(value, errorMessages(value).join("\n"));
}

function responseShouldFallbackToTool(response: AssistantMessage): boolean {
	if (response.stopReason !== "error") return false;
	const reason = response.rawStopReason?.toLowerCase();
	if (reason && NON_FORMAT_STOP_REASONS.has(reason)) return false;
	return messageAllowsSelectorToolFallback(response, `${response.errorMessage ?? ""}\n${reason ?? ""}`);
}

async function requestSelector(options: {
	model: Model<Api>;
	messages: Message[];
	thinkingLevel: ThinkingLevel;
	roleConfig: ProjectMemoryConfig["models"]["selector"];
	ctx: ExtensionContext;
	mode: "output-format" | "tool";
	signal?: AbortSignal;
}): Promise<AssistantMessage> {
	const { model, messages, thinkingLevel, roleConfig, ctx, mode, signal } = options;
	const toolMode = mode === "tool";
	const context = {
		systemPrompt: toolMode
			? `${SELECTOR_SYSTEM_PROMPT}\nCall the ${SELECTOR_TOOL_NAME} tool exactly once with the JSON object you would otherwise return.`
			: SELECTOR_SYSTEM_PROMPT,
		messages,
		...(toolMode ? { tools: [selectorTool()] } : {}),
	};
	const reasoningLevel = reasoning(thinkingLevel);
	const stream = ctx.modelRegistry.streamSimple(model, context, {
		...(roleConfig.maxTokens === "inherit" ? {} : { maxTokens: roleConfig.maxTokens }),
		cacheRetention: "short",
		sessionId: `${ctx.sessionManager.getSessionId()}/selector`,
		...(reasoningLevel ? { reasoning: reasoningLevel } : {}),
		...((signal ?? ctx.signal) ? { signal: signal ?? ctx.signal } : {}),
		...(mode === "output-format" ? { onPayload: applySelectorOutputSchema } : {}),
	});
	return stream.result();
}

export async function selectRelevantMemories(
	query: string,
	topics: MemoryTopic[],
	alreadyRecalled: ReadonlyMap<string, number> | ReadonlySet<string>,
	config: ProjectMemoryConfig,
	ctx: ExtensionContext,
	history: SelectorHistoryEntry[] = [],
	signal?: AbortSignal,
	onUsage?: (usage: Usage) => void,
): Promise<string[]> {
	const candidates = topics.filter((topic) => {
		if (alreadyRecalled instanceof Map) {
			if (!alreadyRecalled.has(topic.filename)) return true;
			const recalledMtime = alreadyRecalled.get(topic.filename);
			return Number.isFinite(recalledMtime) && recalledMtime !== topic.mtimeMs;
		}
		return !alreadyRecalled.has(topic.filename);
	});
	if (candidates.length === 0) return [];
	const roleConfig = config.models.selector;
	const model = resolveRoleModel("selector", roleConfig, ctx);
	const thinkingLevel = effectiveThinkingLevel(model, roleConfig.thinkingLevel, ctx.thinkingLevel);
	const selectorQuery = `Select memories relevant to:\n${query}`;
	const messages: Message[] = [
		{
			role: "user",
			content: [{ type: "text", text: `Available memories:\n${selectorCatalogMessage(topics)}` }],
			timestamp: Date.now(),
		},
		...history.flatMap((entry): Message[] => [
			{ role: "user", content: [{ type: "text", text: entry.query }], timestamp: entry.response.timestamp },
			{
				...entry.response,
				content: [{ type: "text", text: entry.answer }],
				stopReason: "stop",
				errorMessage: undefined,
				rawStopReason: undefined,
			},
		]),
		{
			role: "user",
			content: [{ type: "text", text: selectorQuery }],
			timestamp: Date.now(),
		},
	];
	const useNativeOutputFormat = roleConfig.structuredOutput && supportsSelectorOutputSchema(model);
	const modes: ("output-format" | "tool")[] = useNativeOutputFormat ? ["output-format", "tool"] : ["tool"];
	try {
		for (const mode of modes) {
			let response: AssistantMessage;
			try {
				response = await requestSelector({ model, messages, thinkingLevel, roleConfig, ctx, mode, signal });
			} catch (error) {
				// Native structured output may be unsupported; retry only through the
				// declared same-model tool path. Terminal failures reach the recall boundary.
				if (mode === "tool" || !selectorShouldFallbackToTool(error)) throw error;
				continue;
			}
			onUsage?.(response.usage);
			if (response.stopReason === "aborted" || response.stopReason === "length")
				throw new Error(`Memory selector stopped with ${response.stopReason}`, { cause: response });
			if (response.stopReason === "error") {
				if (mode === "output-format" && responseShouldFallbackToTool(response)) continue;
				throw new Error(response.errorMessage ?? response.rawStopReason ?? "Memory selector request failed", {
					cause: response,
				});
			}
			const answer = responseSelectorJson(response);
			const parsed = parseSelectorResponse(answer, candidates);
			history.push({ query: selectorQuery, answer, response });
			return parsed;
		}
		throw new Error("Memory selector exhausted its output modes");
	} catch (error) {
		// Recall is optional: Claude logs terminal provider, truncation and parse
		// failures and returns no selection. Cancellation is silent.
		if (!(signal ?? ctx.signal)?.aborted)
			ctx.ui.notify(`memory selector: ${error instanceof Error ? error.message : String(error)}`, "warning");
		return [];
	}
}

export function parseSelectorResponse(text: string, candidates: MemoryTopic[]): string[] {
	const parsed: unknown = JSON.parse(text.trim());
	if (!parsed || typeof parsed !== "object") throw new TypeError("Memory selector output must be an object");
	const keys = Object.keys(parsed as Record<string, unknown>);
	if (keys.length !== 1 || keys[0] !== "selected_memories")
		throw new TypeError("Memory selector output must contain only selected_memories");
	const selected = (parsed as Record<string, unknown>).selected_memories;
	if (!Array.isArray(selected) || selected.some((value) => typeof value !== "string"))
		throw new TypeError("Memory selector selected_memories must be a string array");
	const valid = new Set(candidates.map((topic) => topic.filename));
	const typePrefix = /^\[(?:user|feedback|project|reference|account)\]\s+/;
	return [
		...new Set(
			selected.flatMap((value) => {
				const normalized = valid.has(value) ? value : value.replace(typePrefix, "");
				return valid.has(normalized) ? [normalized] : [];
			}),
		),
	].slice(0, 5);
}

function replayContent(message: AssistantMessage, model?: Model<Api>): AssistantMessage["content"] {
	const sameModel =
		model === undefined ||
		(message.provider === model.provider && message.api === model.api && message.model === model.id);
	if (sameModel) return message.content;
	return message.content.flatMap((block): AssistantMessage["content"] => {
		// Thinking and its opaque replay signature are valid only for the concrete
		// model that produced them. Keep ordinary visible content, but remove the
		// other provider-specific replay signatures as well.
		if (block.type === "thinking") return [];
		if (block.type === "text" && block.textSignature) return [{ type: "text", text: block.text }];
		if (block.type === "toolCall" && block.thoughtSignature) {
			const { thoughtSignature: _, ...toolCall } = block;
			return [toolCall];
		}
		return [block];
	});
}

export function sanitizeRecentMessages(messages: AgentMessage[], limit: number, model?: Model<Api>): Message[] {
	const compatible = messages.flatMap((message): Message[] => {
		if (message.role === "compactionSummary" || message.role === "branchSummary") return convertToLlm([message]);
		if (message.role === "user" || message.role === "toolResult") return [message];
		if (message.role !== "assistant") return [];
		const content = replayContent(message, model);
		return content === message.content ? [message] : [{ ...message, content }];
	});
	if (!Number.isFinite(limit)) return compatible;
	let conversational = 0;
	let start = compatible.length;
	for (let index = compatible.length - 1; index >= 0; index--) {
		const message = compatible[index];
		if (!message) continue;
		if (message.role === "user" || message.role === "assistant") conversational++;
		start = index;
		if (conversational >= limit) break;
	}
	return compatible.slice(start);
}

export function emptyUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

export function addUsage(total: Usage, usage: Partial<Usage>): void {
	for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const)
		total[key] += usage[key] ?? 0;
	if (usage.reasoning !== undefined) total.reasoning = (total.reasoning ?? 0) + usage.reasoning;
	if (usage.cacheWrite1h !== undefined) total.cacheWrite1h = (total.cacheWrite1h ?? 0) + usage.cacheWrite1h;
	for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const)
		total.cost[key] += usage.cost?.[key] ?? 0;
}

export interface ParentMemoryContext {
	model: Model<Api>;
	messages: Message[];
	sessionId: string;
}

export async function runChildAgent(options: {
	role: "extractor" | "dream";
	prompt: string;
	sourceMessages: Message[];
	systemPrompt: string;
	parentContext?: ParentMemoryContext;
	codemode?: ChildCodemodeOptions;
	config: ProjectMemoryConfig;
	paths: ProjectPaths;
	sessionDir?: string;
	isCurrentGeneration: () => boolean;
	onUsage?: (usage: Usage) => void;
	onTouched?: (relativePath: string, hash: string | null) => void | Promise<void>;
	signal?: AbortSignal;
	ctx: ExtensionContext;
	/** A probe taken at the start of this run. Omitted callers are probed here. */
	shell?: ShellAvailability;
}): Promise<ChildRunResult> {
	const {
		role,
		prompt,
		sourceMessages,
		systemPrompt,
		parentContext,
		codemode,
		config,
		paths,
		sessionDir,
		isCurrentGeneration,
		onUsage,
		onTouched,
		signal,
		ctx,
	} = options;
	const roleConfig = config.models[role];
	const shell = options.shell ?? (await probeShell({ shellPath: config.shellPath }));
	const model = resolveRoleModel(role, roleConfig, ctx);
	const thinkingLevel = effectiveThinkingLevel(model, roleConfig.thinkingLevel, ctx.thinkingLevel);
	const reasoningLevel = reasoning(thinkingLevel);
	const touchedPaths = new Set<string>();
	const scratchDir = await mkdtemp(join(tmpdir(), "pi-project-memory-"));
	try {
		const memoryTools = createChildTools({
			mode: role,
			memoryDir: paths.memoryDir,
			locksDir: paths.locksDir,
			projectRoot: paths.projectRoot,
			cwd: ctx.cwd,
			sessionDir,
			scratchDir,
			isCurrentGeneration,
			isProjectTrusted: () => ctx.isProjectTrusted(),
			touchedPaths,
			onTouched,
			shell,
		});
		const maxTurns = role === "extractor" ? config.extraction.maxTurns : config.dream.maxTurns;
		let turns = 0;
		const childSessionId = randomUUID();
		const usage = emptyUsage();
		const messages: Message[] = [];
		let last: AssistantMessage | undefined;
		const beforeToolCall = async () => {
			if (!ctx.isProjectTrusted()) return { block: true, reason: "Project trust was revoked" };
			if (!isCurrentGeneration()) return { block: true, reason: "This memory pass is stale" };
			return undefined;
		};
		let nestedCall = 0;
		const tools = codemode
			? createChildCodemode(
					memoryTools,
					codemode,
					ctx,
					(name, args, options) => {
						if (!last) throw new Error("No background assistant tool call is active");
						return runToolCall(
							{
								type: "toolCall",
								id: `${childSessionId}/${++nestedCall}`,
								name,
								arguments: args as ToolCall["arguments"],
							},
							{
								tools: memoryTools,
								assistantMessage: last,
								context: { messages, tools: memoryTools },
								signal: options?.signal ?? signal,
								beforeToolCall,
								onUpdate: options?.onUpdate,
							},
						);
					},
					scratchDir,
				)
			: memoryTools;
		const fork =
			parentContext &&
			parentContext.model.provider === model.provider &&
			parentContext.model.api === model.api &&
			parentContext.model.id === model.id &&
			parentContext.messages[0]?.role === "system" &&
			getCurrentTools(parentContext.messages).every((declaration) => {
				const executable = tools.find((tool) => tool.name === declaration.name);
				return (
					!executable ||
					isDeepStrictEqual(
						JSON.parse(JSON.stringify(executable.parameters)),
						JSON.parse(JSON.stringify(declaration.parameters)),
					)
				);
			});
		const toolPrompt = backgroundToolPrompt(tools, codemode, shell.available);
		messages.push(
			...(fork
				? structuredClone(parentContext.messages)
				: sanitizeRecentMessages(sourceMessages, Number.POSITIVE_INFINITY, model)),
			{
				role: "user",
				content: [...(fork ? [{ type: "text" as const, text: toolPrompt }] : []), { type: "text", text: prompt }],
				timestamp: Date.now(),
			},
		);
		const effectiveSystemPrompt = `${systemPrompt}\n\n${toolPrompt}`;
		while (turns < maxTurns) {
			if (signal?.aborted) break;
			const stream = ctx.modelRegistry.streamSimple(
				model,
				fork ? { messages: [...messages] } : { systemPrompt: effectiveSystemPrompt, messages: [...messages], tools },
				{
					...(roleConfig.maxTokens === "inherit" ? {} : { maxTokens: roleConfig.maxTokens }),
					cacheRetention: "short",
					sessionId: fork ? parentContext.sessionId : childSessionId,
					...(reasoningLevel ? { reasoning: reasoningLevel } : {}),
					...(signal ? { signal } : {}),
				},
			);
			try {
				last = await stream.result();
			} catch (error) {
				if (!signal?.aborted) throw error;
				break;
			}
			messages.push(last);
			addUsage(usage, last.usage);
			onUsage?.(last.usage);
			turns++;
			if (["error", "aborted", "length"].includes(last.stopReason)) break;
			const calls = last.content.filter((block) => block.type === "toolCall");
			if (calls.length === 0) break;
			const context = { messages, tools };
			const outcomes = await Promise.all(
				calls.map((toolCall) =>
					runToolCall(toolCall, {
						tools,
						assistantMessage: last as AssistantMessage,
						context,
						signal,
						beforeToolCall,
					}),
				),
			);
			for (const outcome of outcomes)
				messages.push({
					role: "toolResult",
					toolCallId: outcome.toolCall.id,
					toolName: outcome.toolCall.name,
					content: outcome.result.content,
					details: outcome.result.details,
					...(outcome.result.usage ? { usage: outcome.result.usage } : {}),
					isError: outcome.isError,
					timestamp: Date.now(),
					...(outcome.durationMs === undefined ? {} : { durationMs: outcome.durationMs }),
				});
		}
		return {
			role,
			model: modelReference(model),
			turns,
			text: last ? responseText(last) : "",
			touchedPaths: [...touchedPaths].sort(),
			usage,
			stopReason: signal?.aborted ? "aborted" : last?.stopReason,
			error: last?.errorMessage,
		};
	} finally {
		await rm(scratchDir, { recursive: true, force: true });
	}
}
