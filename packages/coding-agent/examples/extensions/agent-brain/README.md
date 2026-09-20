# Agent Brain

The agent's brain, ported from the "her" self-evolving assistant: it remembers across sessions (short and long term), builds a model of you (personalization), and improves over time (self-evolution). All long-term state is plain, diffable Markdown — files are the system.

```bash
pi --extension examples/extensions/agent-brain
# or copy this directory to ~/.pi/agent/extensions/agent-brain/
```

## Mechanism mapping (her → pi)

| her mechanism | This extension |
|---|---|
| Cross-project memory (`vault/agent-memory/`) | `~/.pi/agent/memory/` with `projects/ workflows/ decisions/ notes/ lessons/` |
| Project memory (`vault/projects/`) | `<project>/.pi/memory/` (trusted projects only) |
| User profile with confidence levels (`vault/profile/`) | `~/.pi/agent/memory/profile/{preferences,goals,style,principles}.md` with `Confirmed / Observed / Inferred / Deprecated` sections |
| TODO / open loops | `~/.pi/agent/memory/open-loops.md` (`type: "open-loop"` saves append dated items) |
| Evolution log (`core/evolution_log.md`) | `~/.pi/agent/memory/evolution-log.md`, appended on every write |
| Derived index (`skills/_index.md`) | `~/.pi/agent/memory/_index.md`, rebuilt on every write |
| Memory closeout rule | Auto reflection turn after substantial tasks (≥ 5 tool calls), or `/closeout` |
| Skill lifecycle (repeated tasks → skill) | Closeout proposes creating pi skills in `.pi/skills/`, asking first |
| Permission tiers | Auto: ordinary memories, index, log. Confirm: profile `confirmed` entries. Never: secrets (rejected), deletions (only deprecation) |
| Anti-collapse reverse indicators | Dedup-first rules in the prompt section and closeout prompt |

## Tools

| Tool | Purpose |
|---|---|
| `memory_search` | Keyword search across both roots; returns scoped refs like `global:notes/foo.md`. No query → overview |
| `memory_save` | Save/update one memory; validates kebab-case names, rejects secrets, records evolution log, rebuilds index. Optional `scope` (`global` default, or `project` for trusted projects; profile and open-loop are global only) |
| `memory_update` | `deprecate` (keep content, mark outdated) or `replace` (rewrite body). Only canonical category refs are valid targets; reserved files are rejected |

A stable `<agent-memory>` section is injected into the system prompt with the user profile summary, open loops, and the read/write discipline, so recall works without tool calls for common facts. The section is rebuilt only when memory changes to keep the prompt prefix cache-stable. Injected profile/open-loop text is XML-escaped and length-capped, so hand-edited files cannot break section boundaries or bloat the prompt.

## Commands

| Command | Purpose |
|---|---|
| `/memory [query]` | Overview, or search + select a file to display |
| `/closeout` | Run the memory closeout reflection turn now |
| `/evolution [n=10]` | Show recent evolution log entries |
| `/memory-stats` | Entry counts and evolution log size |

## Footer status

While loaded, the extension shows a live status entry in the TUI footer:

```
brain: mem 12 · skills 8 · evo 5
```

- `mem` — active memory entries across global and project roots
- `skills` — skills loaded in the current session (pi's skill discovery)
- `evo` — entries in the evolution log

Counts refresh at session start, after every memory write, and when the loaded skill set changes. Detail lives in `/memory-stats` and `/evolution`.

## Flags

- `--no-memory-closeout` disables automatic closeout after substantial tasks (manual `/closeout` still works)

## Layout

The global root follows pi's agent directory (`getAgentDir()`, honors `PI_CODING_AGENT_DIR` and rebranded distributions); the project root follows `CONFIG_DIR_NAME`. Default paths:

```
~/.pi/agent/memory/            global root
├── profile/            preferences / goals / style / principles (confidence sections)
├── projects/           stable project facts, paths, commands
├── workflows/          verified reusable procedures
├── decisions/          trade-offs and their reasons
├── notes/              general knowledge
├── lessons/            pitfalls, failures, fixes
├── open-loops.md       cross-project unfinished items
├── evolution-log.md    append-only growth history
└── _index.md           derived index (do not edit)

<project>/.pi/memory/          project root (trusted projects, same categories, no profile)
└── _index.md           created on the first project-scoped write
```

## Safety boundaries

- **Concurrency**: `memory_save`/`memory_update` run in sequential tool mode and wrap every read-modify-write in pi's per-file mutation queue, so parallel tool calls cannot lose entries. The queue is process-local; concurrent independent pi processes writing the same memory dir are not coordinated.
- **Reserved files**: `memory_update` only accepts canonical category refs (`<scope>:<category>/<name>.md`); the evolution log, indexes, profile files, and open loops can never be overwritten through it. Symlinked targets escaping a memory root are rejected.
- **Confirmed entries**: `confidence: "confirmed"` requires an interactive confirmation. In print/JSON mode (no UI) it is rejected — use `observed`/`inferred` there.
- **Input limits**: titles, tags, triggers, and reasons are single-line with length caps; content is capped per type; all persisted free text passes the secret denylist.
- **Closeout trigger**: automatic closeout only starts after a run chain that ended successfully (`stop`/`toolUse`); aborted or errored runs never restart the model on their own.

## Discipline (enforced in the prompt section)

- **Write** only durable, reusable information: stable paths and commands, verified fixes, decisions with reasons, stable user preferences, open loops.
- **Never write** chat transcripts, one-off steps, credentials, or filler summaries. Secret-looking content is rejected by `memory_save`.
- **Dedup first**: `memory_search` before `memory_save`; update existing memories instead of creating near-duplicates.
- **Deprecate, never delete**: outdated memories keep their content and gain a deprecation note.
- **Confidence grading**: `confirmed` (user explicitly stated — asks for confirmation in TUI), `observed` (stable across sessions), `inferred` (unconfirmed guess).
