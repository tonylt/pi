/**
 * Minimal `key: value` front matter parser/formatter.
 *
 * Intentionally single-line only (same trade-off as her's skill_manager.py):
 * no YAML dependency, no nested values. Memory files keep front matter flat.
 */

const FRONT_MATTER_BOUNDARY = /^---\s*$/;

export type FrontMatter = Record<string, string>;

export interface ParsedMemoryFile {
	meta: FrontMatter;
	body: string;
}

export function parseFrontMatter(text: string): ParsedMemoryFile {
	if (!text.startsWith("---")) {
		return { meta: {}, body: text };
	}
	const lines = text.split("\n");
	// lines[0] is the opening boundary; find the closing one.
	let end = -1;
	for (let i = 1; i < lines.length; i++) {
		if (FRONT_MATTER_BOUNDARY.test(lines[i])) {
			end = i;
			break;
		}
	}
	if (end === -1) {
		return { meta: {}, body: text };
	}

	const meta: FrontMatter = {};
	for (const line of lines.slice(1, end)) {
		const stripped = line.trim();
		if (!stripped || stripped.startsWith("#")) {
			continue;
		}
		const sep = stripped.indexOf(":");
		if (sep === -1) {
			continue;
		}
		const key = stripped.slice(0, sep).trim();
		const value = stripped
			.slice(sep + 1)
			.trim()
			.replace(/^["']|["']$/g, "");
		meta[key] = value;
	}
	return {
		meta,
		body: lines
			.slice(end + 1)
			.join("\n")
			.replace(/^\n+/, ""),
	};
}

export function formatFrontMatter(meta: FrontMatter): string {
	const lines = Object.entries(meta)
		.filter(([, value]) => value !== undefined && value !== "")
		.map(([key, value]) => `${key}: ${value}`);
	if (lines.length === 0) {
		return "";
	}
	return `---\n${lines.join("\n")}\n---\n`;
}

export function parseTags(raw: string | undefined): string[] {
	if (!raw) {
		return [];
	}
	return raw
		.split(",")
		.map((tag) => tag.trim().toLowerCase())
		.filter(Boolean);
}

/** Extract body lines under a `## <heading>` section until the next heading. */
export function extractSection(body: string, heading: string): string[] {
	const lines = body.split("\n");
	const result: string[] = [];
	let inSection = false;
	for (const line of lines) {
		if (/^##\s+/.test(line)) {
			if (inSection) {
				break;
			}
			inSection = line.slice(3).trim().toLowerCase() === heading.toLowerCase();
			continue;
		}
		if (inSection && line.trim()) {
			result.push(line.trim());
		}
	}
	return result;
}

/** Insert a line at the end of a `## <heading>` section, creating it if missing. */
export function insertInSection(body: string, heading: string, line: string): string {
	const lines = body.split("\n");
	const headingLower = heading.toLowerCase();
	let start = -1;
	for (let i = 0; i < lines.length; i++) {
		if (/^##\s+/.test(lines[i]) && lines[i].slice(3).trim().toLowerCase() === headingLower) {
			start = i;
			break;
		}
	}

	if (start === -1) {
		// Append a new section at the end.
		const trimmed = body.replace(/\s+$/, "");
		return `${trimmed}\n\n## ${heading}\n\n${line}\n`;
	}

	// Find insertion point: after the last non-empty line of the section.
	let insertAt = start + 1;
	while (insertAt < lines.length && !/^##\s+/.test(lines[insertAt])) {
		insertAt++;
	}
	// insertAt is now the next heading or EOF; walk back over blank lines.
	while (insertAt > start + 1 && !lines[insertAt - 1].trim()) {
		insertAt--;
	}
	lines.splice(insertAt, 0, line);
	return lines.join("\n");
}
