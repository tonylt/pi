/**
 * Memory store: list, search, save, and update memory files; maintain the
 * auto-generated index and the append-only evolution log.
 *
 * Design rules inherited from the "her" self-evolving assistant:
 * - Files are the system: all long-term state is readable, diffable Markdown.
 * - Never delete memories; mark them deprecated with a reason instead.
 * - Every meaningful write is recorded in evolution-log.md.
 * - The index (_index.md) is always derived, never hand-edited.
 *
 * Concurrency: every read-modify-write window runs inside the process-wide
 * withFileMutationQueue() on its target file, so parallel tool calls cannot
 * interleave and lose entries. Shared files (evolution log, index) queue on
 * their own real paths; nesting is acyclic because reserved files are never
 * valid update targets.
 */

import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { extractSection, formatFrontMatter, insertInSection, parseFrontMatter, parseTags } from "./frontmatter.ts";
import {
	type ConfidenceLevel,
	categoryDir,
	evolutionLogPath,
	indexPath,
	MEMORY_CATEGORIES,
	MEMORY_FILE_NAME_RE,
	MEMORY_NAME_MAX_LENGTH,
	type MemoryScope,
	type MemoryType,
	openLoopsPath,
	PROFILE_FILES,
	type ProfileFile,
	parseCanonicalRef,
	profilePath,
	safeResolve,
	safeResolveReal,
	slugify,
} from "./paths.ts";

export interface MemoryEntry {
	scope: MemoryScope;
	/** Path relative to the memory root, e.g. "notes/foo.md". */
	relPath: string;
	absPath: string;
	type: MemoryType;
	title: string;
	created: string;
	updated: string;
	confidence?: ConfidenceLevel;
	tags: string[];
	status: "active" | "deprecated";
}

export interface MemoryMatch extends MemoryEntry {
	score: number;
	snippet: string;
}

export interface MemoryRoot {
	scope: MemoryScope;
	root: string;
}

export interface SearchOptions {
	query?: string;
	type?: MemoryType;
}

export interface SaveOptions {
	type: MemoryType;
	/** Memory root scope. Defaults to global; profile and open-loop are global only. */
	scope?: MemoryScope;
	/** File base name without extension, kebab-case. */
	name?: string;
	title: string;
	content: string;
	tags?: string[];
	confidence?: ConfidenceLevel;
	/** Profile target file; required when type is "profile". */
	profileFile?: ProfileFile;
	/** Replace the body when the file already exists. */
	updateExisting?: boolean;
	/** Short reason recorded in the evolution log. */
	trigger?: string;
}

export type EvolutionDimension = "knowledge" | "profile" | "capability";

export interface EvolutionEntry {
	title: string;
	dimension: EvolutionDimension;
	trigger: string;
	files: string[];
	result: string;
}

/** Conservative trust-boundary limits shared by the tool schema and the store. */
export const MEMORY_FIELD_LIMITS = {
	query: 500,
	title: 200,
	content: 20000,
	/** Line-style entries: profile and open-loop content. */
	lineContent: 2000,
	tags: 20,
	tag: 64,
	trigger: 500,
	reason: 500,
} as const;

const SECRET_PATTERNS: RegExp[] = [
	/sk-ant-[a-z0-9_-]{10,}/i,
	/sk-[a-z0-9]{20,}/i,
	/api[_-]?key\s*[:=]\s*["']?[a-z0-9._-]{12,}/i,
	/bearer\s+[a-z0-9._-]{16,}/i,
	/password\s*[:=]\s*\S+/i,
	/secret\s*[:=]\s*["']?[a-z0-9._-]{12,}/i,
	/AKIA[0-9A-Z]{16}/,
	/ghp_[a-zA-Z0-9]{20,}/,
	/xox[baprs]-[a-z0-9-]{10,}/i,
];

/** Return a description of the first secret-looking pattern found, or null. */
export function findSecretIssue(content: string): string | null {
	for (const pattern of SECRET_PATTERNS) {
		if (pattern.test(content)) {
			return `content looks like it contains credentials (${pattern.source}); never store secrets in memory`;
		}
	}
	return null;
}

function today(): string {
	return new Date().toISOString().slice(0, 10);
}

function nowStamp(): string {
	return new Date().toISOString().slice(0, 16).replace("T", " ");
}

export function evolutionDimensionForType(type: MemoryType): EvolutionDimension {
	if (type === "profile") {
		return "profile";
	}
	if (type === "workflows") {
		return "capability";
	}
	return "knowledge";
}

function validateSingleLine(field: string, value: string, max: number): void {
	if (/[\r\n]/.test(value)) {
		throw new Error(`${field} must be a single line`);
	}
	if (value.length > max) {
		throw new Error(`${field} must be at most ${max} characters`);
	}
}

function assertNoSecrets(fields: Record<string, string>): void {
	for (const [name, value] of Object.entries(fields)) {
		const issue = findSecretIssue(value);
		if (issue) {
			throw new Error(`${name}: ${issue}`);
		}
	}
}

function validateSaveOptions(options: SaveOptions): void {
	const { title, content, tags, trigger, name, type, profileFile } = options;

	validateSingleLine("title", title, MEMORY_FIELD_LIMITS.title);
	if (trigger !== undefined) {
		validateSingleLine("trigger", trigger, MEMORY_FIELD_LIMITS.trigger);
	}

	if (tags !== undefined) {
		if (tags.length > MEMORY_FIELD_LIMITS.tags) {
			throw new Error(`tags must contain at most ${MEMORY_FIELD_LIMITS.tags} entries`);
		}
		for (const tag of tags) {
			validateSingleLine("tag", tag, MEMORY_FIELD_LIMITS.tag);
		}
	}

	if (name !== undefined) {
		validateName(name);
	}

	if (type === "profile" || type === "open-loop") {
		validateSingleLine("content", content, MEMORY_FIELD_LIMITS.lineContent);
		if (type === "profile" && !profileFile) {
			throw new Error('type "profile" requires profileFile (preferences | goals | style | principles).');
		}
	} else if (content.length > MEMORY_FIELD_LIMITS.content) {
		throw new Error(`content must be at most ${MEMORY_FIELD_LIMITS.content} characters`);
	}

	assertNoSecrets({
		title,
		content,
		...(trigger !== undefined ? { trigger } : {}),
		...(tags !== undefined ? { tags: tags.join(", ") } : {}),
	});
}

function validateName(name: string): void {
	if (name.length > MEMORY_NAME_MAX_LENGTH || !MEMORY_FILE_NAME_RE.test(name)) {
		throw new Error(
			`Invalid memory file name "${name}". Use lowercase kebab-case (a-z, 0-9, '-', '_'), at most ${MEMORY_NAME_MAX_LENGTH} characters.`,
		);
	}
}

function validateUpdateOptions(options: UpdateOptions): void {
	if (options.reason !== undefined) {
		validateSingleLine("reason", options.reason, MEMORY_FIELD_LIMITS.reason);
	}
	if (options.trigger !== undefined) {
		validateSingleLine("trigger", options.trigger, MEMORY_FIELD_LIMITS.trigger);
	}
	if (options.content !== undefined) {
		if (options.content.length > MEMORY_FIELD_LIMITS.content) {
			throw new Error(`content must be at most ${MEMORY_FIELD_LIMITS.content} characters`);
		}
	}
	// All free text that reaches memory files or the evolution log must pass
	// the secret denylist: reason lands in front matter and body, trigger in
	// the global evolution log, content in the memory body.
	assertNoSecrets({
		...(options.reason !== undefined ? { reason: options.reason } : {}),
		...(options.trigger !== undefined ? { trigger: options.trigger } : {}),
		...(options.content !== undefined ? { content: options.content } : {}),
	});
}

/** Create the memory directory layout and scaffold fixed files if missing. */
export async function ensureLayout(roots: MemoryRoot[]): Promise<void> {
	for (const { scope, root } of roots) {
		await mkdir(root, { recursive: true });
		for (const category of MEMORY_CATEGORIES) {
			await mkdir(categoryDir(root, category), { recursive: true });
		}
		if (scope === "global") {
			await mkdir(join(root, "profile"), { recursive: true });
		}
	}

	const global = roots.find((r) => r.scope === "global");
	if (!global) {
		return;
	}

	for (const file of PROFILE_FILES) {
		const path = profilePath(global.root, file);
		if (!(await pathExists(path))) {
			const heading = file.charAt(0).toUpperCase() + file.slice(1);
			const sections = ["Confirmed", "Observed", "Inferred", "Deprecated"].map((s) => `## ${s}\n`).join("\n");
			await writeFile(path, `# ${heading}\n\n${sections}`, "utf8");
		}
	}

	const loops = openLoopsPath(global.root);
	if (!(await pathExists(loops))) {
		await writeFile(
			loops,
			"# Open Loops\n\nCross-project unfinished items. Close items by editing this file.\n",
			"utf8",
		);
	}

	const log = evolutionLogPath(global.root);
	if (!(await pathExists(log))) {
		await writeFile(log, "# Evolution Log\n\nAppend-only history of memory evolutions.\n", "utf8");
	}

	const index = indexPath(global.root);
	if (!(await pathExists(index))) {
		await rebuildIndex(global);
	}
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

function entryFrom(scope: MemoryScope, root: string, absPath: string, type: MemoryType, text: string): MemoryEntry {
	const { meta, body } = parseFrontMatter(text);
	const firstHeading = body.match(/^#\s+(.+)$/m);
	return {
		scope,
		relPath: relative(root, absPath),
		absPath,
		type,
		title: meta.title ?? firstHeading?.[1] ?? basename(absPath, ".md"),
		created: meta.created ?? "",
		updated: meta.updated ?? meta.created ?? "",
		confidence: (meta.confidence as ConfidenceLevel | undefined) ?? undefined,
		tags: parseTags(meta.tags),
		status: meta.status === "deprecated" ? "deprecated" : "active",
	};
}

/** List all memory entries across the given roots. */
export async function listMemories(roots: MemoryRoot[]): Promise<MemoryEntry[]> {
	const entries: MemoryEntry[] = [];
	for (const { scope, root } of roots) {
		for (const category of MEMORY_CATEGORIES) {
			const dir = categoryDir(root, category);
			if (!(await pathExists(dir))) {
				continue;
			}
			for (const file of await readdir(dir)) {
				if (!file.endsWith(".md") || file.startsWith("_")) {
					continue;
				}
				const absPath = join(dir, file);
				try {
					entries.push(entryFrom(scope, root, absPath, category, await readFile(absPath, "utf8")));
				} catch {
					// Unreadable files are skipped; listing must not fail.
				}
			}
		}

		if (scope === "global") {
			for (const file of PROFILE_FILES) {
				const absPath = profilePath(root, file);
				if (await pathExists(absPath)) {
					entries.push(entryFrom(scope, root, absPath, "profile", await readFile(absPath, "utf8")));
				}
			}
			const loops = openLoopsPath(root);
			if (await pathExists(loops)) {
				entries.push(entryFrom(scope, root, loops, "open-loop", await readFile(loops, "utf8")));
			}
		}
	}
	entries.sort((a, b) => a.relPath.localeCompare(b.relPath));
	return entries;
}

function scoreEntry(entry: MemoryEntry, body: string, terms: string[]): number {
	let score = 0;
	const title = entry.title.toLowerCase();
	const fileName = basename(entry.relPath, ".md").toLowerCase();
	for (const term of terms) {
		if (title.includes(term)) {
			score += 3;
		}
		if (fileName.includes(term)) {
			score += 2;
		}
		if (entry.tags.some((tag) => tag.includes(term))) {
			score += 2;
		}
		if (body.toLowerCase().includes(term)) {
			score += 1;
		}
	}
	return score;
}

function buildSnippet(body: string, terms: string[]): string {
	const lines = body.split("\n");
	const matched: string[] = [];
	for (const line of lines) {
		if (matched.length >= 2) {
			break;
		}
		const lower = line.toLowerCase();
		if (terms.length === 0 || terms.some((term) => lower.includes(term))) {
			matched.push(line.trim().slice(0, 160));
		}
	}
	return matched.join("\n");
}

/** Search memory entries by keyword. Entries with score 0 are excluded. */
export async function searchMemories(roots: MemoryRoot[], options: SearchOptions): Promise<MemoryMatch[]> {
	const terms = (options.query ?? "")
		.toLowerCase()
		.split(/[^a-z0-9\u4e00-\u9fff]+/)
		.filter(Boolean);

	const entries = await listMemories(roots);
	const matches: MemoryMatch[] = [];
	for (const entry of entries) {
		if (options.type && entry.type !== options.type) {
			continue;
		}
		if (entry.relPath === "_index.md" || entry.relPath === "evolution-log.md") {
			continue;
		}
		let body = "";
		try {
			body = await readFile(entry.absPath, "utf8");
		} catch {
			continue;
		}
		const score = terms.length === 0 ? 1 : scoreEntry(entry, body, terms);
		if (score <= 0) {
			continue;
		}
		matches.push({ ...entry, score, snippet: buildSnippet(body, terms) });
	}
	matches.sort((a, b) => b.score - a.score || a.relPath.localeCompare(b.relPath));
	return matches.slice(0, 25);
}

/** Category overview with counts, used when no query is given. */
export async function memoryOverview(roots: MemoryRoot[]): Promise<string> {
	const entries = await listMemories(roots);
	const counts = new Map<string, number>();
	for (const entry of entries) {
		const key = `${entry.scope}:${entry.type}`;
		counts.set(key, (counts.get(key) ?? 0) + 1);
	}
	const lines: string[] = [];
	for (const scope of ["global", "project"] as const) {
		const prefix = scope === "global" ? "Global" : "Project";
		const parts: string[] = [];
		for (const type of [...MEMORY_CATEGORIES, "profile", "open-loop"] as const) {
			const count = counts.get(`${scope}:${type}`);
			if (count) {
				parts.push(`${type}: ${count}`);
			}
		}
		lines.push(`${prefix}: ${parts.length > 0 ? parts.join(", ") : "empty"}`);
	}
	const active = entries.filter((e) => e.status === "active").length;
	const deprecated = entries.length - active;
	lines.push(`Total: ${entries.length} entries (${active} active, ${deprecated} deprecated)`);
	return lines.join("\n");
}

export interface SaveResult {
	scope: MemoryScope;
	absPath: string;
	/** Path relative to the memory root. */
	relPath: string;
	created: boolean;
}

function requireRoot(roots: MemoryRoot[], scope: MemoryScope): MemoryRoot {
	const root = roots.find((r) => r.scope === scope);
	if (!root) {
		throw new Error(
			scope === "global"
				? "Global memory root unavailable."
				: "Project memory root unavailable (is the project trusted?).",
		);
	}
	return root;
}

/**
 * Save a memory entry. Creates or updates the file inside the per-file
 * mutation queue, then records the evolution entry and rebuilds the index
 * for the affected scope.
 */
export async function saveMemory(roots: MemoryRoot[], options: SaveOptions): Promise<SaveResult> {
	validateSaveOptions(options);

	const scope = options.scope ?? "global";
	const global = requireRoot(roots, "global");

	if ((options.type === "profile" || options.type === "open-loop") && scope !== "global") {
		throw new Error(`type "${options.type}" is global only`);
	}

	if (options.type === "open-loop") {
		const path = openLoopsPath(global.root);
		// ponytail: queue is process-local; add a lockfile only if concurrent pi processes cause real contention.
		return withFileMutationQueue(path, async () => {
			let text = "";
			if (await pathExists(path)) {
				text = await readFile(path, "utf8");
			}
			const line = `- [ ] (${today()}) ${options.content.replace(/\n+/g, " ").trim()}`;
			await writeFile(path, insertInSection(text, "Open Loops", line), "utf8");
			await finalizeEvolution(roots, "global", {
				title: options.title || "Open loop added",
				dimension: "knowledge",
				trigger: options.trigger ?? "memory_save (open-loop)",
				files: ["global:open-loops.md"],
				result: "recorded open loop",
			});
			return { scope: "global", absPath: path, relPath: "open-loops.md", created: false };
		});
	}

	if (options.type === "profile") {
		const file = options.profileFile;
		if (!file) {
			throw new Error('type "profile" requires profileFile (preferences | goals | style | principles).');
		}
		const confidence = options.confidence ?? "observed";
		const relPath = `profile/${file}.md`;
		const absPath = profilePath(global.root, file);
		return withFileMutationQueue(absPath, async () => {
			let text = "";
			if (await pathExists(absPath)) {
				text = await readFile(absPath, "utf8");
			}
			const heading = confidence.charAt(0).toUpperCase() + confidence.slice(1);
			const line = `- ${heading}: ${options.content.replace(/\n+/g, " ").trim()}`;
			await writeFile(absPath, insertInSection(text, heading, line), "utf8");
			await finalizeEvolution(roots, "global", {
				title: `Profile ${file}: ${options.title}`,
				dimension: "profile",
				trigger: options.trigger ?? "memory_save (profile)",
				files: [`global:${relPath}`],
				result: `recorded ${confidence} entry`,
			});
			return { scope: "global", absPath, relPath, created: false };
		});
	}

	if (!MEMORY_CATEGORIES.includes(options.type)) {
		throw new Error(`Unknown memory type: ${options.type}`);
	}

	const name = options.name ?? slugify(options.title);
	if (name === undefined) {
		throw new Error(
			`Cannot derive a kebab-case file name from title "${options.title}". Pass name=<kebab-case> explicitly.`,
		);
	}
	validateName(name);

	const root = requireRoot(roots, scope);
	const relPath = `${options.type}/${name}.md`;
	const absPath = safeResolve(root.root, relPath);
	return withFileMutationQueue(absPath, async () => {
		const exists = await pathExists(absPath);
		if (exists && !options.updateExisting) {
			throw new Error(
				`Memory file already exists: ${scope}:${relPath}. Pass updateExisting=true to replace its content, or pick another name.`,
			);
		}
		await mkdir(dirname(absPath), { recursive: true });
		await safeResolveReal(root.root, relPath, exists);

		let created = today();
		if (exists) {
			const previous = parseFrontMatter(await readFile(absPath, "utf8"));
			created = previous.meta.created ?? today();
		}

		const meta: Record<string, string> = {
			type: options.type,
			title: options.title,
			created,
			updated: today(),
			status: "active",
		};
		if (options.tags && options.tags.length > 0) {
			meta.tags = options.tags.join(", ");
		}
		const body = `${formatFrontMatter(meta)}\n# ${options.title}\n\n${options.content.trim()}\n`;
		await writeFile(absPath, body, "utf8");

		await finalizeEvolution(roots, scope, {
			title: options.title,
			dimension: evolutionDimensionForType(options.type),
			trigger: options.trigger ?? `memory_save (${options.type})`,
			files: [`${scope}:${relPath}`],
			result: exists ? "updated existing memory" : "created new memory",
		});

		return { scope, absPath, relPath, created: !exists };
	});
}

export interface UpdateOptions {
	/** Canonical reference like "global:notes/foo.md". */
	ref: string;
	action: "deprecate" | "replace";
	reason?: string;
	content?: string;
	trigger?: string;
}

export interface UpdateResult {
	scope: MemoryScope;
	absPath: string;
	relPath: string;
	action: "deprecate" | "replace";
}

/**
 * Deprecate or replace a standalone category memory file. Only canonical
 * category refs are valid targets; reserved files (profile, open loops,
 * index, evolution log) are managed by saveMemory and generated internally.
 */
export async function updateMemory(roots: MemoryRoot[], options: UpdateOptions): Promise<UpdateResult> {
	const canonical = parseCanonicalRef(options.ref);
	validateUpdateOptions(options);

	const root = requireRoot(roots, canonical.scope);
	const relPath = `${canonical.category}/${canonical.name}.md`;
	const absPath = safeResolve(root.root, relPath);

	return withFileMutationQueue(absPath, async () => {
		if (!(await pathExists(absPath))) {
			throw new Error(`Memory file not found: ${canonical.scope}:${relPath}`);
		}
		await safeResolveReal(root.root, relPath, true);

		const text = await readFile(absPath, "utf8");
		const { meta, body } = parseFrontMatter(text);
		const title = meta.title ?? relPath;
		const nextMeta: Record<string, string> = { ...meta, updated: today() };
		let nextBody = body;

		if (options.action === "deprecate") {
			nextMeta.status = "deprecated";
			nextMeta.deprecatedAt = today();
			if (options.reason) {
				nextMeta.deprecatedReason = options.reason.replace(/\n+/g, " ").trim();
			}
			nextBody = `> Deprecated (${today()}): ${options.reason ?? "no longer accurate"}\n\n${body}`;
		} else {
			if (!options.content) {
				throw new Error('action "replace" requires content.');
			}
			nextMeta.status = "active";
			delete nextMeta.deprecatedAt;
			delete nextMeta.deprecatedReason;
			nextBody = `# ${title}\n\n${options.content.trim()}\n`;
		}

		await writeFile(absPath, `${formatFrontMatter(nextMeta)}\n${nextBody}`, "utf8");

		await finalizeEvolution(roots, canonical.scope, {
			title,
			dimension: "knowledge",
			trigger: options.trigger ?? `memory_update (${options.action})`,
			files: [`${canonical.scope}:${relPath}`],
			result: options.action === "deprecate" ? "marked deprecated" : "replaced content",
		});

		return { scope: canonical.scope, absPath, relPath, action: options.action };
	});
}

/**
 * Record the evolution entry in the global log and rebuild the index of the
 * affected scope. Both writes queue on their own shared file paths.
 */
async function finalizeEvolution(roots: MemoryRoot[], scope: MemoryScope, entry: EvolutionEntry): Promise<void> {
	const global = requireRoot(roots, "global");
	await appendEvolutionLog(global.root, entry);
	await rebuildIndex(requireRoot(roots, scope));
}

/** Append one entry to evolution-log.md. */
export async function appendEvolutionLog(globalRoot: string, entry: EvolutionEntry): Promise<void> {
	const path = evolutionLogPath(globalRoot);
	return withFileMutationQueue(path, async () => {
		let text = "";
		if (await pathExists(path)) {
			text = await readFile(path, "utf8");
		}
		const block = [
			`## ${nowStamp()} - ${entry.title}`,
			"",
			`- Type: ${entry.dimension} evolution`,
			`- Trigger: ${entry.trigger}`,
			`- Files: ${entry.files.join(", ")}`,
			`- Result: ${entry.result}`,
			"",
		].join("\n");
		await writeFile(path, `${text.replace(/\s+$/, "")}\n\n${block}`, "utf8");
	});
}

/** Read the last n entries from the evolution log, newest first. */
export async function readRecentEvolution(globalRoot: string, count: number): Promise<string[]> {
	const path = evolutionLogPath(globalRoot);
	if (!(await pathExists(path))) {
		return [];
	}
	const text = await readFile(path, "utf8");
	const blocks = text.split(/\n(?=## )/).filter((block) => block.startsWith("## "));
	return blocks.slice(-count).reverse();
}

/** Rebuild the derived index at the root's _index.md. Returns the entry count. */
export async function rebuildIndex(memoryRoot: MemoryRoot): Promise<number> {
	const path = indexPath(memoryRoot.root);
	return withFileMutationQueue(path, async () => {
		const entries = await listMemories([memoryRoot]);
		const rows = entries
			.filter((e) => e.relPath !== "_index.md" && e.relPath !== "evolution-log.md")
			.map((e) => {
				const tags = e.tags.length > 0 ? e.tags.join(", ") : "-";
				const status = e.status === "deprecated" ? "deprecated" : "active";
				return `| ${e.scope}:${e.relPath} | ${e.type} | ${e.title.replace(/\|/g, "\\|")} | ${e.updated || "-"} | ${tags} | ${status} |`;
			});

		const header = [
			"# Memory Index",
			"",
			"> Auto-generated by the memory extension. Do not edit by hand.",
			"",
			"| File | Type | Title | Updated | Tags | Status |",
			"|------|------|-------|---------|------|--------|",
		];
		await writeFile(path, `${header.concat(rows).join("\n")}\n`, "utf8");
		return rows.length;
	});
}

/** Compact profile summary: only Confirmed and Observed lines. */
export async function readProfileSummary(globalRoot: string, maxLines = 24): Promise<string> {
	const lines: string[] = [];
	for (const file of PROFILE_FILES) {
		const path = profilePath(globalRoot, file);
		if (!(await pathExists(path))) {
			continue;
		}
		const { body } = parseFrontMatter(await readFile(path, "utf8"));
		for (const level of ["Confirmed", "Observed"] as const) {
			for (const line of extractSection(body, level)) {
				lines.push(`- [${file}] ${level}: ${line.replace(/^- (Confirmed|Observed):\s*/i, "")}`);
			}
		}
	}
	return lines.slice(0, maxLines).join("\n");
}

/** Head of open-loops.md, skipping the title. */
export async function readOpenLoopsHead(globalRoot: string, maxLines = 6): Promise<string> {
	const path = openLoopsPath(globalRoot);
	if (!(await pathExists(path))) {
		return "";
	}
	const text = await readFile(path, "utf8");
	const lines = text
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line && !line.startsWith("#") && !line.startsWith(">"));
	return lines.slice(0, maxLines).join("\n");
}

/** Count entries in the evolution log. */
export async function countEvolutionEntries(globalRoot: string): Promise<number> {
	const path = evolutionLogPath(globalRoot);
	if (!(await pathExists(path))) {
		return 0;
	}
	const text = await readFile(path, "utf8");
	return text.split(/\n(?=## )/).filter((block) => block.startsWith("## ")).length;
}
