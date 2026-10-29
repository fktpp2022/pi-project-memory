import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";

export type MemoryRole = "selector" | "extractor" | "dream";

export interface RoleModelConfig {
	model: "inherit" | `${string}/${string}`;
	thinkingLevel: ThinkingLevel | "inherit";
	maxTokens: "inherit" | number;
}

export interface SelectorModelConfig extends RoleModelConfig {
	structuredOutput: boolean;
}

export interface ProjectMemoryConfig {
	enabled: boolean;
	/** User-global override for one project's memory directory; project files cannot set it. */
	autoMemoryDirectory: string | null;
	/** Explicit Git Bash path. Invalid values disable background bash instead of falling through. */
	shellPath: string | null;
	models: {
		selector: SelectorModelConfig;
		extractor: RoleModelConfig;
		dream: RoleModelConfig;
	};
	extraction: {
		enabled: boolean;
		everyNTurns: number;
		idleFlushSeconds: number;
		maxTurns: number;
		recentMessages: "inherit" | number;
	};
	dream: {
		enabled: boolean;
		minimumHours: number;
		minimumOtherSessions: number;
		scanThrottleSeconds: number;
		maxTurns: number;
	};
}

export interface ProjectMemoryState {
	schemaVersion: 1;
	/** Claude measures the next dream window from lock acquisition, including aborted runs. */
	lastDreamAt: number;
}

export interface ProjectPaths {
	projectRoot: string;
	projectKey: string;
	/** Namespace reservation root. Optional for compatibility with callers that construct paths directly. */
	namespaceDir?: string;
	baseDir: string;
	memoryDir: string;
	stateFile: string;
	/** Shared cadence gate for projects which deliberately mount one memory root. */
	dreamStateFile?: string;
	locksDir: string;
}

export type MemoryType = "user" | "feedback" | "project" | "reference" | "unknown";

export interface MemoryTopic {
	filename: string;
	filePath: string;
	description: string;
	type: MemoryType;
	mtimeMs: number;
	modifiedMs: number;
	sizeBytes: number;
}

export interface RecallItem {
	path: string;
	filename: string;
	mtimeMs: number;
	content: string;
	truncated: boolean;
	truncatedByBytes: boolean;
	lineCount: number;
}

export interface ChildRunResult {
	role: "extractor" | "dream";
	model: string;
	turns: number;
	text: string;
	touchedPaths: string[];
	usage: Usage;
	stopReason?: string;
	error?: string;
}

export interface ReadBaseline {
	hash: string;
	mtimeMs: number;
	size: number;
}
