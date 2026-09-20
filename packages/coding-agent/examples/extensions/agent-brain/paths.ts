/**
 * Memory directory layout and path safety for the agent-brain extension.
 *
 * The layout mirrors the "her" self-evolving assistant, adapted to pi:
 *
 * <agent-dir>/memory/            global memory root (all projects)
 * ├── profile/                   user profile with confidence levels
 * │   ├── preferences.md
 * │   ├── goals.md
 * │   ├── style.md
 * │   └── principles.md
 * ├── projects/                  stable facts about projects
 * ├── workflows/                 verified reusable procedures
 * ├── decisions/                 important trade-offs and their reasons
 * ├── notes/                     general knowledge notes
 * ├── lessons/                   pitfalls, failures, and fixes
 * ├── open-loops.md              cross-project unfinished items
 * ├── evolution-log.md           append-only system growth history
 * └── _index.md                  auto-generated index (do not edit)
 *
 * <project>/<config-dir>/memory/ project-local memory root (trusted projects)
 * └── ... same categories, except profile (global only)
 *
 * The global root follows getAgentDir() (honors PI_CODING_AGENT_DIR and
 * rebranded config directories); the project root follows CONFIG_DIR_NAME.
 */

import { realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";

export const MEMORY_CATEGORIES = ["projects", "workflows", "decisions", "notes", "lessons"] as const;
export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number];

export const PROFILE_FILES = ["preferences", "goals", "style", "principles"] as const;
export type ProfileFile = (typeof PROFILE_FILES)[number];

/** Pseudo-categories that map to fixed files instead of a category directory. */
export const FIXED_TYPES = ["profile", "open-loop"] as const;
export type FixedType = (typeof FIXED_TYPES)[number];

export type MemoryType = MemoryCategory | FixedType;

export type MemoryScope = "global" | "project";

export type ConfidenceLevel = "confirmed" | "observed" | "inferred" | "deprecated";

export const MEMORY_FILE_NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;

export const MEMORY_NAME_MAX_LENGTH = 64;

export function getGlobalMemoryDir(): string {
	return join(getAgentDir(), "memory");
}

export function getProjectMemoryDir(cwd: string): string {
	return join(cwd, CONFIG_DIR_NAME, "memory");
}

export function categoryDir(root: string, category: MemoryCategory): string {
	return join(root, category);
}

export function profilePath(root: string, file: ProfileFile): string {
	return join(root, "profile", `${file}.md`);
}

export function openLoopsPath(root: string): string {
	return join(root, "open-loops.md");
}

export function evolutionLogPath(root: string): string {
	return join(root, "evolution-log.md");
}

export function indexPath(root: string): string {
	return join(root, "_index.md");
}

/**
 * Derive a kebab-case file name from a title. Returns undefined when the title
 * contains no ASCII letters or digits (for example a CJK-only title); callers
 * should then require an explicit file name.
 */
export function slugify(title: string): string | undefined {
	const slug = title
		.toLowerCase()
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, MEMORY_NAME_MAX_LENGTH);
	if (!MEMORY_FILE_NAME_RE.test(slug)) {
		return undefined;
	}
	return slug;
}

/** Resolve `rel` inside `root`, rejecting paths that escape the memory root lexically. */
export function safeResolve(root: string, rel: string): string {
	if (isAbsolute(rel)) {
		throw new Error(`Absolute paths are not allowed for memory files: ${rel}`);
	}
	const normalizedRoot = resolve(root);
	const target = resolve(normalizedRoot, rel);
	if (target !== normalizedRoot && !target.startsWith(normalizedRoot + sep)) {
		throw new Error(`Path escapes the memory root: ${rel}`);
	}
	return target;
}

/**
 * Resolve `rel` inside `root` and verify the real path stays inside the root.
 * `mustExist` checks the target itself; otherwise the parent directory is
 * checked, which is what new-file writes need.
 */
export async function safeResolveReal(root: string, rel: string, mustExist: boolean): Promise<string> {
	const target = safeResolve(root, rel);
	const realRoot = await realpath(resolve(root));
	const realTarget = await realpath(mustExist ? target : dirname(target));
	if (realTarget !== realRoot && !realTarget.startsWith(realRoot + sep)) {
		throw new Error(`Path escapes the memory root via symlink: ${rel}`);
	}
	return target;
}

export interface CanonicalRef {
	scope: MemoryScope;
	category: MemoryCategory;
	name: string;
}

const CANONICAL_REF_RE = new RegExp(`^(global|project):(${MEMORY_CATEGORIES.join("|")})/([a-z0-9][a-z0-9_-]*)\\.md$`);

/**
 * Parse a memory_update target reference. Only canonical refs are accepted:
 * `<scope>:<category>/<kebab-name>.md`. Reserved files (profile, open-loops,
 * index, evolution log) and nested or non-Markdown paths are rejected.
 */
export function parseCanonicalRef(ref: string): CanonicalRef {
	const match = CANONICAL_REF_RE.exec(ref);
	if (!match) {
		throw new Error(
			`Invalid memory ref "${ref}". Expected <scope>:<category>/<name>.md with scope global|project and category ${MEMORY_CATEGORIES.join("|")}. Profile entries, open loops, and generated files are managed by memory_save.`,
		);
	}
	return { scope: match[1] as MemoryScope, category: match[2] as MemoryCategory, name: match[3] };
}

/** Split a "global:notes/foo.md" style reference into scope + relative path. */
export function parseScopeRef(ref: string): { scope: MemoryScope; rel: string } {
	const idx = ref.indexOf(":");
	if (idx === -1) {
		return { scope: "global", rel: ref };
	}
	const prefix = ref.slice(0, idx);
	if (prefix === "global" || prefix === "project") {
		return { scope: prefix, rel: ref.slice(idx + 1) };
	}
	return { scope: "global", rel: ref };
}
