/**
 * Agent Brain Extension
 *
 * The agent's brain, ported from the "her" self-evolving assistant: it
 * remembers across sessions, builds a model of the user, and improves over
 * time via reflection.
 *
 * - Five memory kinds in plain Markdown: projects, workflows, decisions,
 *   notes, lessons, plus a confidence-graded user profile and open loops.
 * - Tools: memory_search / memory_save / memory_update. Writes run in
 *   sequential tool mode and per-file mutation queues.
 * - An <agent-memory> system prompt section carries profile, open loops, and
 *   read/write discipline into every turn; injected data is escaped and capped.
 * - Auto "memory closeout" reflection after substantial successful tasks
 *   (disable with --no-memory-closeout; run manually with /closeout).
 * - Every write lands in the append-only evolution log; the derived index is
 *   rebuilt automatically.
 *
 * See README.md in this directory for the full mechanism mapping.
 */

import { readFile } from "node:fs/promises";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, StopReason } from "@earendil-works/pi-ai";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateHead } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { getGlobalMemoryDir, getProjectMemoryDir, MEMORY_CATEGORIES, PROFILE_FILES } from "./paths.ts";
import { AUTO_CLOSEOUT_MIN_TOOL_CALLS, buildMemorySection, CLOSEOUT_PROMPT, MEMORY_SECTION_TAG } from "./prompt.ts";
import {
	countEvolutionEntries,
	ensureLayout,
	listMemories,
	MEMORY_FIELD_LIMITS,
	type MemoryRoot,
	memoryOverview,
	readRecentEvolution,
	saveMemory,
	searchMemories,
	updateMemory,
} from "./store.ts";

const ALL_TYPES = [...MEMORY_CATEGORIES, "profile", "open-loop"] as const;

interface MemorySearchDetails {
	query: string;
	matchCount: number;
}

interface MemorySaveDetails {
	ref: string;
	type: string;
	created: boolean;
}

interface MemoryUpdateDetails {
	ref: string;
	action: "deprecate" | "replace";
}

/** Final stop reasons that allow an automatic closeout reflection. */
const CLOSEOUT_ALLOWED_STOP_REASONS = new Set<StopReason>(["stop", "toolUse"]);

function lastStopReason(messages: AgentMessage[]): StopReason | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role === "assistant" && "stopReason" in message) {
			return (message as AssistantMessage).stopReason;
		}
	}
	return undefined;
}

const searchParams = Type.Object({
	query: Type.Optional(
		Type.String({
			description: "Keywords to search for. Omit for an overview.",
			maxLength: MEMORY_FIELD_LIMITS.query,
		}),
	),
	type: Type.Optional(StringEnum(ALL_TYPES, { description: "Restrict search to one memory type." })),
});

const SAVE_TITLE = Type.String({
	description: "Short display title. Any language.",
	maxLength: MEMORY_FIELD_LIMITS.title,
});
const SAVE_NAME = Type.Optional(
	Type.String({
		description:
			"kebab-case file base name (a-z, 0-9, '-', '_'). Required when the title contains no ASCII letters. Content language stays free.",
		maxLength: 64,
	}),
);
const SAVE_TAGS = Type.Optional(
	Type.Array(Type.String({ description: "Lowercase tag.", maxLength: MEMORY_FIELD_LIMITS.tag }), {
		maxItems: MEMORY_FIELD_LIMITS.tags,
	}),
);
const SAVE_TRIGGER = Type.Optional(
	Type.String({
		description: "One-line reason recorded in the evolution log.",
		maxLength: MEMORY_FIELD_LIMITS.trigger,
	}),
);

const categorySaveParams = Type.Object({
	type: StringEnum(MEMORY_CATEGORIES, { description: "Memory category." }),
	scope: Type.Optional(
		StringEnum(["global", "project"] as const, {
			description: "Memory root scope. Defaults to global; project requires a trusted project.",
		}),
	),
	title: SAVE_TITLE,
	content: Type.String({
		description: "Markdown body. Never include secrets.",
		maxLength: MEMORY_FIELD_LIMITS.content,
	}),
	name: SAVE_NAME,
	tags: SAVE_TAGS,
	confidence: Type.Optional(
		StringEnum(["confirmed", "observed", "inferred", "deprecated"] as const, {
			description: "Profile entries only. ignored for category types.",
		}),
	),
	profileFile: Type.Optional(
		StringEnum(PROFILE_FILES, { description: "Target profile file. Only used when type is profile." }),
	),
	updateExisting: Type.Optional(Type.Boolean({ description: "Replace the body when the file already exists." })),
	trigger: SAVE_TRIGGER,
});

const profileSaveParams = Type.Object({
	type: StringEnum(["profile"] as const, { description: "User profile entry." }),
	scope: Type.Optional(StringEnum(["global"] as const, { description: "Profile entries are global only." })),
	title: SAVE_TITLE,
	content: Type.String({
		description: "Single entry line for the profile file. Never include secrets.",
		maxLength: MEMORY_FIELD_LIMITS.lineContent,
	}),
	profileFile: StringEnum(PROFILE_FILES, { description: "Target profile file. Required." }),
	confidence: Type.Optional(
		StringEnum(["confirmed", "observed", "inferred", "deprecated"] as const, {
			description:
				"confirmed = user explicitly stated it; observed = stable across sessions; inferred = unconfirmed guess.",
		}),
	),
	name: SAVE_NAME,
	tags: SAVE_TAGS,
	updateExisting: Type.Optional(Type.Boolean({ description: "Ignored for profile entries." })),
	trigger: SAVE_TRIGGER,
});

const openLoopSaveParams = Type.Object({
	type: StringEnum(["open-loop"] as const, { description: "Unfinished cross-session item." }),
	scope: Type.Optional(StringEnum(["global"] as const, { description: "Open loops are global only." })),
	title: SAVE_TITLE,
	content: Type.String({
		description: "Single entry line appended to open-loops.md. Never include secrets.",
		maxLength: MEMORY_FIELD_LIMITS.lineContent,
	}),
	name: SAVE_NAME,
	tags: SAVE_TAGS,
	confidence: Type.Optional(
		StringEnum(["confirmed", "observed", "inferred", "deprecated"] as const, {
			description: "Ignored for open-loop entries.",
		}),
	),
	profileFile: Type.Optional(StringEnum(PROFILE_FILES, { description: "Ignored for open-loop entries." })),
	updateExisting: Type.Optional(Type.Boolean({ description: "Ignored for open-loop entries." })),
	trigger: SAVE_TRIGGER,
});

// Union of per-type variants so providers see the conditional content limit
// (20,000 for category memories, 2,000 for profile/open-loop lines) and the
// required profileFile. Stored as anyOf, which the default tool-declaration
// paths support; this tool does not opt into strict constrained sampling.
const saveParams = Type.Union([categorySaveParams, profileSaveParams, openLoopSaveParams]);

const updateParams = Type.Object({
	ref: Type.String({
		description:
			'Canonical path "<scope>:<category>/<name>.md", e.g. "global:notes/foo.md", as returned by memory_search.',
	}),
	action: StringEnum(["deprecate", "replace"] as const),
	reason: Type.Optional(
		Type.String({ description: "Why it is outdated (for deprecate).", maxLength: MEMORY_FIELD_LIMITS.reason }),
	),
	content: Type.Optional(
		Type.String({ description: "New body (for replace).", maxLength: MEMORY_FIELD_LIMITS.content }),
	),
	trigger: Type.Optional(
		Type.String({ description: "Reason recorded in the evolution log.", maxLength: MEMORY_FIELD_LIMITS.trigger }),
	),
});

export default function memoryExtension(pi: ExtensionAPI): void {
	const globalRoot = getGlobalMemoryDir();
	let sectionCache: string | undefined;

	// Closeout state: tool calls accumulate across low-level runs (retries,
	// compaction recovery); the final stop reason decides whether an automatic
	// closeout may start. Closeout runs are identified by prompt identity.
	let settledRunToolCalls = 0;
	let finalStopReason: StopReason | undefined;
	let isCloseoutRun = false;

	// Footer status state: counts are cached and only recomputed at session
	// start, after memory writes, and when the loaded skill set changes.
	let statusMemCount = -1;
	let statusEvoCount = -1;
	let statusSkillsCount = -1;
	let statusText: string | undefined;

	function invalidateSection(): void {
		sectionCache = undefined;
	}

	function renderStatus(ctx: ExtensionContext): void {
		const parts: string[] = [];
		if (statusMemCount >= 0) {
			parts.push(`mem ${statusMemCount}`);
		}
		if (statusSkillsCount >= 0) {
			parts.push(`skills ${statusSkillsCount}`);
		}
		if (statusEvoCount >= 0) {
			parts.push(`evo ${statusEvoCount}`);
		}
		if (parts.length === 0) {
			return;
		}
		const text = `brain: ${parts.join(" · ")}`;
		if (text === statusText) {
			return;
		}
		statusText = text;
		ctx.ui.setStatus("brain", text);
	}

	async function refreshStatusCounts(ctx: ExtensionContext): Promise<void> {
		const entries = await listMemories(memoryRoots(ctx));
		statusMemCount = entries.filter((entry) => entry.status === "active").length;
		statusEvoCount = await countEvolutionEntries(globalRoot);
		renderStatus(ctx);
	}

	function memoryRoots(ctx: ExtensionContext): MemoryRoot[] {
		const roots: MemoryRoot[] = [{ scope: "global", root: globalRoot }];
		if (ctx.isProjectTrusted()) {
			roots.push({ scope: "project", root: getProjectMemoryDir(ctx.cwd) });
		}
		return roots;
	}

	// =========================================================================
	// Flags
	// =========================================================================

	pi.registerFlag("no-memory-closeout", {
		description: "Disable automatic memory closeout after substantial tasks (manual /closeout still works)",
		type: "boolean",
		default: false,
	});

	// =========================================================================
	// Tools
	// =========================================================================

	pi.registerTool<typeof searchParams, MemorySearchDetails>({
		name: "memory_search",
		label: "Memory Search",
		description:
			"Search long-term memory across projects (paths, workflows, decisions, notes, lessons, user profile, open loops). " +
			"Omit query to list categories and counts. Returns scoped paths like global:notes/foo.md usable with memory_update; read full files with the read tool.",
		promptSnippet: "Search long-term memory across projects",
		promptGuidelines: [
			"Use memory_search at the start of important or long tasks to recall relevant prior knowledge before acting.",
		],
		parameters: searchParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const roots = memoryRoots(ctx);
			if (!params.query) {
				const overview = await memoryOverview(roots);
				return {
					content: [
						{
							type: "text",
							text: `Memory overview:\n${overview}\n\nSearch with a query for specific entries.`,
						},
					],
					details: { query: "", matchCount: 0 },
				};
			}

			const matches = await searchMemories(roots, { query: params.query, type: params.type });
			if (matches.length === 0) {
				const overview = await memoryOverview(roots);
				return {
					content: [
						{
							type: "text",
							text: `No memories match "${params.query}".\n\nMemory overview:\n${overview}`,
						},
					],
					details: { query: params.query, matchCount: 0 },
				};
			}

			const lines = matches.map((match, index) => {
				const meta = [match.type, match.status === "deprecated" ? "deprecated" : null, ...match.tags]
					.filter(Boolean)
					.join(", ");
				const head = `${index + 1}. ${match.scope}:${match.relPath} - ${match.title} [${meta}]`;
				return match.snippet ? `${head}\n   ${match.snippet.replace(/\n/g, "\n   ")}` : head;
			});
			const truncated = truncateHead(lines.join("\n"), { maxLines: 120 });
			return {
				content: [
					{
						type: "text",
						text: truncated.truncated
							? `${truncated.content}\n\n[Truncated to ${truncated.outputLines} lines. Refine the query or read the full files with the read tool.]`
							: truncated.content,
					},
				],
				details: { query: params.query, matchCount: matches.length },
			};
		},
		renderCall(args, theme) {
			const label = args.query ? `"${args.query}"` : "overview";
			return new Text(theme.fg("toolTitle", "memory_search ") + theme.fg("muted", label), 0, 0);
		},
		renderResult(result, { expanded }, theme) {
			const first = result.content.find((block) => block.type === "text");
			const text = first?.type === "text" ? first.text : "";
			if (expanded) {
				return new Text(theme.fg("dim", text), 0, 0);
			}
			const count = result.details.matchCount;
			const summary = count > 0 ? `${count} match(es)` : (text.split("\n")[0]?.slice(0, 80) ?? "no matches");
			return new Text(theme.fg("dim", summary), 0, 0);
		},
	});

	pi.registerTool<typeof saveParams, MemorySaveDetails>({
		name: "memory_save",
		label: "Memory Save",
		description:
			"Save durable, reusable information to long-term memory. Types: projects (stable paths/commands), workflows (verified procedures), decisions (trade-offs with reasons), notes (knowledge), lessons (pitfalls and fixes), profile (user preferences/goals/style/principles with confidence), open-loop (unfinished cross-session items). " +
			"Never save secrets or one-off details. Check memory_search for duplicates first; pass updateExisting=true to overwrite an existing file.",
		promptSnippet: "Persist durable knowledge or user preferences to long-term memory",
		promptGuidelines: [
			"Use memory_save for durable, reusable knowledge (project facts, verified workflows, decisions, lessons, user preferences) instead of leaving it in the conversation.",
		],
		parameters: saveParams,
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (params.type === "profile" && params.confidence === "confirmed") {
				if (!ctx.hasUI) {
					throw new Error(
						"confirmed profile entries require a UI confirmation; use observed or inferred in non-interactive modes",
					);
				}
				const ok = await ctx.ui.confirm(
					"Memory",
					`Record as Confirmed in profile/${params.profileFile}?\n\n${params.title}: ${params.content.slice(0, 200)}`,
				);
				if (!ok) {
					throw new Error("User declined. Save as observed/inferred instead, or ask the user to confirm later.");
				}
			}

			try {
				const result = await saveMemory(memoryRoots(ctx), {
					type: params.type,
					scope: params.scope,
					name: params.name,
					title: params.title,
					content: params.content,
					tags: params.tags,
					confidence: params.confidence,
					profileFile: params.profileFile,
					updateExisting: params.updateExisting,
					trigger: params.trigger,
				});
				await refreshStatusCounts(ctx);

				const ref = `${result.scope}:${result.relPath}`;
				return {
					content: [
						{
							type: "text",
							text: `${result.created ? "Saved" : "Updated"} ${ref} (${params.type}). Recorded in the evolution log; the index was rebuilt. It will be available to future sessions.`,
						},
					],
					details: { ref, type: params.type, created: result.created },
				};
			} finally {
				invalidateSection();
			}
		},
		renderCall(args, theme) {
			const target = args.type === "profile" ? `profile/${args.profileFile ?? "?"}` : (args.name ?? args.title);
			return new Text(theme.fg("toolTitle", "memory_save ") + theme.fg("muted", `${args.type} ${target}`), 0, 0);
		},
		renderResult(result, _options, theme) {
			const details = result.details;
			return new Text(theme.fg("dim", `${details.created ? "saved" : "updated"} ${details.ref}`), 0, 0);
		},
	});

	pi.registerTool<typeof updateParams, MemoryUpdateDetails>({
		name: "memory_update",
		label: "Memory Update",
		description:
			"Deprecate or replace an existing category memory file. Deprecating keeps the content and marks it outdated (never delete memories). Replacing rewrites the body. Only canonical refs like global:notes/foo.md are valid; profile, open loops, and generated files are managed by memory_save.",
		promptSnippet: "Mark outdated memories deprecated or replace their content",
		promptGuidelines: ["Use memory_update to mark outdated memories as deprecated instead of deleting files."],
		parameters: updateParams,
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			try {
				const result = await updateMemory(memoryRoots(ctx), {
					ref: params.ref,
					action: params.action,
					reason: params.reason,
					content: params.content,
					trigger: params.trigger,
				});
				await refreshStatusCounts(ctx);

				const ref = `${result.scope}:${result.relPath}`;
				return {
					content: [
						{
							type: "text",
							text:
								params.action === "deprecate"
									? `Marked ${ref} deprecated. Content kept for history.`
									: `Replaced content of ${ref}.`,
						},
					],
					details: { ref, action: params.action },
				};
			} finally {
				invalidateSection();
			}
		},
		renderCall(args, theme) {
			return new Text(
				theme.fg("toolTitle", "memory_update ") + theme.fg("muted", `${args.action} ${args.ref}`),
				0,
				0,
			);
		},
		renderResult(result, _options, theme) {
			return new Text(theme.fg("dim", `${result.details.action} ${result.details.ref}`), 0, 0);
		},
	});

	// =========================================================================
	// Event wiring
	// =========================================================================

	pi.on("session_start", async (_event, ctx) => {
		sectionCache = undefined;
		settledRunToolCalls = 0;
		finalStopReason = undefined;
		isCloseoutRun = false;
		await ensureLayout(memoryRoots(ctx));
		await refreshStatusCounts(ctx);
	});

	pi.on("before_agent_start", async (event, ctx) => {
		isCloseoutRun = event.prompt === CLOSEOUT_PROMPT;
		if (sectionCache === undefined) {
			const project = memoryRoots(ctx).find((root) => root.scope === "project");
			sectionCache = await buildMemorySection({ scope: "global", root: globalRoot }, project);
		}
		event.systemPromptOptions.sections[MEMORY_SECTION_TAG] = sectionCache;

		const skillsCount = event.systemPromptOptions.skills.length;
		if (skillsCount !== statusSkillsCount) {
			statusSkillsCount = skillsCount;
			renderStatus(ctx);
		}
	});

	pi.on("agent_end", async (event) => {
		settledRunToolCalls += event.messages.filter((message) => message.role === "toolResult").length;
		finalStopReason = lastStopReason(event.messages);
	});

	pi.on("agent_settled", async (_event, ctx) => {
		// Copy and reset first so later runs cannot pollute this decision.
		const toolCalls = settledRunToolCalls;
		const stopReason = finalStopReason;
		settledRunToolCalls = 0;
		finalStopReason = undefined;

		if (isCloseoutRun) {
			isCloseoutRun = false;
			await refreshStatusCounts(ctx);
			return;
		}
		if (stopReason === undefined || !CLOSEOUT_ALLOWED_STOP_REASONS.has(stopReason)) {
			return;
		}
		if (ctx.mode !== "tui") {
			return;
		}
		if (pi.getFlag("no-memory-closeout") === true) {
			return;
		}
		if (toolCalls < AUTO_CLOSEOUT_MIN_TOOL_CALLS) {
			return;
		}
		pi.sendUserMessage(CLOSEOUT_PROMPT, { deliverAs: "followUp" });
	});

	// =========================================================================
	// Commands
	// =========================================================================

	function showLines(ctx: ExtensionContext, lines: string[]): void {
		if (ctx.hasUI) {
			ctx.ui.setWidget("memory", lines);
		} else {
			console.log(lines.join("\n"));
		}
	}

	pi.registerCommand("closeout", {
		description: "Run a memory closeout reflection turn now",
		handler: async () => {
			pi.sendUserMessage(CLOSEOUT_PROMPT, { deliverAs: "followUp" });
		},
	});

	pi.registerCommand("memory", {
		description: "Browse or search long-term memory (/memory [query])",
		getArgumentCompletions: (prefix: string) => {
			const items = ALL_TYPES.map((type) => ({ value: type, label: type }));
			const filtered = items.filter((item) => item.value.startsWith(prefix));
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (args, ctx) => {
			const roots = memoryRoots(ctx);
			const query = args.trim();
			if (!query) {
				const entries = await listMemories(roots);
				const lines = ["Memory overview:", ...(await memoryOverview(roots)).split("\n"), "", "Recent entries:"];
				for (const entry of entries.slice(-15).reverse()) {
					const status = entry.status === "deprecated" ? " [deprecated]" : "";
					lines.push(`- ${entry.scope}:${entry.relPath} - ${entry.title}${status}`);
				}
				showLines(ctx, lines);
				return;
			}

			const matches = await searchMemories(roots, { query });
			if (matches.length === 0) {
				ctx.ui.notify(`No memories match "${query}"`, "info");
				return;
			}

			if (!ctx.hasUI) {
				showLines(
					ctx,
					matches.map((m) => `${m.scope}:${m.relPath} - ${m.title}\n  ${m.snippet}`),
				);
				return;
			}

			const options = matches.map((m) => `${m.scope}:${m.relPath} - ${m.title}`);
			const choice = await ctx.ui.select("Memory results", options);
			if (choice === undefined) {
				return;
			}
			const match = matches[options.indexOf(choice)];
			if (!match) {
				return;
			}
			let text = "";
			try {
				text = await readFile(match.absPath, "utf8");
			} catch {
				ctx.ui.notify(`Cannot read ${match.absPath}`, "error");
				return;
			}
			showLines(ctx, text.split("\n").slice(0, 60));
		},
	});

	pi.registerCommand("evolution", {
		description: "Show recent evolution log entries (/evolution [count])",
		handler: async (args, ctx) => {
			const count = Math.min(Number.parseInt(args, 10) || 10, 50);
			const blocks = await readRecentEvolution(globalRoot, count);
			if (blocks.length === 0) {
				ctx.ui.notify("No evolution entries yet", "info");
				return;
			}
			showLines(
				ctx,
				blocks.flatMap((block) => block.split("\n").slice(0, 8)),
			);
		},
	});

	pi.registerCommand("memory-stats", {
		description: "Show memory and evolution statistics",
		handler: async (_args, ctx) => {
			const overview = await memoryOverview(memoryRoots(ctx));
			const entries = await countEvolutionEntries(globalRoot);
			showLines(ctx, [...overview.split("\n"), `Evolution log entries: ${entries}`]);
		},
	});
}
