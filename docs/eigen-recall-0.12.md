# Task-aware recall in Eigen Memory 0.12

## Install and release

Use `pi install git:github.com/mistrjirka/pi-eigen-memory`. The Eigen fork releases versioned Git tags and GitHub Releases. The package name stays `pi-hermes-memory` for existing Pi installation compatibility. Do not use the upstream npm release workflow for this fork.

Upgrade the Git package and reload the Pi extension or start a new session. An already-running process retains its loaded code and configuration. Existing user settings are preserved.

## What reaches the model

Automatic recall searches the exact current project. It extracts terms across the task, ignores launch boilerplate and directory prefixes, preserves identifiers such as K4 and error codes such as 403, then ranks bounded candidates deterministically. There is no additional model request for retrieval or diagnostics.

Matches need a specific identifier/error or multiple meaningful subject terms. Unrelated notes are omitted. Explicit branch and task applicability restrict matching notes without isolating shared project knowledge. A host-only task omits unrelated reboot, recovery and native-build history. These filters assist relevance; they do not replace the current assignment's constraints.

Notes are labeled as historical evidence. Recorded decisions and permissions remain applicable within their original scope and current explicit instructions. Recalled notes do not expand the assignment or require renewed approval for already authorized work. Each note includes a version marker, date, origin and an ID when available. The version marker prevents repeat injection while the note remains in current context. If compaction drops it, it can be retrieved again. A summary retaining the marker retains the deduplication boundary.

Each injection is at most 1,200 characters and three notes. Prompt recall and up to three distinct failed-tool retrieval attempts share a default 2,400-character budget per user request. Repeated errors do not trigger repeated lookups in that request. Failed lookups do not block the task.

## Controls

Controls are optional additions to `hermes-memory-config.json`. Existing enable flags retain their meaning. No setting is changed by upgrading.

| Setting | Default | Effect |
| --- | --- | --- |
| `eigenRecallEnabled` | Existing opt-in | Enables automatic recall |
| `eigenRecallMainEnabled` | `true` when recall enabled | Automatic recall in main sessions |
| `eigenRecallChildEnabled` | `true` when recall enabled | Automatic recall in normal subagents |
| `eigenRecallBudgetChars` | `2400` | Combined request budget, maximum 12000; 0 prevents injection |
| `eigenLearningEnabled` and `reviewEnabled` | Existing settings | Automatic durable learning |
| `eigenLearningMainEnabled` | `true` when learning enabled | Learning in main sessions |
| `eigenLearningChildEnabled` | `true` when learning enabled | Learning from subagent observations |
| `memorySearchEnabled` | `true` | Registers manual `memory_search` and `memory_read` |

`memoryMode: "policy-only"` controls frozen system-prompt blocks; it does not disable automatic recall. Normal children are identified by `PI_SUBAGENT_AGENT_ID` / `PI_SUBAGENT_PROFILE`. Memory-maintenance subprocesses use a separate identity and do not recursively recall or learn. `PI_EIGEN_RECALL_OFF=1` provides a process-level opt-out.

Use `/memory-recall off` or `/memory-recall on` to control automatic recall in the current session. Configuration and role restrictions still apply. `/memory-recall diagnose <task>` performs a read-only selection and displays terms, project, role, selected IDs/scores, exclusion reasons, output characters and remaining budget. It injects nothing and does not consume the request budget. These are character measurements, not token measurements.

## Manual tools

`memory_search` requires a nonempty query. Omitting `project` searches the current project, or global notes outside a project. Set `project: null` for global notes, an exact project name for another project, or `scope: "all"` for an explicit cross-project search. Do not combine `project` and `scope`.

The default is 10 results, 400 characters per excerpt, and 6,000 output characters. Maximums are 20 results, 1,200 characters per excerpt, and 12,000 output characters. Invalid or negative limits are rejected. Search results identify their scope, mutation target and ID. A search hit records exposure, not verified usefulness.

`memory_read` reads an exact result ID. Default output is 8,000 characters, maximum 20,000. The first lines include available provenance and source anchors. Follow `next_offset` until it is null to retrieve the entire entry. Reading does not verify a fact or authorize an action.

`memory_add` and `memory_replace` accept optional `evidence` and `branch` fields. Add evidence only for durable observations. A branch should be specified only when the fact is branch-specific. Temporary assignments and task permissions do not become standing user preferences.

## Provenance and corrections

Optional provenance stores origin, source anchors, observation date, applicability and exact superseded fingerprints. Model writes are labeled `observation` or `delegated`; a message with role `user` is not proof that a human authored it. `direct-user` is reserved for explicitly imported user-authored evidence. User-pinned standing instructions remain in their separate store, which automated learning cannot write.

Learning ignores delegated task text as a source of user corrections/preferences. Verified tool observations can still produce shared project knowledge. The learner remains bounded, asynchronous, and limited to one short add operation. It may mark a listed existing candidate superseded only by its supplied exact fingerprint. Old records are retained for inspection; automatic recall omits superseded candidates. Recency alone does not establish contradiction or supersession.

Explicit replacement records the old content fingerprint and new observation date. Provenance survives Markdown saves, reloads, and rebuilding the SQLite mirror. New optional `evidence64` Markdown metadata and a nullable `evidence_json` SQLite column are additive. Existing records retain their content and dates and appear with legacy/unknown origin. Optional provenance does not consume an existing note capacity budget. No bulk reclassification or cleanup is performed. Keep the existing memory backups when downgrading to a reader predating this metadata.

## Validation and limits

The regression suite exercises `setupEigenRecall` itself, including launch/path noise, K4/403, negative relevance cases, project/branch/task isolation, current-context duplicates, compaction, supersession, opt-outs, budgets, migration and paginated reads. Existing manual-search evaluations remain useful but do not measure automatic recall by themselves.

A deterministic fixture is not evidence of a typical real-world success rate. Relevance still depends on the saved facts and vocabulary. Legacy notes may lack source or applicability. Candidate retrieval and returned text are bounded, but disk initialization or SQLite traversal can still exceed the configured warning threshold. Measure actual provider tokens when available; do not relabel character counts as tokens.
