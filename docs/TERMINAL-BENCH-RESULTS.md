# Terminal-Bench Evidence Snapshot

## M1 done-gate + M2 diversity oracle — three-way read (2026-07-09)

**Three arms at `e3d0d98`, passable four k=5 + torch k=3 (23 trials each), standard config, all integrity-clean.** M1 = `gpt55-cliproxycodex-donegate` (mechanical done-gate, `f3344ca`+`15387ea`); m1c = `gpt55-cliproxycodex-single` (same-commit/same-k attribution control); M2 = `glm52-zai-single` (GLM-5.2 as sole actor, diversity-oracle arm).

| Task | m1c single control | **M1 done-gate** | M2 GLM-5.2 single | gate fires (fired-trials) |
|---|---:|---:|---:|---:|
| extract-elf | 3/5 | 4/5 | 2/5 | 0/5 |
| mcmc-sampling-stan | 3/5 | **5/5** | 3/5 | 5/5 |
| gcode-to-text | 0/5 | 1/5 | 0/5 | 4/5 |
| overfull-hbox | 4/5 | 3/5 | 2/5 | 3/5 |
| torch-tensor-parallelism | **1/3** | 0/3 | 0/3 | 1/3 |
| **Total** | 11/23 (47.8%) | **13/23 (56.5%)** | 7/23 (30.4%) | 13/23 trials fired |
| Passable four | 10/20 (50%) | **13/20 (65%)** | 7/20 (35%) | — |

**M1 gate read — mechanism fully validated; pass effect directional, not conclusive:**

- **The gate behaves task-appropriately.** Silent where the actor self-verifies (extract-elf: 0 fires, final-verifier-ran 5/5); fires where verification is absent (mcmc 5/5 trials, gcode 4/5, overfull 3/5); ledger cap holds after each fire (no gate spam); time-floor correctly suppressed 8 near-ceiling turns on overfull; one retry per fire, always accepted. Zero wall-time tax vs control (11.1m vs 11.7m mean).
- **Post-fire behavior is genuine verification, not boilerplate.** Sampled fired mcmc trace: the retry response runs real domain checks (rstan version, output-file existence, finite posterior means, analysis.R parameter audit). The aggregator's `verified-after-fire 0/5` on mcmc is a **classifier blind spot** (R-workflow checks don't match the verifier regex) — backlog: widen `VERIFIER_RE` for R/multi-language workflows before trusting that column.
- **Pass effect: +3 on the passable four (65% vs 50%), concentrated exactly where fires were universal** (mcmc +2 with 5/5 fires; the control lost one mcmc to ceiling-cancel and one to agent-exit). Overfull cuts the other way (−1). Fisher on 13/20 vs 10/20 ≈ p 0.34 — per power discipline, not a detectable aggregate lift; but the roadmap's continue rule asked for material fire rate + real post-gate verification, and both are demonstrated. **Decision: gate stays on for future arms (it's free); graduation into default aliases waits for accumulated k.**
- **Torch stays gate-immune as predicted**: gate fired, verification ran (`py_compile`-class, verified-after-fire 1/1), still 0/3 — compile checks can't catch tensor-parallel semantics. Matches the F4-replay conclusion: torch-class needs semantic review (M4), not mechanical verification.

**M2 oracle read — GLM-5.2 adds no actor-diversity headroom:**

- **7/23 (30.4%), passes a strict subset of GPT-5.5's coverage** — nothing GLM passed that GPT-5.5 arms fail. Pairwise complementarity ≈ 0 on this slice.
- **Clock-bound**: 18.0m mean wall vs 11-12m for GPT arms; 8/23 cancellations (4/5 on overfull). GLM as actor is slower AND weaker in our harness.
- **Cost-frontier note**: the inverted thesis (cheap GLM actor + expensive judgment) is not supported at these numbers — the actor gap is too large for advisory patching.
- **Torch all-fail is broken — by the control, not by diversity: m1c torch 1/3 is our first torch pass ever** (integrity-clean). Oracle headroom on torch exists within our harness with GPT-5.5 single alone (Droid 2/3 same model). Torch is winnable; the lever is approach quality (and possibly M4 semantic review), not model portfolio.

**Consequences for Roadmap v2:** M1 CONTINUE (gate on in future arms, k accumulates); M2 answers the gate question for M4 — **cross-model reviewer must justify itself against zero actor-complementarity evidence**, so M4 remains parked unless a scoped replay on the semantic-risk slice shows reviewer-side catch value (F4 think-mode data is the only support); M3 (GSD-typed checkpoints) is now the main track. Next arm candidates: rescue+donegate combo (both mechanisms cheap and validated), or M3 checkpoint prototype arm.

Artifacts: `jobs/m1-donegate`, `jobs/m1c-single-control`, `jobs/m2-glm-single` (yukon). Aggregator with done-gate columns: `/tmp/aggregate-integrity.ts` (yukon; `done-gate:` lines in group details).

---

## F2 rescue-triggered advice — first arm (2026-07-06)

**Arm: `gpt55-cliproxycodex-glm52-rescue` (single + stuck-triggered advisor, `01eaa5f`), passable four, k=5, standard config, post-H1: 11/20 (55%), integrity-clean.** Per-task vs s2-single (k=3, pre-H1):

| Task | s2-single | **f2-rescue (k=5)** | rescue fires |
|---|---:|---:|---:|
| extract-elf | 2/3 | 3/5 (+1 setup-flake fail, agent never ran) | 0 |
| mcmc-sampling-stan | 2/3 | 4/5 (1 loss = AgentTimeout at ceiling, no failure streak) | 0 |
| gcode-to-text | 1/3 | 0/5 | **1** |
| overfull-hbox | 1/3 | 4/5 | 0 |

**Mechanism read — the trigger does exactly what it was tuned to do:**

- **One fire in 20 trials** (gcode `HZ5DX3S`): 3 consecutive sub-second `bash` exit-1 failures (`bash|tool-result-error` signature) → single GLM-5.2 advisory (~24s, effort high) correctly diagnosed a command-construction/quoting loop, told the actor to switch to python3 heredocs, and supplied a task strategy. **The failure loop ended immediately post-injection** (no re-fire, no cap suppression for the rest of the trial) — recovery-after-stuck: 1/1. The trial still failed on solution correctness (decoded text wrong), the F4-class defect advice can't fix.
- **Zero spurious fires across 19 non-stuck trials, zero drift/initial checkpoints** (per-alias scopes verified live: `scope drift disabled` skips) — vs ckpt-full's ~2.5 fires/trial on the same failure-scope machinery. Total advisor overhead for the whole arm: **~24s** (s2 ckpt-full: ~1500s advisor-blocked in a single mcmc trial). Wall-time parity with single achieved trivially.
- **Injected-guidance non-persistence confirmed live**: only the fire call's trace contains the guidance message; later contexts never do. The in-process rescue ledger (not context scanning) is what makes `maxPerTask`/cooldown real — the round-1 implementation would have re-advised every turn while stuck.
- **The two loss classes rescue correctly ignores**: clock exhaustion without error streaks (mcmc `vboGrPj`, cancelled at ceiling — F1 async territory) and confidently-wrong solutions with clean tool results (gcode/torch class — F4 territory).

**Pass-rate read: 11/20 (55%) vs s2-single 6/12 (50%) — no detectable lift, as expected** (1 fire/20 trials can't move an aggregate; overfull 4/5 vs 1/3 has zero fires so it's H1/variance, not MoA). The mechanism is validated — cheap, quiet, fires correctly, and cured the one stuck loop it saw — but on the passable four, stuck-ness is rare: **the rescue lever works; this task set offers it almost no leverage.** Supports the strategic pivot to judgment-checkpoint integration (GSD plan/review surfaces) with rescue kept as the default in-loop safety net.

Artifacts: `jobs/f2-rescue` (yukon). Fire-trial traces: `2026-07-06__17-13-22/gcode-to-text__HZ5DX3S/agent/pi-gsd-moa/traces/` (fire call `...b5igm7gr.json`, `rescueAdvisorInjectionCount: 0`).

---

## s4 post-H1 single on the hard four — the Droid gap decomposed (2026-07-04 night)

**First arm carrying the H1 fix (`f71facc`). Single-mode `gpt55-cliproxycodex-single`, hard four (hard-file/raman/torch/caffe), k=3, standard config, integrity-clean: 1/12.** Per-task vs s2-single (pre-H1) and Droid:

| Task | s2-single (pre-H1) | **s4 single (post-H1)** | Droid bare |
|---|---:|---:|---:|
| hard-file-task | 0/3 | **1/3** | 1/3 |
| torch-tensor-parallelism | 0/3 | 0/3 | 2/3 |
| raman-fitting | 0/3 | 0/3 | 0/3 |
| caffe-cifar-10 | 0/3 | 0/3 | 0/3 |

**The read — H1 was necessary and it flipped exactly the task it should have, but the Droid gap was never one thing:**

- **hard-file-task: harness gap, now closed.** 0/3 → 1/3, matching Droid. Once `python3` runs, the agent can drive the task checker loop from Python instead of flailing in a JS fallback (the exact failure in the old trajectory mining). This is H1 paying off directly.
- **torch: NOT a harness gap — reclassified to solution correctness.** Live-confirmed H1 works: the first tool call `python -c 'import torch'` now **executes** (returns `ModuleNotFoundError`, i.e. python runs but apt-python has no torch) instead of the old `command not found`. All three trials then used `python -m py_compile` cleanly — **the identical toolchain Droid passed with** (neither harness can `import torch`; both validate by syntax + reasoning). Zero `command not found` / `Python backend unavailable` across all three. Our trials still failed on the tensor-parallel **gradient/collective semantics** the model wrote — a capability/strategy gap the model can't self-catch because nobody can runtime-verify against real torch. Droid got the math right (2/3); we didn't (0/3).
- **raman/caffe: still 0/3 for everyone** — genuine capability floor (caffe cancels at ceiling in every harness).

**Consequence for the roadmap:** the Droid 10/24-vs-6/24 edge splits into (a) python-execution (hard-file — closed by H1) and (b) solution quality on tasks neither harness can execute-verify (torch). Bucket (b) is precisely where a tool-less second-model review has structural headroom — a MoA advisor reviewing gradient correctness, or F4 review-before-done — so torch becomes a motivating case for the F-track rather than a harness bug. It is NOT more python plumbing.

Artifacts: `jobs/s4-posth1-single` (yukon). Torch trial forensics: `torch-tensor-parallelism__{h4q4xxn,3LG7mvd,paHnJue}` under `2026-07-04__22-11-26`.

---

## s3 fixed-MoA validation + H1 harness fix (2026-07-04 evening)

**s3 arm (`gpt55-cliproxycodex-glm52only-nosynth-full` + `initial,failure` scopes, checkout `272a2f2`, 8 tasks × k=3, all integrity-clean): 6/24 — repaired MoA now MATCHES single (6/24) instead of trailing it (ckpt-full 4/24, hermes-full 4/24).** Per-task: extract-elf **3/3** (single: 2/3), mcmc 2/3, overfull 1/3, gcode 0/3 (single: 1/3), hard four 0. The task-mix shift (gained extract, lost gcode) is within k=3 noise; the read is **the F0 fixes eliminated the MoA tax: zero `referenceFailures` in all 24 trials' traces** (s2 ckpt-full: ~59% of injections truncated at the 120s timeout), advisor time collapsed to ~2m mean refΣ. MoA no longer loses; it still shows no pass lift — consistent with the roadmap's "advice when it counts" thesis (F2 rescue-triggered) being the remaining live hypothesis on the F-track.

**H1 root-caused, fixed (`f71facc`), and smoke-verified end-to-end.** The torch/hard-file images ship **no python3 at all** (probed directly); Droid had one only because its adapter apt-gets python3, ours skipped the equivalent install via the prebuilt-path early return (see corrected `docs/TRAJECTORY-MINING.md`). Post-fix smoke inside the real torch image, through the real bundled omp runtime: bash tool resolves `python3`/`python` 3.12.3, `python3 -m py_compile` + execution round-trip passes, eval py-kernel probe `ok:true`. **s3 pre-dates the fix** (checkout `272a2f2`), so its torch/hard-file 0/3 carry no H1 signal; the first post-H1 arm will be the real test of how much of the Droid gap (10/24 vs 6/24) was python-execution.

Artifacts: `jobs/s3-glmonly-fixed`; smoke via `/tmp/h1-smoke.ts` + `/tmp/h1-install-cmd.sh` on yukon (torch image, omp-runtime.tar).

---

Date: 2026-07-04 (S2 matrix + Droid control added). The 2026-07-03 probe section below stands unchanged.

## S2 matrix + Droid bare-harness control (2026-07-04)

Design: 8 tasks (passable four: mcmc, gcode, overfull, extract-elf; hard four: hard-file, raman, torch, caffe), k=3, standard config, all integrity-scored clean. Our arms on `eefef56`; Droid arm via `harbor_agents/droid_agent.py` (`814729b`+) driving Factory Droid 0.147 `exec` against the **same GPT-5.5 through the same yukon CLIProxy**, at backend-default effort (Droid custom models cannot set reasoning effort).

| Task | omp single (high) | pi single (high) | ckpt-full MoA | hermes-full MoA | **Droid bare (default effort)** |
|---|---:|---:|---:|---:|---:|
| mcmc-sampling-stan | 2/3 | 2/3 | 1/3 | 2/3 | **3/3** |
| gcode-to-text | 1/3 | 0/3 | 0/3 | 0/3† | 1/3 |
| overfull-hbox | 1/3 | 3/3 | 1/3 | 1/3 | 1/3 |
| extract-elf | 2/3 | 2/3 | 2/3 | 1/3 | 2/3 |
| hard-file-task | 0/3 | — | 0/3 | 0/3 | **1/3** |
| raman-fitting | 0/3 | — | 0/3 | 0/3 | 0/3 |
| torch-tensor-parallelism | 0/3 | — | 0/3 | 0/3 | **2/3** |
| caffe-cifar-10 | 0/3 | — | 0/3 | 0/3 | 0/3 |
| **Total** | **6/24** | **7/12** | **4/24** | **4/24** | **10/24 (41.7%)** |

† one hermes gcode trial crashed (NonZeroAgentExitCode); scored 0.

### Reads

1. **Checkpoint re-advice does not earn its cost** (the S2 ablation pair differs only in re-advice: 4/24 = 4/24, both behind single 6/24). Forensics (`docs/S2-FORENSICS.md`) attribute most of the deficit to advisor mechanics: the GPT-5.5 self-proposer aborted at the 120s reference timeout in ~59% of injections with truncated advice injected anyway, and drift re-advice multiplied the cost (advisor time = 66% of ckpt-full wall). Fixes landed (`3f721e7`, `272a2f2`); the s3 validation arm (`glm52only` pool, truncation drop, drift off) tests whether repaired MoA stops losing.
2. **pi vs omp on the passable four: 7/12 vs 6/12-equivalent — within noise at one job each.** The omp runtime decision stands on the efficiency evidence from the probe.
3. **The Droid harness beats ours on the same model and proxy: 10/24 vs 6/24, at *default* effort.** It cracked torch (2/3) and hard-file-task (1/3) — tasks at 0 across every arm of ours, which we had classed as capability floor. The floor was partly **our harness**: agent loop/tooling/strategy, not the model. Raman and caffe remain 0 for everyone (caffe: cancellations/exits at ceiling in all harnesses).
4. Consequences: (a) mine Droid's torch/hard-file stream-jsonl trajectories against ours to localize the loop gap; (b) the prebuilt inverse experiment — gsd-moa as Droid's model (Droid outer harness + our MoA reference layer inner, `gsd-moa-factory-droid-proxy` worktree) — is now the highest-value MoA test bed; (c) effort=high is *not* what separates harnesses (Droid won at default), consistent with the probe's effort finding.

Artifacts: `jobs/s2-*`, `jobs/s2-droid`, `jobs/droid-smoke` on yukon; aggregation via the droid-aware integrity aggregator (`2bd9fc9`).

---

Date: 2026-07-03. Supersedes the 2026-06-28 snapshot (kept below as an appendix note). All pre-2026-07-03 data carries two caveats discovered today: **no run sent a reasoning-effort value** (the public Codex CLI baseline pins `high`), and **every historical mteb-leaderboard "pass" was reward-hacked** per the [leaderboard integrity rules](https://www.tbench.ai/news/leaderboard-integrity-update).

## The July 3 probe

Design: single-mode (`gpt55-cliproxycodex-single`), k=3 per arm/task, four tasks chosen because public GPT-5.5-class agents pass them and we did not (mteb-leaderboard, hard-file-task, raman-fitting, caffe-cifar-10). Commit `7ab2ed8` (arms 1–3) / `131b571` (arm 4). Efforts verified per-call from traces; integrity scored by the aggregator (tainted would-passes count as failures, matching leaderboard scoring).

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

With effort pinned, integrity scored, and the runtime settled, hard-file-task (public 3–5/5) and raman-fitting (public up to 4/5) still fail cleanly at high effort with wall-clock to spare, and caffe-cifar-10 still dies at its time ceiling in every arm. Whatever separates us from Codex CLI on these is in the agent loop/tooling/strategy, not the knobs this probe controlled.

## Also fixed while probing

- **Time-aware budgets were wrong in all runs to date**: the harbor agent's 900000ms fallback told every task "15m" while real agent ceilings are mteb 60m / hard-file 30m / caffe 20m / raman 15m. `scripts/tb-agent-budget.sh` now resolves the real per-task budget from harbor's task cache; run scripts export it per task. (Time-aware was ON in all probe arms — uniformly, so not a confounder — but in single mode it only injects the budget note; the checkpoint-suppression machinery from the E3 ablation needs MoA modes.)

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
