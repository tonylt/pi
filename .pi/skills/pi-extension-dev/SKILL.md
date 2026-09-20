---
name: pi-extension-dev
description: Develop, test, and fix pi coding-agent extensions in this repo. Use when building a new extension for packages/coding-agent/examples/extensions/, writing its persistent vitest tests, or debugging extension lifecycle/concurrency issues.
---

# Pi Extension Development

Verified workflow from the agent-brain build + review-fix cycles (2026-09-21). Deeper context lives in the repo docs and agent memory; this file is the checklist.

## Before writing code

1. Read `packages/coding-agent/docs/extensions.md` fully (events, ExtensionAPI, tool definition, `executionMode`).
2. Read one adjacent example + its test: `examples/extensions/plan-mode/` and `test/plan-mode-extension.test.ts` — copy this mock style, do not invent a new harness.
3. Check exports in `packages/coding-agent/src/index.ts` (e.g. `truncateHead`, `withFileMutationQueue`, `CONFIG_DIR_NAME`, `getAgentDir`) before reimplementing anything.

## Non-negotiable pitfalls (each caused a real bug)

- **Boolean extension flags are presence-based**: any CLI occurrence resolves to `true`; `--flag=false` is invalid. Disabling flags must be named `--no-*`.
- **Concurrent writes lose data** unless both layers are in place: write tools get `executionMode: "sequential"` AND every read-modify-write window on a target file runs inside `withFileMutationQueue(targetPath, fn)` (wrap reads too, not just `writeFile`). Shared files (logs, indexes) queue on their own real paths; nesting is safe only if reserved files can never be update targets.
- **Update targets must be authorized, not just path-contained**: validate refs against an explicit canonical pattern (`<scope>:<category>/<name>.md`); reject reserved/generated files, nested paths, non-`.md`, unknown scope prefixes; add a `realpath()` escape check for symlinks.
- **Stateful auto-triggers need a state machine**: accumulate tool calls across low-level runs (`agent_end`), gate on the final assistant `stopReason` (only `stop`/`toolUse` may auto-continue), reset on `session_start`, and identify self-triggered runs by prompt identity (export the prompt as a module constant) instead of a pending flag that can get stuck.
- **Injected prompt text is untrusted**: XML-escape and length-cap anything read from memory files before inserting into system prompt sections, even if writes are validated. Never tail-truncate a composed section — that cuts the trusted safety rules, closing tags, and pointers. Budget dynamic data instead: measure the fixed skeleton (compose with empty dynamic blocks), split the remaining budget across dynamic blocks (reserve a share for weaker blocks so one cannot squeeze out the other), and let the fit function guarantee the marker stays inside budget. Two traps: rule text must not contain raw tag literals that duplicate real delimiters (counting ambiguity), and read-side line prefixes count toward the per-line cap (place injection probes at line start in tests).
- **Type.Union of full objects is safe in tool parameters on default paths**: the docs warning "Type.Union doesn't work with Google's API" covers enum-style unions and the legacy OpenAPI path; the default `parametersJsonSchema` path supports anyOf (`google-shared.ts`), and strict sampling (root must be a plain object) only applies when the tool opts into `constrainedSampling`. Use a discriminated union of per-type variants (each with the full field set so TS property access stays valid) to express conditional limits like per-type `content.maxLength`; keep store-level validation as the second layer. Only the legacy Cloud Code Assist `parameters` path is a theoretical risk.
- **Path config**: use `getAgentDir()` (honors `PI_CODING_AGENT_DIR`) and `CONFIG_DIR_NAME`; never hardcode `~/.pi` or `.pi`.

## Persistent tests

- Location: `packages/coding-agent/test/<name>-extension.test.ts` (Vitest). `packages/coding-agent/vitest.config.ts` already aliases `@earendil-works/pi-coding-agent` to src.
- Mock the minimum `ExtensionAPI` surface (on/registerTool/registerCommand/registerFlag/getFlag/sendUserMessage) with Maps; narrow with `as unknown as ExtensionAPI`.
- Isolation: `mkdtemp()` + set `process.env.PI_CODING_AGENT_DIR` **before** calling the extension factory (the factory captures the global root at call time); collect temp dirs and `rm` in `afterAll`.
- Drive handlers via `handlers.get("event")?.[0]?.(fakeEvent, fakeCtx)` and tools via `tools.get(name).execute(id, params, undefined, undefined, ctx)`.
- Mocks bypass TypeBox schema validation — validate params by hand in expectations; this gap has exposed real store-level bugs before.
- Lock concurrency behavior with `Promise.all` tests (e.g. 20 parallel saves must all persist).

## Verify

```bash
cd packages/coding-agent
node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/<name>-extension.test.ts
cd ../..
npx tsgo --noEmit            # ~828 pre-existing errors = missing model data, run: npm run hydrate:model-data
npm run check                # must be zero error/warning/info
```

Rules that apply while editing: no commit unless asked, no `npm run build`, no full vitest suite, changelog only under `[Unreleased]`.
