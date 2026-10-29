import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
	createCodemodeExtension,
	type ExtensionAPI,
	type ExtensionContext,
	type ExtensionToolContext,
	SessionManager,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { relocateToolOutput } from "./child-tools.ts";

export interface ChildCodemodeOptions {
	mode: "on" | "only";
	inlineBudget?: number;
}

/** Register Pi's public codemode factory against a private, task-local tool registry. */
export function createChildCodemode(
	tools: AgentTool[],
	options: ChildCodemodeOptions,
	ctx: ExtensionContext,
	executeTool: ExtensionToolContext["executeTool"],
	scratchDir: string,
): AgentTool[] {
	const sessionManager = SessionManager.inMemory(ctx.cwd);
	let definition: ToolDefinition | undefined;
	// The factory only registers its tool and reads metadata through these callbacks.
	// No registration, store entry, or nested call reaches the parent session.
	const registration = {
		registerTool: (tool: ToolDefinition) => {
			definition = tool;
		},
		getAllTools: () => tools,
		getSettings: () => ({ codemode: options }),
		appendEntry: (customType: string, data: unknown) => sessionManager.appendCustomEntry(customType, data),
	} as unknown as ExtensionAPI;
	createCodemodeExtension({ ...options, models: false })(registration);
	if (!definition) throw new Error("Pi did not register its codemode tool");
	const native = definition;
	const codemode: AgentTool = {
		name: native.name,
		label: native.label,
		description: native.description,
		parameters: native.parameters,
		constrainedSampling: native.constrainedSampling,
		prepareArguments: native.prepareArguments,
		execute: async (id, params, signal, onUpdate) => {
			const result = await native.execute(id, params, signal, onUpdate, { ...ctx, sessionManager, tools, executeTool });
			const details = result.details as { fullOutputPath?: string } | undefined;
			const source = details?.fullOutputPath;
			if (source) {
				const target = join(scratchDir, `codemode-${randomUUID()}.txt`);
				await relocateToolOutput(result, source, target);
				details.fullOutputPath = target;
			}
			return result;
		},
	};
	const all = [...tools, codemode];
	const loadout = native.prepareLoadout?.({
		declared: all,
		callable: tools,
		registered: all,
		getExposure: (name) => (name === "codemode" ? "model-only" : "direct"),
		getNamespace: () => undefined,
		getPromptGuidelines: () => [],
	});
	return all
		.filter((tool) => !loadout?.hiddenDeclarations?.includes(tool.name))
		.map((tool) => ({ ...tool, description: loadout?.descriptions?.[tool.name] ?? tool.description }));
}

export function backgroundToolPrompt(
	tools: AgentTool[],
	codemode?: ChildCodemodeOptions,
	hasBash = tools.some((tool) => tool.name === "bash"),
): string {
	return [
		"## Background memory task tools",
		"Earlier tool inventories and tool-routing instructions describe the parent session. For this background task, use only the task tools listed below and follow their access restrictions. Other parent tools may remain declared for prompt-cache reuse, but calls to them will be denied. Continue following inherited user and project instructions.",
		...tools.map((tool) => `- ${tool.name}: ${tool.description}`),
		...(codemode
			? [
					hasBash
						? "Codemode can call only this task's read, find, grep, write, edit, and restricted bash tools. Their access, read-baseline, trust, and generation checks also apply inside scripts. Store values last only for this background task."
						: "Codemode can call only this task's read, find, grep, write, and edit tools. Their access, read-baseline, trust, and generation checks also apply inside scripts. Shell access is unavailable in this run. Store values last only for this background task.",
					"Use codemode to batch independent calls with Promise.allSettled, chain dependent calls, or filter large results. Await every call whose result or effects are needed.",
				]
			: []),
	].join("\n\n");
}
