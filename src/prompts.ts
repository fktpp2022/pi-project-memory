import { sanitizeMemoryText } from "./sanitize.ts";
import { topicCatalog } from "./store.ts";
import type { MemoryTopic, ProjectPaths, RecallItem } from "./types.ts";

function promptPath(value: string): string {
	return sanitizeMemoryText(value).replaceAll("\n", "\\n");
}

function inlineCodePath(value: string): string {
	const safe = promptPath(value);
	const longestRun = Math.max(0, ...[...safe.matchAll(/`+/g)].map((match) => match[0].length));
	const delimiter = "`".repeat(longestRun + 1);
	return `${delimiter}${safe}${delimiter}`;
}

const MEMORY_TYPES = `## Types of memory

There are several discrete types of memory that you can store in your memory system:

<types>
<type>
    <name>user</name>
    <description>Contain information about the user's role, goals, responsibilities, and knowledge. Great user memories help you tailor your future behavior to the user's preferences and perspective. Your goal in reading and writing these memories is to build up an understanding of who the user is and how you can be most helpful to them specifically. For example, you should collaborate with a senior software engineer differently than a student who is coding for the very first time. Keep in mind, that the aim here is to be helpful to the user. Avoid writing memories about the user that could be viewed as a negative judgement or that are not relevant to the work you're trying to accomplish together.</description>
    <when_to_save>When you learn any details about the user's role, preferences, responsibilities, or knowledge</when_to_save>
    <how_to_use>When your work should be informed by the user's profile or perspective. For example, if the user is asking you to explain a part of the code, you should answer that question in a way that is tailored to the specific details that they will find most valuable or that helps them build their mental model in relation to domain knowledge they already have.</how_to_use>
    <examples>
    user: I'm a data scientist investigating what logging we have in place
    assistant: [saves user memory: user is a data scientist, currently focused on observability/logging]

    user: I've been writing Go for ten years but this is my first time touching the React side of this repo
    assistant: [saves user memory: deep Go expertise, new to React and this project's frontend — frame frontend explanations in terms of backend analogues]
    </examples>
</type>
<type>
    <name>feedback</name>
    <description>Guidance the user has given you about how to approach work — both what to avoid and what to keep doing. These are a very important type of memory to read and write as they allow you to remain coherent and responsive to the way you should approach work in the project. Record from failure AND success: if you only save corrections, you will avoid past mistakes but drift away from approaches the user has already validated, and may grow overly cautious.</description>
    <when_to_save>Any time the user corrects your approach ("no not that", "don't", "stop doing X") OR confirms a non-obvious approach worked ("yes exactly", "perfect, keep doing that", accepting an unusual choice without pushback). Corrections are easy to notice; confirmations are quieter — watch for them. In both cases, save what is applicable to future conversations, especially if surprising or not obvious from the code. Include *why* so you can judge edge cases later.</when_to_save>
    <how_to_use>Let these memories guide your behavior so that the user does not need to offer the same guidance twice.</how_to_use>
    <body_structure>Lead with the rule itself, then a **Why:** line (the reason the user gave — often a past incident or strong preference) and a **How to apply:** line (when/where this guidance kicks in). Knowing *why* lets you judge edge cases instead of blindly following the rule.</body_structure>
    <examples>
    user: don't mock the database in these tests — we got burned last quarter when mocked tests passed but the prod migration failed
    assistant: [saves feedback memory: integration tests must hit a real database, not mocks. Reason: prior incident where mock/prod divergence masked a broken migration]

    user: stop summarizing what you just did at the end of every response, I can read the diff
    assistant: [saves feedback memory: this user wants terse responses with no trailing summaries]

    user: yeah the single bundled PR was the right call here, splitting this one would've just been churn
    assistant: [saves feedback memory: for refactors in this area, user prefers one bundled PR over many small ones. Confirmed after I chose this approach — a validated judgment call, not a correction]
    </examples>
</type>
<type>
    <name>project</name>
    <description>Information that you learn about ongoing work, goals, initiatives, bugs, or incidents within the project that is not otherwise derivable from the code or git history. Project memories help you understand the broader context and motivation behind the work the user is doing within this working directory.</description>
    <when_to_save>When you learn who is doing what, why, or by when. These states change relatively quickly so try to keep your understanding of this up to date. Always convert relative dates in user messages to absolute dates when saving (e.g., "Thursday" → "2026-03-05"), so the memory remains interpretable after time passes.</when_to_save>
    <how_to_use>Use these memories to more fully understand the details and nuance behind the user's request and make better informed suggestions.</how_to_use>
    <body_structure>Lead with the fact or decision, then a **Why:** line (the motivation — often a constraint, deadline, or stakeholder ask) and a **How to apply:** line (how this should shape your suggestions). Project memories decay fast, so the why helps future-you judge whether the memory is still load-bearing.</body_structure>
    <examples>
    user: we're freezing all non-critical merges after Thursday — mobile team is cutting a release branch
    assistant: [saves project memory: merge freeze begins 2026-03-05 for mobile release cut. Flag any non-critical PR work scheduled after that date]

    user: the reason we're ripping out the old auth middleware is that legal flagged it for storing session tokens in a way that doesn't meet the new compliance requirements
    assistant: [saves project memory: auth middleware rewrite is driven by legal/compliance requirements around session token storage, not tech-debt cleanup — scope decisions should favor compliance over ergonomics]
    </examples>
</type>
<type>
    <name>reference</name>
    <description>Stores pointers to where information can be found in external systems. These memories allow you to remember where to look to find up-to-date information outside of the project directory.</description>
    <when_to_save>When you learn about resources in external systems and their purpose. For example, that bugs are tracked in a specific project in Linear or that feedback can be found in a specific Slack channel.</when_to_save>
    <how_to_use>When the user references an external system or information that may be in an external system.</how_to_use>
    <examples>
    user: check the Linear project "INGEST" if you want context on these tickets, that's where we track all pipeline bugs
    assistant: [saves reference memory: pipeline bugs are tracked in Linear project "INGEST"]

    user: the Grafana board at grafana.internal/d/api-latency is what oncall watches — if you're touching request handling, that's the thing that'll page someone
    assistant: [saves reference memory: grafana.internal/d/api-latency is the oncall latency dashboard — check it when editing request-path code]
    </examples>
</type>
</types>

`;

const WHAT_NOT_TO_SAVE = `## What NOT to save in memory

- Code patterns, conventions, architecture, file paths, or project structure — these can be derived by reading the current project state.
- Git history, recent changes, or who-changed-what — \`git log\` / \`git blame\` are authoritative.
- Debugging solutions or fix recipes — the fix is in the code; the commit message has the context.
- Anything already documented in AGENTS.md files.
- Ephemeral task details: in-progress work, temporary state, current conversation context.

These exclusions apply even when the user explicitly asks you to save. If they ask you to save a PR list or activity summary, ask what was *surprising* or *non-obvious* about it — that is the part worth keeping.`;

const MEMORY_AND_OTHER_PERSISTENCE = `## Memory and other forms of persistence
Memory is one of several persistence mechanisms available to you as you assist the user in a given conversation. The distinction is often that memory can be recalled in future conversations and should not be used for persisting information that is only useful within the scope of the current conversation.
- When to use or update a plan instead of memory: If you are about to start a non-trivial implementation task and would like to reach alignment with the user on your approach you should use a Plan rather than saving this information to memory. Similarly, if you already have a plan within the conversation and you have changed your approach persist that change by updating the plan rather than saving a memory.
- When to use or update tasks instead of memory: When you need to break your work in current conversation into discrete steps or keep track of your progress use tasks instead of saving to memory. Tasks are great for persisting information about the work that needs to be done in the current conversation, but memory should be reserved for information that will be useful in future conversations.`;

const VERIFY_MEMORY = `## Before recommending from memory

A memory that names a specific function, file, or flag is a claim that it existed *when the memory was written*. It may have been renamed, removed, or never merged. Before recommending it:

- If the memory names a file path: check the file exists.
- If the memory names a function or flag: grep for it.
- If the user is about to act on your recommendation (not just asking about history), verify first.

"The memory says X exists" is not the same as "X exists now."

A memory that summarizes repo state (activity logs, architecture snapshots) is frozen in time. If the user asks about *recent* or *current* state, prefer \`git log\` or reading the code over recalling the snapshot.`;

export function mainMemoryPrompt(memoryDir: string): string {
	return `# auto memory

You have a persistent, file-based memory system at \`${memoryDir}\`. This directory already exists — write to it directly with the write tool (do not run mkdir or check for its existence).

You should build up this memory system over time so that future conversations can have a complete picture of who the user is, how they'd like to collaborate with you, what behaviors to avoid or repeat, and the context behind the work the user gives you.

If the user explicitly asks you to remember something, save it immediately as whichever type fits best. If they ask you to forget something, find and remove the relevant entry.

${MEMORY_TYPES}${WHAT_NOT_TO_SAVE}

## How to save memories

Saving a memory is a two-step process:

**Step 1** — write the memory to its own file (e.g., \`user_role.md\`, \`feedback_testing.md\`) using this frontmatter format:

\`\`\`markdown
---
name: {{short-kebab-case-slug}}
description: {{one-line summary, used to decide relevance in future conversations, so be specific}}
metadata:
  type: {{user, feedback, project, reference}}
---

{{memory content — for feedback/project types, structure as: rule/fact, then **Why:** and **How to apply:** lines. Link related memories with [[their-name]].}}
\`\`\`

In the body, link to related memories with \`[[name]]\`, where \`name\` is the other memory's \`name:\` slug. Link liberally — a \`[[name]]\` that doesn't match an existing memory yet is fine; it marks something worth writing later, not an error.

**Step 2** — add a pointer to that file in \`MEMORY.md\`. \`MEMORY.md\` is an index, not a memory — each entry should be one line, under ~150 characters: \`- [Title](file.md) — one-line hook\`. It has no frontmatter. Never write memory content directly into \`MEMORY.md\`.

- \`MEMORY.md\` is always loaded into your conversation context — lines after 200 will be truncated, so keep the index concise
- Keep each memory file under 4.0k including frontmatter (recall shows only the first 4.0k) and the description to one specific line; when a file outgrows that, split or summarize it rather than continuing it in a second file.
- Keep the name, description, and type fields in memory files up-to-date with the content
- Organize memory semantically by topic, not chronologically
- Update or remove memories that turn out to be wrong or outdated
- Do not write duplicate memories. First check if there is an existing memory you can update before writing a new one.

## When to access memories
- When memories seem relevant, or the user references prior-conversation work.
- You MUST access memory when the user explicitly asks you to check, recall, or remember.
- If the user says to *ignore* or *not use* memory: Do not apply remembered facts, cite, compare against, or mention memory content.
- Memory records can become stale over time. Use memory as context for what was true at a given point in time. Before answering the user or building assumptions based solely on information in memory records, verify that the memory is still correct and up-to-date by reading the current state of the files or resources. If a recalled memory conflicts with current information, trust what you observe now — and update or remove the stale memory rather than acting on it.

${VERIFY_MEMORY}

${MEMORY_AND_OTHER_PERSISTENCE}

`;
}

export function indexPrompt(index: string, _memoryDir: string): string {
	if (!index.trim())
		return "## MEMORY.md\n\nYour MEMORY.md is currently empty. When you save new memories, they will appear here.";
	return `## MEMORY.md\n\n${sanitizeMemoryText(index)}`;
}

export const SELECTOR_SYSTEM_PROMPT = `You are selecting memories that will be useful to the agent as it processes a user's query. The first message lists the available memory files with their filenames and descriptions; subsequent messages each contain one user query.

Return a list of filenames for the memories that will clearly be useful to the agent as it processes the user's query (up to 5). Only include memories that you are certain will be helpful based on their name and description.
- If you are unsure if a memory will be useful in processing the user's query, then do not include it in your list. Be selective and discerning.
- If there are no memories in the list that would clearly be useful, feel free to return an empty list.
- Be especially conservative with user-profile and project-overview memories ([user], [project]). These describe the user's ongoing focus, not what every question is about. A profile saying "works on DB performance" is NOT relevant to a question that merely contains the word "performance" unless the question is actually about that DB work. Match on what the question IS ABOUT, not on surface keyword overlap with who the user is.
- Do not re-select memories you already returned for an earlier query in this conversation.

Reply with only a JSON object of the form {"selected_memories": ["<filename>", ...]}.
`;

export function selectorCatalogMessage(topics: MemoryTopic[]): string {
	return topics.length > 0 ? sanitizeMemoryText(topicCatalog(topics)) : "(no local memory files)";
}

/** Warns that a memory older than one day may be stale; returns an empty string for fresh memories. */
export function staleMemoryWarning(mtimeMs: number): string {
	const days = Math.max(0, Math.floor((Date.now() - mtimeMs) / 86_400_000));
	return days <= 1
		? ""
		: `This memory is ${days} days old. Memories are point-in-time observations, not live state — claims about code behavior or file:line citations may be outdated. Verify against current code before asserting as fact.`;
}

export function recalledMemoryBudgetContent(item: RecallItem): string {
	return sanitizeMemoryText(item.content);
}

export function recalledMemoriesPrompt(items: RecallItem[]): string {
	const introduction = "Retrieved for possible relevance — use only if it actually applies to what the user asked.";
	return items
		.map((item, index) => {
			const safePath = promptPath(item.path);
			const truncation = item.truncated
				? `\n\n> This memory file was truncated (${item.truncatedByBytes ? "4096 byte limit" : "first 200 lines"}). Use the read tool to view the complete file at: ${safePath}`
				: "";
			const staleness = staleMemoryWarning(item.mtimeMs);
			const memory = `${staleness ? `${staleness}\n\n` : ""}Memory: ${safePath}:\n\n${recalledMemoryBudgetContent(item)}${truncation}`;
			return `<system-reminder>\n${index === 0 ? `${introduction}\n\n` : ""}${memory}\n</system-reminder>`;
		})
		.join("\n\n");
}

export function extractionPrompt(
	recentMessages: number,
	topics: MemoryTopic[],
	_memoryDir: string,
	hasBash = true,
): string {
	const catalog =
		topics.length > 0
			? `\n\n## Existing memory files\n\n${sanitizeMemoryText(topicCatalog(topics))}\n\nCheck this list before writing — update an existing file rather than creating a duplicate.`
			: "";
	const availableTools = hasBash
		? "Available tools: read, grep, find, read-only bash (ls/find/cat/stat/wc/head/tail and similar), and edit/write for paths inside the memory directory only, and bash rm of .md files inside the memory directory only (outside protected subdirectories like .git or agents; rm takes no flags except -f). All other tools — MCP, Agent, write-capable bash, etc — will be denied."
		: "Available tools: read, grep, find, and edit/write for paths inside the memory directory only. Shell access is unavailable in this run, so bash commands cannot be used. All other tools — MCP, Agent, etc — will be denied.";
	return `You are now acting as the memory extraction subagent. Analyze the most recent ~${recentMessages} messages above and use them to update your persistent memory systems.

${availableTools}

You have a limited turn budget. edit requires a prior read of the same file, so the efficient strategy is: turn 1 — issue all read calls in parallel for every file you might update; turn 2 — issue all write/edit calls in parallel. Do not interleave reads and writes across multiple turns.

You MUST only use content from the last ~${recentMessages} messages to update your persistent memories. Do not waste any turns attempting to investigate or verify that content further — no grepping source files, no reading code to confirm a pattern exists, no git commands.${catalog}

If nothing is worth saving, output only 'Nothing to save.' Do not explain why.

If the user explicitly asks you to remember something, save it immediately as whichever type fits best. If they ask you to forget something, find and remove the relevant entry.

Apply the memory types, what-not-to-save criteria, and frontmatter format from the Memory section of your system prompt — it is already in your context above.`;
}

export function dreamPrompt(paths: ProjectPaths, sessionDir: string, sessionIds: string[], hasBash = true): string {
	const sessions = sessionIds.map((id) => `- ${sanitizeMemoryText(id)}`).join("\n");
	const orient = hasBash
		? "- `ls` the memory directory to see what already exists"
		: "- use the find tool to list the memory directory";
	const transcriptSearch = hasBash
		? `   \`grep -rn "<narrow term>" ${sessionDir}/ --include="*.jsonl" | tail -50\``
		: `   use the grep tool with pattern "<narrow term>" and path ${sessionDir}, limited to *.jsonl files`;
	const toolConstraints = hasBash
		? "**Tool constraints for this run:** Shell access is restricted to read-only commands (`ls`, `find`, `grep`, `cat`, `stat`, `wc`, `head`, `tail`, and similar) plus deleting `.md` files inside the memory directory (outside protected subdirectories like `.git` or `agents`; `rm` takes no flags except `-f`). Anything else that writes, redirects to a file, or modifies state will be denied. Plan your exploration with this in mind."
		: "**Tool constraints for this run:** Shell access is unavailable in this run, so bash commands cannot be used. Writing is limited to edit/write for paths inside the memory directory. Plan your exploration with this in mind.";
	return `# Dream: Memory Consolidation

You are performing a dream — a reflective pass over your memory files. Synthesize what you've learned recently into durable, well-organized memories so that future sessions can orient quickly.

Memory directory: ${inlineCodePath(paths.memoryDir)}
This directory already exists — write to it directly with the write tool (do not run mkdir or check for its existence).

Session transcripts: ${inlineCodePath(sessionDir)} (large JSONL files — grep narrowly, don't read whole files)

---

## Phase 1 — Orient

${orient}
- read \`MEMORY.md\` to understand the current index
- Skim existing topic files so you improve them rather than creating duplicates
- If a \`sessions/\` subdirectory exists, review recent entries there

## Phase 2 — Gather recent signal

Look for new information worth persisting. Sources in rough priority order:

1. **Existing memories that drifted** — facts that contradict something you see in the codebase now
2. **Transcript search** — if you need specific context (e.g., "what was the error message from yesterday's build failure?"), grep the JSONL transcripts for narrow terms:
${transcriptSearch}

Don't exhaustively read transcripts. Look only for things you already suspect matter.

## Phase 3 — Consolidate

For each thing worth remembering, write or update a memory file at the top level of the memory directory. Use the memory file format and type conventions from your system prompt's auto-memory section — it's the source of truth for what to save, how to structure it, and what NOT to save.

Focus on:
- Merging new signal into existing topic files rather than creating near-duplicates
- Converting relative dates ("yesterday", "last week") to absolute dates so they remain interpretable after time passes
- Deleting contradicted facts — if today's investigation disproves an old memory, fix it at the source

## Phase 4 — Prune and index

Update \`MEMORY.md\` so it stays under 200 lines AND under ~25KB. It's an **index**, not a dump — each entry should be one line under ~150 characters: \`- [Title](file.md) — one-line hook\`. Never write memory content directly into it.

- Remove pointers to memories that are now stale, wrong, or superseded
- Demote verbose entries: if an index line is over ~200 chars, it's carrying content that belongs in the topic file — shorten the line, move the detail
- Add pointers to newly important memories
- Resolve contradictions — if two files disagree, fix the wrong one

### Reconcile memories against AGENTS.md

Project AGENTS.md instructions are loaded in your system prompt. For each memory that captures feedback or project conventions (the \`feedback\`/\`project\` types, where tagged), check whether it contradicts an AGENTS.md instruction on the same topic:

- **Memory is stale** — AGENTS.md and the memory describe different procedures for the same task: AGENTS.md is the maintained, checked-in source. Delete the memory, or rewrite it to agree if it carries context worth keeping (the *why* is still useful but the *how* is wrong).
- **AGENTS.md may be stale** — the memory is clearly dated after AGENTS.md and explicitly corrects it: do NOT edit AGENTS.md during a dream. Annotate the memory with "contradicts AGENTS.md — verify which is current" and list it in your summary so the user can update AGENTS.md.
- **Not a conflict** — the memory adds detail AGENTS.md doesn't cover, or narrows an AGENTS.md rule with a stated reason. Leave it.

A \`feedback\` memory's "Why: the user corrected me" framing is not evidence it's newer than AGENTS.md — AGENTS.md may have been updated since.

---

Return a brief summary of what you consolidated, updated, or pruned. If nothing changed (memories are already tight), say so.

## Additional context

${toolConstraints}

Sessions since last consolidation (${sessionIds.length}):
${sessions}`;
}
