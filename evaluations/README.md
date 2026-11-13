# Repeatable memory evaluation: Dataverse 403

This is an **initial evaluator** on branch `feat/memory-learning-evaluation`, not a deployed memory rewrite. It builds on the `d6837ce` live-indexing fix. No real Dataverse requests or production memory writes occur.

## What happened in the historical incident

- Sep 30: `EntityDefinitions(LogicalName='incident')` returned HTTP `403` / `0x80040220`, missing `prvReadEntity`. Ordinary incident record GETs returned `200`. History explicitly said not to repeat denied metadata requests.
- Nov 11: ordinary contact record GETs returned `200` (an older contact-record blocker was resolved); contact attribute **metadata** continued returning `403`. The agent attempted metadata and got `403` again despite historical search being available.
- Gold lesson: distinguish **metadata vs record** permissions, use ordinary permitted reads, do not blindly retry metadata absent an authorized change, and supersede the stale contact-record error.

## Tests on master

```
npx --no-install tsx --test tests/evals/dataverse-403.test.ts
npx --no-install tsx evaluations/dataverse-403.ts
npx --no-install tsx evaluations/existing-dataverse-403.ts
npx --no-install tsx evaluations/dataverse-403.ts --learn
```

- `*.test.ts` checks the real Markdown memory store, SQLite sync, scoped retrieval, and removal of outdated entries with a temporary database.
- Default evaluator seeds **known-good** gold memories and measures 6 paraphrased retrievals, project isolation, and irrelevant matches. This tests retrieval, **not whether a model learns**.
- `existing-dataverse-403.ts` opens real `~/.pi/agent/pi-hermes-memory/sessions.db` in **SQLite read-only mode**. It prints only IDs and scoring flags, and does not increment usage-hit counters. It is an optional private baseline, not suitable for public CI.
- `--learn` makes two isolated `pi -p` calls with no tools and no saved session: first the existing direct-review prompt, then a proposed bounded extraction prompt. Both receive **September-only** history; November outcomes are held out, to avoid future leakage. It extracts added memories and replays them through the real SQLite search engine. It does **not** assert output quality or apply results to the real database. Treat unavailable providers and timeouts as **inconclusive**, not failed extraction accuracy.

## What a credible regression must prove

1. **Learning**: Given *only* the pre-incident observations, generate the correct metadata `403` restriction and allowed data-GET alternative, with provenance and no invented permission claims. Repeat at least 5 times.
2. **Updating**: Given the later `200` contact-record evidence, replace/supersede the old record-access failure but keep the metadata restriction. Repeat at least 5 times.
3. **Retrieval**: Paraphrase realistic future requests without giving away the exact error code. Measure recall@3, first-result precision and irrelevant-project leakage against the **full memory corpus**, not a tiny seeded index.
4. **Behavior**: Run an agent in a *fake* Dataverse environment exposing separate metadata/data GET tools. Verify it does not attempt metadata without changed permission, does use permitted record GETs, and can recover if permission actually changes. Compare the exact same task/model with no memory, original Hermes, and candidate fork. The historical failure makes a useful regression case, but avoid fitting only this one example.
5. **Cost**: Capture per-feature prompt/completion tokens, latency, number of tool calls, new memories, future validated reuse and avoided bad actions. Report mean and worst case. The earlier auto-review audit found potential 0.5M-character reviews, so cost must be first-class.

Use multiple task families to prevent 403-specific overfitting: wrong package manager, tests requiring scoped permission, project branch selection, upstream collaborator edits, and recovered app UI workflows. Keep learning data chronologically earlier than evaluation tasks, and **never leak the future answer into extraction input**.

## Implementation seam to evaluate next

The Pi extension SDK supports `before_agent_start` for supplying targeted prior context, `tool_call` for inspecting/blocking a risky tool call, and `tool_result` for receiving failure evidence. A low-cost design can use these to schedule bounded, incremental learning and action-time recall without a large LLM review each N turns. A previous 403 is a *conditional* warning, not a permanent block: authorized permission changes must permit new probes.

The public fork is [mistrjirka/pi-eigen-memory](https://github.com/mistrjirka/pi-eigen-memory), installed on `master`. Keep the upstream remote separate from the user fork.

## Lookup scaling and slow-lookup warnings

The Eigen fork reports a warning when a relevant recall takes at least `eigenRecallWarnMs` milliseconds (default `150`, set `0` to disable). It includes **full elapsed time**, **lazy-init time**, and **SQLite search/ranking time**. Notifications are rate-limited to one per five minutes per Pi session, and never contain searched text or saved facts. A failed lookup does not block the calling tool.

Benchmark the memory FTS5 search against temporary synthetic stores, without writing production memories:

```sh
npx tsx evaluations/benchmark-memory-scaling.ts
```

Measurements on `master` (Nov 13, 2026), median of 60 warm searches against synthetic text, all queries filtered to the same project:

| Memory entries | Exact 403 (rare) | PiTTy term (common) | PiTTy multi-term (common) | No match |
|---:|---:|---:|---:|---:|
| 2,500 | 1.7 ms | 1.0 ms | 2.9 ms | 0.07 ms |
| 10,000 | 3.4 ms | 3.4 ms | 9.4 ms | 0.06 ms |
| 40,000 | 8.6 ms | 14.8 ms | 37.5 ms | 0.06 ms |
| 100,000 | 16.6 ms | 45.6 ms | 105.8 ms | 0.07 ms |

The table above describes the previous exhaustive BM25 path. The new Eigen automatic path caps FTS matching candidates to 256 (newest by rowid) and includes 96 recent project entries as a fallback. Each entry's content is truncated at 1,600 characters for ranking, and at most three distinct tool-error recalls run per user turn. Manual `memory_search` retains exhaustive BM25 ranking. This improves speed at a recall-quality tradeoff: an older broad-match memory outside the shortlist may be missed.

Measured **end-to-end search plus Eigen's final hint ranking** with the implemented bounded path on the same test host (60 warm runs, temporary synthetic store):

| Memory entries | Legacy multi-term median | Bounded Eigen multi-term median | Bounded P95 | Legacy broad single-term | Bounded broad single-term |
|---:|---:|---:|---:|---:|---:|
| 2,500 | 1.30 ms | 1.36 ms | 1.92 ms | 0.42 ms | 0.36 ms |
| 10,000 | 4.25 ms | 1.39 ms | 2.50 ms | 1.44 ms | 0.36 ms |
| 40,000 | 18.18 ms | 1.49 ms | 2.00 ms | 6.62 ms | 0.38 ms |
| 100,000 | 51.34 ms | 1.60 ms | 2.18 ms | 24.46 ms | 0.40 ms |

Use `npx tsx evaluations/benchmark-memory-scaling.ts` to reproduce both implementations. Results exclude DB initialization, UI handling and concurrent I/O. They are not hard wall-clock limits. Synchronous SQLite execution cannot be interrupted by a JS `Promise.race()` timer on the same event loop. A strict deadline would require an isolated worker or a SQLite progress/interrupt mechanism. This fork uses bounded FTS candidate traversal instead.

Original session JSONL files are never deleted by recall. Index storage can still grow, especially with `sessionRetentionDays: 0` (the default, unlimited search history). Operators can set a retention window for the **searchable session index only**, but older sessions become absent from `session_search` until reindexed. The independent original JSONL files remain. Do not silently prune them, and do not treat a small recall candidate cap as a storage quota. Periodic duplication/supersession curation is a separate quality task.

## Eigen fork: actual Pi tool-result regression

Run these from the repository after dependencies are installed:

```sh
# Real SQLite search engine, read-only production index, warm hook timings
npx tsx evaluations/benchmark-eigen-recall.ts

# Real Pi agent calls an offline replay tool, learns with the configured model,
# then retrieves the memory in the next turn, using temporary memory storage
python evaluations/e2e-dataverse-tool-learning.py 3
```

The end-to-end replay uses the **recorded historical statuses** (ordinary incident/contact records HTTP 200, attribute metadata HTTP 403 missing `prvReadEntity`). It makes no Dataverse network requests and does not write to `~/.pi/agent/pi-hermes-memory`. Each trial creates a temporary Pi agent directory, reuses the operator's existing model authentication, and deletes the temporary directory. It does make paid or quota-limited requests to the configured learning model.

Measured on `master` on Nov 13 with `opencode-go/muse-spark-1.3-contributor`: **3/3** historical replay runs saved the correct scoped lesson and **3/3** recalled it correctly in the next turn. The learning calls took 4.4–8.4 seconds asynchronously, cost estimate $0.00021–$0.00024 each. When the tool instead explicitly said the error was **simulated** and that no real API request occurred, three runs returned **zero memory operations**. That is an observed difference, not proof of why the model chose to save nothing.

`eigen-learning-metrics.jsonl` now distinguishes an actual save from `empty`, `invalid_operations`, `filtered` and other results. It reports operation counts (`supplied`, `parsed`, `accepted`) without storing raw conversation text. A completed model request with `applied=0` is **not** counted as successful learning.

Warm recall callback measurements against the existing ~124 MiB SQLite index:

| Scenario | Median | P95 |
|---|---:|---:|
| Successful short tool result | 0.001 ms | 0.003 ms |
| Successful 8 MiB bash output | 0.371 ms | 0.431 ms |
| Unique relevant error | 12.77 ms | 13.90 ms |
| Repeated identical error | 0.01 ms | 0.017 ms |
| Relevant request prefetch | 5.27 ms | 5.56 ms |

A separate instrumented **real Pi RPC** run on a disposable copy of the same memory DB measured ~149 ms on the first relevant tool result (cold lazy initialization) and ~24 ms on the second result. These figures measure hook processing, not network or main model time. Learning is scheduled asynchronously after the agent turn; it can still consume shared model/provider resources while another request is running.
