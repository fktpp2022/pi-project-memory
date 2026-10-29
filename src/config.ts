import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ProjectMemoryConfig, RoleModelConfig, SelectorModelConfig } from "./types.ts";

export const DEFAULT_CONFIG: ProjectMemoryConfig = {
	enabled: true,
	autoMemoryDirectory: null,
	shellPath: null,
	models: {
		selector: { model: "inherit", thinkingLevel: "off", maxTokens: 512, structuredOutput: true },
		extractor: { model: "inherit", thinkingLevel: "inherit", maxTokens: "inherit" },
		dream: { model: "inherit", thinkingLevel: "inherit", maxTokens: "inherit" },
	},
	extraction: {
		enabled: true,
		everyNTurns: 1,
		idleFlushSeconds: 120,
		maxTurns: 5,
		recentMessages: "inherit",
	},
	dream: {
		enabled: true,
		minimumHours: 24,
		minimumOtherSessions: 5,
		scanThrottleSeconds: 600,
		maxTurns: 50,
	},
};

export function configPath(): string {
	return join(getAgentDir(), "project-memory", "config.json");
}

const THINKING_LEVELS = new Set(["inherit", "off", "minimal", "low", "medium", "high", "xhigh", "max"]);

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function integer<T extends number | "inherit">(value: unknown, fallback: T, min: number): number | T {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= min ? value : fallback;
}

function inheritedInteger(value: unknown, fallback: "inherit" | number, min: number): "inherit" | number {
	return value === "inherit" ? value : integer(value, fallback, min);
}

function boolean(value: unknown, fallback: boolean): boolean {
	return typeof value === "boolean" ? value : fallback;
}

function optionalString(value: unknown): string | null {
	return typeof value === "string" ? value.trim() || null : null;
}

function roleConfig(value: unknown, fallback: RoleModelConfig): RoleModelConfig {
	const raw = record(value);
	if (!raw) return { ...fallback };
	let model = fallback.model;
	if (raw.model === "inherit") model = "inherit";
	else if (typeof raw.model === "string") {
		const separator = raw.model.indexOf("/");
		if (separator > 0 && separator < raw.model.length - 1) model = raw.model as RoleModelConfig["model"];
	}
	const thinkingLevel =
		typeof raw.thinkingLevel === "string" && THINKING_LEVELS.has(raw.thinkingLevel)
			? (raw.thinkingLevel as RoleModelConfig["thinkingLevel"])
			: fallback.thinkingLevel;
	return {
		model,
		thinkingLevel,
		maxTokens: inheritedInteger(raw.maxTokens, fallback.maxTokens, 64),
	};
}

function selectorConfig(value: unknown, fallback: SelectorModelConfig): SelectorModelConfig {
	return {
		...roleConfig(value, fallback),
		structuredOutput: boolean(record(value)?.structuredOutput, fallback.structuredOutput),
	};
}

export function parseConfig(value: unknown): ProjectMemoryConfig {
	const raw = record(value);
	if (!raw) return structuredClone(DEFAULT_CONFIG);
	const models = record(raw.models) ?? {};
	const extraction = record(raw.extraction) ?? {};
	const dream = record(raw.dream) ?? {};
	return {
		enabled: boolean(raw.enabled, DEFAULT_CONFIG.enabled),
		autoMemoryDirectory: optionalString(raw.autoMemoryDirectory),
		shellPath: optionalString(raw.shellPath),
		models: {
			selector: selectorConfig(models.selector, DEFAULT_CONFIG.models.selector),
			extractor: roleConfig(models.extractor, DEFAULT_CONFIG.models.extractor),
			dream: roleConfig(models.dream, DEFAULT_CONFIG.models.dream),
		},
		extraction: {
			enabled: boolean(extraction.enabled, DEFAULT_CONFIG.extraction.enabled),
			everyNTurns: integer(extraction.everyNTurns, DEFAULT_CONFIG.extraction.everyNTurns, 1),
			idleFlushSeconds: integer(extraction.idleFlushSeconds, DEFAULT_CONFIG.extraction.idleFlushSeconds, 0),
			maxTurns: integer(extraction.maxTurns, DEFAULT_CONFIG.extraction.maxTurns, 1),
			recentMessages: inheritedInteger(extraction.recentMessages, DEFAULT_CONFIG.extraction.recentMessages, 3),
		},
		dream: {
			enabled: boolean(dream.enabled, DEFAULT_CONFIG.dream.enabled),
			minimumHours: integer(dream.minimumHours, DEFAULT_CONFIG.dream.minimumHours, 1),
			minimumOtherSessions: integer(dream.minimumOtherSessions, DEFAULT_CONFIG.dream.minimumOtherSessions, 1),
			scanThrottleSeconds: integer(dream.scanThrottleSeconds, DEFAULT_CONFIG.dream.scanThrottleSeconds, 0),
			maxTurns: integer(dream.maxTurns, DEFAULT_CONFIG.dream.maxTurns, 1),
		},
	};
}

export async function loadConfig(): Promise<ProjectMemoryConfig> {
	try {
		return parseConfig(JSON.parse(await readFile(configPath(), "utf8")));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return structuredClone(DEFAULT_CONFIG);
		throw new Error(`Failed to read ${configPath()}: ${error instanceof Error ? error.message : String(error)}`);
	}
}
