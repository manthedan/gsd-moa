# Session Handoff — oh-my-pi port + Terminal-Bench experiments

Last updated: 2026-07-03 ~20:00 PT, session closeout. Nothing is running.

## Where you are

- **Worktree**: `/Users/macthedan/projects/gsd-moa-omp`, branch `oh-my-pi-port` (main repo `~/projects/gsd-moa` on `main` — diverged, do not confuse).
- **The evidence snapshot is `docs/TERMINAL-BENCH-RESULTS.md` (2026-07-03)** — read it before planning experiments. It records the July 3 probe (4 arms × 4 tasks × k=3, 0/48 integrity-scored) and the four findings: all mteb passes ever were reward-hacked; effort high = efficiency/parity not passes; **runtime decision = omp** (pi is 2× cost for identical zeros, bash-only tool surface); residual capability gap on dna/raman/caffe is real and unexplained by knobs.
- **Commit stack today** (all reviewed, live-smoked, `npm run check` green both runtimes at every step): `f0afe87` dual-runtime adapter → `b6831f6` effort config default-high (+compat `supportsReasoningEffort`, without which omp drops the field) → `befaee4` Hermes audit gaps (user-last ref views, failed-ref notes, `referenceMaxTokens`, route temperature, `gpt55-cliproxycodex-glm52-hermes-full` ablation alias; `docs/HERMES-DIVERGENCES.md`) → `7ab2ed8` user-autoreview fixes (pi CLI flags, effort in cache keys) → `127c60d` benchmark-integrity detection+prevention → `131b571` `GSD_MOA_EFFORT=none` (true omit; `inherit` defers to host which silently resolves high) → `c07c6ad` `scripts/tb-agent-budget.sh` → this closeout.
- **Remote**: bare repo `ssh://yukon/~/repos/gsd-moa.git`. The user's codex agent AMENDS pushed commits — on non-FF rejects, diff, confirm local superset, `--force-with-lease` (memory `multi-agent-git-conventions`).

## Standard benchmark configuration (from now on)

omp runtime · effort `high` (trace-verified per call; aggregator prints `efforts` per role) · `GSD_MOA_BENCH_INTEGRITY=1` (set in all yukon `.proof/*.env`) · per-task `GSD_MOA_BUDGET_MS=$(scripts/tb-agent-budget.sh <task>)` in run scripts (real ceilings: mteb 60m, dna 30m, caffe 20m, raman 15m — the old 15m fallback was wrong for 3 of 4) · integrity-scored aggregation (`/tmp/aggregate-integrity.ts` copy on yukon or `npm run tb:report`) · k≥3.

## Yukon infrastructure

- Checkout `~/projects/gsd-moa` at `131b571`+ — **never `git pull` mid-experiment** (read-only mounts). Bundles current for `131b571`: `.proof/omp-runtime.tar`, `.proof/pi-runtime.tar` (pi bundle kept until the dual-runtime scaffolding is deleted). Rebuild after dep changes; Dockerfiles in gitignored `.proof/` (scp when changed).
- Env files (`.proof/`): `gsd-moa.env` (high), `gsd-moa-none.env`, `gsd-moa-inherit.env`, `gsd-moa-nota.env` (time-aware off) — all now have `GSD_MOA_BENCH_INTEGRITY=1`. Source with `set -a`.
- Probe artifacts: `jobs/probe-p1-*` (4 arms); aborted first attempt quarantined in `jobs/stale-befaee4-probe/` (do not aggregate).
- pgrep/pkill over ssh: bracket the pattern (`pgrep -f "[r]un-probe.sh"`) or you match/kill your own ssh command.
- Machines: yukon = sole TB runner (task images are linux/amd64-only; emulation on the M-chip mac-mini corrupts wall-time results). mac-mini = planned CLIProxy host (codex + antigravity + claude OAuth over tailscale — unblocks Gemini/Claude arms; needs user for interactive logins) + codex workhorse. See memory `experiment-infrastructure`.

## Next steps (in order)

1. **Stratified TB slice (~10–12 tasks)** at the standard config: clean-pass set (mcmc-sampling-stan, gcode-to-text, overfull-hbox, extract-elf) + untried mid-difficulty public tasks + 2 hard canaries. Baseline with dynamic range. Use `run-probe.sh`/`run-none-arm.sh` on yukon as templates; add the per-task budget export.
2. **MoA value ablations** on that slice: single vs hermes-full (`gpt55-cliproxycodex-glm52-hermes-full`) vs checkpoint full-MoA. The project's core question — MoA has shown no pass-rate lift over clean single in any k≥2 comparison yet.
3. **Async advisor arm** (`asyncAdvisor.enabled`, default off) — cancellations still dominate caffe-class tasks at high effort.
4. **Study Codex CLI trajectories** on dna-insert/raman (public passes) vs ours to localize the residual harness gap.
5. mac-mini CLIProxy migration (user OAuth needed) → unblocks Gemini specialist + multimodal slice (LemonHarness-style perception tool — see backlog in results doc).
6. Backlog: delete legacy pi path + dual-runtime scaffolding after next milestone; Z.ai key rotation (still unrotated); `xhigh` arm on tasks with time headroom; leaderboard-grade submission needs ATIF trajectories (we produce ATIF-v1.7) + the open-source judge pre-check.

## Workflow conventions

- Implementation delegated to GPT-5.5 Codex via local pi CLI: spec file in scratchpad → `cd <worktree> && pi --provider openai-codex --model gpt-5.5 --thinking high --mode json -n "<name>" -p @<spec>.md` (background). Claude reviews, runs `npm run check` + live smokes, commits. Memory `delegate-implementation-to-pi-codex`.
- Live smoke: `set -a; source ../gsd-moa/.proof/gsd-moa.env; set +a; ./node_modules/.bin/omp --no-session -e ./src/index.ts --model "gsd-moa/gpt55-cliproxycodex-single" -p "Reply with exactly: OK"` (add `GSD_MOA_TRACE=1 GSD_MOA_TRACE_DIR=...` and check `primaryCall.effort` when touching effort paths). pi-runtime smoke: same with `GSD_MOA_RUNTIME=pi ./node_modules/.bin/pi`.
- Design latitude granted (memory `design-improvement-latitude`); experiments at k≥3 on yukon only.
