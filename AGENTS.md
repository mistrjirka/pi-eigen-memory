# Pi Hermes Memory Extension

## Project Overview

This is a Pi coding agent extension that brings Hermes-style persistent memory and a learning loop to any Pi user. After `pi install`, users get persistent memory across sessions, a background learning loop, and session-end flush.

This fork is based on upstream v0.11.0 and adds bounded event-driven learning, just-in-time recall and Dataverse memory regressions. The old roadmap files describe upstream history, not the current implementation.

## Architecture

- **Language**: TypeScript (loaded via jiti, no compilation needed at runtime)
- **Runtime**: Pi extension API (`@earendil-works/pi-coding-agent`)
- **Storage**: Markdown `MEMORY.md`, `USER.md`, `failures.md` plus SQLite FTS session/memory indexes under `~/.pi/agent/pi-hermes-memory/`; project memories under `~/.pi/agent/projects-memory/`
- **Entry point**: `src/index.ts` — registers tools, event handlers, and commands

## Key Files

| File | Purpose |
|---|---
| `src/index.ts` | Extension entry point — wires all components together |
| `src/types.ts` | Shared TypeScript interfaces + `getMessageText()` helper |
| `src/constants.ts` | Prompts, defaults, delimiter |
| `src/store/memory-store.ts` | Core `MemoryStore` class — CRUD, persistence, frozen snapshot |
| `src/store/content-scanner.ts` | `scanContent()` — injection/exfiltration detection |
| `src/tools/memory-tool.ts` | `registerMemoryTool()` — LLM tool definition |
| `src/handlers/background-review.ts` | `setupBackgroundReview()` — learning loop via `pi.exec` |
| `src/handlers/session-flush.ts` | `setupSessionFlush()` — pre-compaction/shutdown flush |
| `src/handlers/insights.ts` | `registerInsightsCommand()` — `/memory-insights` command |
| `PLAN.md` | Full v0.1 implementation plan with Hermes source file reference map |
| `docs/ROADMAP.md` | Full roadmap with Hermes competitive analysis + gap analysis |
| `docs/0.2/TASKS.md` | v0.2 task breakdown — Skills + Smart Curation |
| `.github/workflows/publish.yml` | Release gate → npm publish (OIDC trusted publishing) → GitHub Release |
| `.github/workflows/release.yml` | One-dispatch release: bump, promote changelog, tag, publish |

## Design Decisions

1. **Frozen snapshot** — Memory is injected into system prompt once at session start, never mutated mid-session (preserves Pi's prompt caching)
2. **Atomic writes** — Temp file + `fs.rename()` for crash safety
3. **Event-driven learning** — When `eigenLearningEnabled=true`, inspect relevant recent events only and use one bounded, asynchronous direct LLM call. Periodic review remains a legacy opt-out path.
4. **`§` delimiter** — Same as Hermes for consistency
5. **SQLite FTS** — Session history and memories are searched by SQLite. Live indexing uses the already-loaded `SessionManager`, not a full JSONL reparse.

## Hermes Source Reference

The implementation is ported from the Hermes agent harness. See `PLAN.md` → "Hermes Source File Reference Map" for exact files and line ranges to read.

## Roadmap & Task Tracking

- **Roadmap**: `docs/ROADMAP.md` — full roadmap with Hermes competitive analysis, gap analysis, and phased plan (v0.1 → v0.5 → v1.0)
- **v0.1 tasks** (complete): `docs/0.1/TASKS.md`
- **v0.2 tasks** (current): `docs/0.2/TASKS.md` — Skills, auto-consolidation, correction detection, tool-call-aware nudge

**Workflow:**
1. Pick a task from `docs/0.2/TASKS.md`
2. Mark it `[~]` (in progress)
3. Implement it
4. Mark it `[x]` (done) with the commit hash
5. Move to the next task

**Before implementation**, inspect the current `src/`, current tests and fork-specific changes. Legacy roadmap documents may be outdated.

## Development

```bash
# Type check
npm run check
npm test
npx tsx --test tests/handlers/eigen-learning.test.ts tests/handlers/eigen-recall.test.ts tests/evals/dataverse-403.test.ts

# Test locally
pi -e ./src/index.ts
```

## Releasing

Releases are automated — do not `npm publish` by hand. **Actions → Prepare release → Run workflow** bumps `package.json`, promotes the CHANGELOG's `[Unreleased]` section, commits to `main`, pushes the tag, and runs the publish pipeline (gate → npm via OIDC trusted publishing → GitHub Release). Full details, recovery paths, and the npm trusted-publisher setup: `docs/PUBLISHING.md`.

## Installation (for users)

```bash
pi install npm:pi-hermes-memory

# or from git
pi install git:github.com/chandra447/pi-hermes-memory
```
