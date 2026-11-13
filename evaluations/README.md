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

No GitHub fork or deployment has been created; this is a local working branch. Avoid pushing to the existing `origin`, which points to the upstream repository.

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
