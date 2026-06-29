# Terminal-Bench Performance So Far

Date: 2026-06-28

This document summarizes local Harbor / Terminal-Bench 2.0 dogfood runs for `pi-gsd-moa`, comparing:

- `single`: `gsd-moa/gpt55-glm52-single` — direct GPT-5.5 through Factory proxy.
- `full_moa`: `gsd-moa/gpt55-glm52-full` — GLM-5.2 reference + GPT-5.5 reference + GPT-5.5 synthesis + GPT-5.5 final actor.

All runs used the Pi custom provider extension and were run as one trial per mode unless noted. Treat results as directional, not statistically final. See [`TERMINAL-BENCH-LEADERBOARD-COMPARISON.md`](TERMINAL-BENCH-LEADERBOARD-COMPARISON.md) for comparison against selected public leaderboard rows.

## Headline

The current Hermes-aligned full-MoA has clear wins on two known GPT-5.5 stress tasks:

- `torch-tensor-parallelism`: single failed, full-MoA passed.
- `overfull-hbox`: single failed, full-MoA passed.

It also preserves parity on `extract-elf`, where both passed. Many harder tasks still fail for both modes, often due to timeout or incomplete environment/task execution.

## Known-Failure Stress Suite

| Task | Single reward | Full-MoA reward | Outcome | Single runtime | Full runtime | Full refs | Full cache | Notes |
|---|---:|---:|---|---:|---:|---:|---:|---|
| `torch-tensor-parallelism` | 0.0 | 1.0 | MoA win | 13m04 | 14m33 | 15 | 12H/3M | ================== 13 passed, 1 warning in 229.30s (0:03:49) =================== |
| `caffe-cifar-10` | 0.0 | 0.0 | Both failed | 23m21 | 11m41 | 24 | 21H/3M | exceptions: single AgentTimeoutError:1; full NonZeroAgentExitCodeError:1 |
| `overfull-hbox` | 0.0 | 1.0 | MoA win | 13m50 | 8m25 | 39 | 36H/3M | ========================= 4 passed in 94.63s (0:01:34) ========================= |
| `install-windows-3-11` | 0.0 | 0.0 | Both failed | 14m39 | 15m23 | 51 | 48H/3M | =================== 1 failed, 3 passed in 167.43s (0:02:47) ==================== |
| `make-doom-for-mips` | 0.0 | 0.0 | Both failed | 15m43 | 18m22 | 102 | 99H/3M | exceptions: single 0; full AgentTimeoutError:1 |
| `gcode-to-text` | 0.0 | 0.0 | Both failed | 18m56 | 27m17 | 48 | 45H/3M | ========================= 1 failed, 1 passed in 0.28s ========================== |
| `mteb-leaderboard` | 0.0 | 0.0 | Both failed | 9m59 | 7m00 | 57 | 54H/3M | ========================= 1 failed, 1 passed in 0.24s ========================== |
| `raman-fitting` | 0.0 | 0.0 | Both failed | 9m19 | 17m19 | 54 | 51H/3M | exceptions: single 0; full AgentTimeoutError:1 |
| `extract-elf` | 1.0 | 1.0 | Parity pass | 6m11 | 8m23 | 12 | 9H/3M | ============================== 2 passed in 1.83s =============================== |
| `mcmc-sampling-stan` | 0.0 | 0.0 | Both failed | 44m43 | 53m31 | 57 | 54H/3M | exceptions: single AgentTimeoutError:1; full AgentTimeoutError:1 |
| `filter-js-from-html` | 0.0 | 0.0 | Both failed | 16m11 | 16m03 | 12 | 9H/3M | =================== 1 failed, 1 passed in 329.87s (0:05:29) ==================== |
| `dna-insert` | 0.0 | 0.0 | Both failed | 5m54 | 9m32 | 18 | 15H/3M | ============================== 1 failed in 0.42s =============================== |

## Prior Baseline / Smoke Runs

| Task | Single reward | Full-MoA reward | Notes |
|---|---:|---:|---|
| `fix-git` | 1.0 | 1.0 | Both passed; full-MoA slower but cache-heavy. |
| `fix-code-vulnerability` | 1.0 | 1.0 | Both passed; full-MoA used fewer assistant turns in the earlier run. |
| `configure-git-webserver` | 1.0 | 1.0 after Hermes/public-note refactor | Earlier full-MoA variants failed by advising instead of acting; current prompt/injection shape passed. |
| `torch-tensor-parallelism` | 0.0 | 1.0 | First strong non-multimodal MoA win. |

## Cache Behavior

Full-MoA reference-layer cache generally shows `3` misses on the first turn — GLM reference, GPT reference, synthesis — followed by hits on later tool-loop turns. This is expected because the cache key uses the sanitized reference context, stripping tool results and tool calls while preserving the high-level task.

Examples:

- `torch-tensor-parallelism`: 15 reference calls, 12 hits, 3 misses.
- `overfull-hbox`: 39 reference calls, 36 hits, 3 misses.

## Interpretation

Positive evidence:

1. Full-MoA can recover failures on reasoning-heavy implementation tasks where single GPT-5.5 misses a subtle invariant.
2. The Hermes-aligned prompting and public execution note fixed the earlier “advice instead of action” failure mode.
3. Cache keeps repeated tool-loop turns from multiplying reference-model spend linearly.

Limits / concerns:

1. Several tasks still fail for both modes; MoA is not a universal Terminal-Bench solver.
2. Some full-MoA failures are timeouts, suggesting extra reference latency can hurt long build/install tasks.
3. One trial per task is not enough for statistical claims. Repeat promising deltas with `k>=3` before claiming robust lift.
4. Reference caching currently ignores tool-result discoveries, which is efficient but may stale out on tasks requiring fresh post-tool analysis.

## Artifact Roots

Detailed local artifacts live under `.proof/harbor-jobs/`, including result JSON, verifier output, Pi event streams, and provider traces where available.
