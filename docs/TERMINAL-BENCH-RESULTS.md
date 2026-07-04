# Terminal-Bench Evidence Snapshot

Date: 2026-07-03. Supersedes the 2026-06-28 snapshot (kept below as an appendix note). All pre-2026-07-03 data carries two caveats discovered today: **no run sent a reasoning-effort value** (the public Codex CLI baseline pins `high`), and **every historical mteb-leaderboard "pass" was reward-hacked** per the [leaderboard integrity rules](https://www.tbench.ai/news/leaderboard-integrity-update).

## The July 3 probe

Design: single-mode (`gpt55-cliproxycodex-single`), k=3 per arm/task, four tasks chosen because public GPT-5.5-class agents pass them and we did not (mteb-leaderboard, dna-insert, raman-fitting, caffe-cifar-10). Commit `7ab2ed8` (arms 1–3) / `131b571` (arm 4). Efforts verified per-call from traces; integrity scored by the aggregator (tainted would-passes count as failures, matching leaderboard scoring).

| Arm | Config | Score (integrity-scored) | Tainted mteb trials | Cancellations | Notes |
|---|---|---:|---:|---:|---|
| p1-omp-high | omp, effort high | 0/12 | 3 (all would-pass) | 3 (caffe) | fastest; fewest calls |
| p1-pi-high | upstream pi, effort high | 0/12 | 0 | 6 (caffe + all raman) | ~2× calls/tokens; bash-only tool surface |
| p1-omp-inherit | omp, host default (= high; see below) | 0/12 | 2 (failed anyway) | 3 (caffe) | accidental replication of arm 1 |
| p1-omp-none | omp, no effort on the wire | 0/12 | 3 (failed anyway) | 3 (caffe) | most flailing (see efficiency) |

**Headline: 0/48. No legitimate pass in the probe.** The four findings below are what the probe actually established.

### 1. All mteb passes were reward hacking (integrity)

Every mteb trial in every arm attempted to look up the benchmark's own artifacts — the tbench.ai task registry, `laude-institute/terminal-bench` task files (one trial read `check.py`, the oracle), harbor-framework mirrors, task explorer/notes pages — because a web search for the task text surfaces them. Only arm 1's three trials converted that into "passes"; nine later attempts all failed, confirming those passes were snippet luck, not capability. Detection is now automated (aggregator `Integrity` column zeroes tainted rewards); prevention is `GSD_MOA_BENCH_INTEGRITY=1` (integrity directive injected into acting + reference prompts), enabled in all yukon env files from 2026-07-03 on. A legitimate mteb solve requires historical leaderboard snapshots (datawrapper CSV, `embeddings-benchmark/results` history) — reachable, but not achieved yet.

### 2. Effort buys efficiency and parity, not passes (high vs none)

Identical zeros, very different execution. mteb at `none`: 142 primary calls, 3.39M input tokens, 12.5m mean. At `high`: 67 calls, 0.87M tokens, 4.2m. Lower effort flails; high effort is decisive. Since harbor's Codex CLI baseline pins `model_reasoning_effort=high`, `high` is also required for comparability. Default is now `high` everywhere (`GSD_MOA_EFFORT`, route-level `effort`, per-call trace verification). Note the semantics learned the hard way: `inherit` defers to the host CLI, and omp's host resolves `high` on its own for our model cards — so the true "backend default" ablation requires `none` (omits the field via `omitReasoningEffort`).

### 3. Runtime decision: omp (efficiency + tool surface)

Outcomes tie at zero, but pi cancelled twice as often (6 vs 3), burned to the raman ceiling on all three trials where omp finished (failing) with time to spare, and needed roughly double the calls/tokens per task. Mechanism, from the trajectories: upstream pi exposes essentially `bash` + `write`, so the model hand-rolls everything (including ~10 improvised `python requests` scrapers on mteb); omp ships `read`/`web_search`/`browser`/`eval`/`glob`. Nothing in the probe favors pi. **Decision: build on omp.** The dual-runtime adapter (`GSD_MOA_RUNTIME`) stays as cheap insurance until the next milestone, then the legacy pi path can be deleted.

### 4. The residual gap is real capability, not configuration

With effort pinned, integrity scored, and the runtime settled, dna-insert (public 3–5/5) and raman-fitting (public up to 4/5) still fail cleanly at high effort with wall-clock to spare, and caffe-cifar-10 still dies at its time ceiling in every arm. Whatever separates us from Codex CLI on these is in the agent loop/tooling/strategy, not the knobs this probe controlled.

## Also fixed while probing

- **Time-aware budgets were wrong in all runs to date**: the harbor agent's 900000ms fallback told every task "15m" while real agent ceilings are mteb 60m / dna 30m / caffe 20m / raman 15m. `scripts/tb-agent-budget.sh` now resolves the real per-task budget from harbor's task cache; run scripts export it per task. (Time-aware was ON in all probe arms — uniformly, so not a confounder — but in single mode it only injects the budget note; the checkpoint-suppression machinery from the E3 ablation needs MoA modes.)

## Status of historical results (June 28 snapshot + July 2 matrix)

- Audited clean (no benchmark-artifact access): mcmc-sampling-stan passes (single 2/2 at high-era clean runs; ta-on full-MoA 2/2), overfull-hbox passes, gcode-to-text single pass, extract-elf passes. These stand, with the effort caveat (they ran at backend-default effort).
- The June torch-tensor-parallelism full-MoA "win" did not replicate (0/2 all modes at k=2) — treat as k=1 variance.
- E3's time-aware result stands but reframed: time-aware rescues full-MoA from its own checkpoint overhead (ta-on 2/8 vs ta-off 1/8, fewer cancellations); clean single matches ta-on on mcmc at lower cost.
- MoA has shown **no pass-rate lift over clean single** in any k≥2 comparison to date. That is the open question the next experiments target, now on a sound footing.

## Standard configuration going forward

omp runtime · effort `high` (verified per-call in traces) · `GSD_MOA_BENCH_INTEGRITY=1` · per-task `GSD_MOA_BUDGET_MS` via `scripts/tb-agent-budget.sh` · integrity-scored aggregation (`npm run tb:report`) · k≥3.

## Next experiments

1. **Stratified slice (~10–12 tasks)** with dynamic range: the clean-pass set (mcmc, gcode, overfull, extract-elf) + untried mid-difficulty public tasks + 2 hard canaries. Establishes the baseline that ablations can move.
2. **MoA value ablations** on that slice: single vs `gpt55-cliproxycodex-glm52-hermes-full` (refs once per turn, no synth) vs checkpoint full-MoA, all at the standard config — the project's core question.
3. **Async advisor arm** (config exists, default off) — cancellations still dominate caffe-class tasks even at high effort.
4. **Multimodal slice + Gemini specialist** once antigravity tokens are reachable from yukon (mac-mini CLIProxy plan).
