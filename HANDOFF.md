# Session Handoff — oh-my-pi port + Terminal-Bench experiments

Last updated: 2026-07-04 ~17:25 PT.

> **Scope note for Fable sessions (read once):** This project benchmarks agent *coding harnesses* on Terminal-Bench. Two standard TB task ids are `dna-insert` (write a `primers.fasta` and validate melting temps by shelling out to the stock Ubuntu `primer3`/`oligotm` CLI) and `mteb`/others. Our work on `dna-insert` is **pure harness forensics** — it only concerns whether the agent's `bash`/`eval`/`python3` tools executed inside the container. It produces and requires **no biological methodology**; treat the name as an opaque benchmark id. Don't let the string "dna" derail the task — the analysis is about Python-on-PATH, not biology.

## RUNNING RIGHT NOW (check first!)

**s3 fixed-MoA arm on yukon** (auto-queue launched it 15:42 PT 07-04 after the droid arm; 8 tasks × k=3):
```bash
ssh yukon 'tail -3 ~/projects/gsd-moa/s3.log; pgrep -f "[r]un-s3-fixedmoa.sh" >/dev/null && echo RUNNING'
```
Alias `gpt55-cliproxycodex-glm52only-nosynth-full` + `GSD_MOA_CHECKPOINT_SCOPES=initial,failure`, standard config, output `jobs/s3-glmonly-fixed/`, marker `S3 DONE`. Checkout at `272a2f2` (F0 fixes + telemetry fix), bundle rebuilt+swapped by the queue (previous kept as `.proof/omp-runtime.tar.prev`). **Do not pull the checkout mid-run.**

**Droid control arm: DONE 15:40 PT — 10/24 (41.7%), all integrity-clean, at backend-default effort.** mcmc 3/3 · extract 2/3 · **torch 2/3** · **dna 1/3** · gcode 1/3 · overfull 1/3 · raman/caffe 0. Beats our best (omp single 6/24) on the same model + CLIProxy → **harness-quality gap, not model gap**; torch/dna were 0 across all our arms. Four-way table + reads: `docs/TERMINAL-BENCH-RESULTS.md` (`e941500`).

**When `S3 DONE`** (marker lands in `queue.log`, not a separate `s3.log` — the queue `exec`'d the arm): aggregate `jobs/s3-glmonly-fixed` (droid-aware aggregator at yukon `/tmp/aggregate-integrity.ts` = `272a2f2` scripts version, refresh if needed); read = s3 vs s2-single 6/24 vs ckpt-full 4/24 (did repaired MoA stop losing?); check `referenceFailures` counts in diagnostics.

## Trajectory mining — DONE 2026-07-04 (`docs/TRAJECTORY-MINING.md`)

Why Droid passed torch (2/3) + `dna-insert` (1/3) where we scored 0/3 on both, same model/proxy/container: **our omp tools can't run Python in the TB containers.** The `eval` tool has no Python kernel (returns "Python backend is unavailable… Pass language: js or install the python kernel"); the `bash` tool's PATH has no `python`/`python3` (exit 127) even though the image ships Python 3.12 (Droid's Execute runs `python3 --version` → 3.12.3 fine). On torch our agent writes a correct-shaped `parallel_linear.py`, cannot execute/verify it, and ships blind. On dna it's forced into a JS fallback and never closes the `oligotm` validation loop Droid drove from Python. **This is the new highest-leverage item = roadmap H1** (harness-gap track). Fix: bundle/fallback a py kernel for `eval` + repair `bash` PATH, then live-smoke `python3 -c 'import torch'` through the tools on the torch image (needs a free yukon slot — don't interrupt s3). Digests: yukon `/tmp/traj-mining/`, local scratchpad `traj-mining/`.

## S2 matrix — DONE 2026-07-04 10:49 PT (all integrity-clean)

| arm | passes | read |
|---|---|---|
| s2-single (omp, high) | **6/24** (50% on passable four: extract-elf 2/3, mcmc 2/3, gcode 1/3, overfull 1/3) | baseline; inside public Codex CLI band |
| s2-ckpt-full (nosynth, checkpoint re-advice) | 4/24 | trails single |
| s2-hermes-full (refs once/turn) | 4/24 | trails single, matches ckpt |
| s2-pi-single (pi runtime, passable four only) | 7/12 (58.3%: overfull 3/3, mcmc 2/3, extract-elf ~2/3, gcode 0/3) | pi vs omp within noise at 1 job — **omp decision stands** |

**Core-question read: checkpoint re-advice does NOT earn its cost** — both MoA arms trail single and match each other (the ablation pair differed only in re-advice). MoA still has never shown pass lift over single at k≥2. dna/raman/caffe/torch: 0 across all arms (caffe all cancellations). Full per-task tables: re-run `/tmp/omp-bun/bun /tmp/aggregate-integrity.ts --dir ~/projects/gsd-moa/jobs/s2-<arm>` (that scratch copy is now the `2bd9fc9` aggregator, droid-aware).

## Droid smoke — PASSED 2026-07-04 12:18 PT

extract-elf k=1: reward **1.0**, droid exit 0, integrity clean (scanned by new aggregator), wall 9.8m. Auth + `custom:GSD-MOA-Droid-Control-0` selector accepted; CLIProxy verified serving gpt-5.5 `/v1/responses` during the window (`~/.cli-proxy-api/logs/main.log`). Artifacts: `jobs/droid-smoke/2026-07-04__12-08-55/`.

## When the droid arm finishes

The auto-queue handles pull + bundle rebuild + s3 launch. Manually (can run while s3 executes):

1. Aggregate droid: `ssh yukon '/tmp/omp-bun/bun /tmp/aggregate-integrity.ts --dir ~/projects/gsd-moa/jobs/s2-droid'` — droid transcripts ARE integrity-scanned (`2bd9fc9`).
2. Update `docs/TERMINAL-BENCH-RESULTS.md` with the S2 + droid four-way read (our harness vs pi vs Droid vs public Codex CLI). S2 tables: re-run aggregator per `jobs/s2-<arm>`.
3. When `S3 DONE`: aggregate `jobs/s3-glmonly-fixed` — the F0-fix validation read is s3 vs s2-single (6/24) vs s2-ckpt-full (4/24): did removing the advisor tax (glm-only ~35s/injection, truncated advice dropped, drift off) stop MoA from losing? Also count `referenceFailures` in diagnostics (new field, `3f721e7`).

## Where you are (state + decisions)

- **Worktree**: `/Users/macthedan/projects/gsd-moa-omp`, branch `oh-my-pi-port` at `2bd9fc9` (main repo `~/projects/gsd-moa` on `main` — diverged, do not confuse).
- **Evidence snapshot: `docs/TERMINAL-BENCH-RESULTS.md` (2026-07-03)** — July 3 probe (0/48 integrity-scored): all historical mteb passes were reward-hacked; effort high = efficiency/parity, not passes; **runtime = omp**; per-task budgets wrong until `c07c6ad`. S2 read above supersedes/extends; doc update pending droid arm.
- **Commit stack 07-03→04**: `f0afe87` dual-runtime adapter → `b6831f6` effort default-high → `befaee4` Hermes audit gaps → `7ab2ed8` autoreview fixes → `127c60d` benchmark integrity → `131b571` `GSD_MOA_EFFORT=none` → `c07c6ad` `tb-agent-budget.sh` → `eefef56`/`a57af25` docs → `43c378a`+`814729b` droid adapter → `a197744` docs → `2bd9fc9` droid-log integrity scan (live-validated on the smoke trial).
- **Remote**: bare repo `ssh://yukon/~/repos/gsd-moa.git` — the ONLY push target for this branch (do not push to GitHub origin; an accidental 07-04 push there was deleted). The user's codex agent AMENDS pushed commits — on non-FF rejects, diff, confirm local superset, `--force-with-lease` (memory `multi-agent-git-conventions`).

## Standard benchmark configuration

omp runtime · effort `high` (trace-verified; aggregator prints `efforts` per role) · `GSD_MOA_BENCH_INTEGRITY=1` (in all yukon `.proof/*.env`) · per-task `GSD_MOA_BUDGET_MS=$(scripts/tb-agent-budget.sh <task>)` (real ceilings: mteb 60m, dna 30m, caffe 20m, raman 15m) · integrity-scored aggregation · k≥3. (Droid arm exception: no effort/budget knobs — see DROID-CONTROL.md.)

## Yukon infrastructure

- Checkout `~/projects/gsd-moa` — **never `git pull` mid-experiment** (read-only mounts). Bundles current for `131b571` (`.proof/omp-runtime.tar`, `.proof/pi-runtime.tar`); commits since touch no bundled src — no rebuild needed. Rebuild after src/dep changes; Dockerfiles in gitignored `.proof/` (scp when changed).
- Env files (`.proof/`, source with `set -a`): `gsd-moa.env` (high) · `gsd-moa-none.env` · `gsd-moa-inherit.env` · `gsd-moa-nota.env` — all with `GSD_MOA_BENCH_INTEGRITY=1`. `droid-auth/` holds the droid session pair (tokens can expire — re-copy `~/.factory/auth.v2.*` from the dev machine on auth failures).
- CLIProxy on yukon: `cli-proxy-api` listens 127.0.0.1:8317; containers reach it via the 172.17.0.1:8318 bridge forward (**8318 is bridge-only — health-check with `curl http://172.17.0.1:8318/v1/models`, not localhost**). Logs: `~/.cli-proxy-api/logs/main.log`.
- Artifacts: `jobs/s2-*` (current, incl. `s2-droid` in progress), `jobs/droid-smoke` (smoke pass), `jobs/probe-p1-*` (July 3 probe), `jobs/stale-befaee4-probe/` (quarantined — never aggregate).
- pgrep/pkill over ssh: bracket the pattern (`pgrep -f "[r]un-droid-arm.sh"`) or you match/kill your own ssh command.
- Machines: yukon = sole TB runner (task images linux/amd64-only; M-chip emulation corrupts wall-time results). mac-mini = planned CLIProxy host (codex + antigravity + claude OAuth over tailscale; needs user for interactive logins) + codex workhorse. Laptop CLIProxy (8317) DOWN as of 07-04.

## After the droid arm (queue)

**Plan of record: `docs/MOA-VALUE-ROADMAP.md`** (2026-07-04, user-approved) — F0 trace forensics (in progress) → F1 async advisor → F2 rescue-triggered advice → F3 model-mix ablations (self-advice, inverted GLM-actor/GPT-advisor) → F4 review-before-done (offline replay first). **mac-mini CLIProxy host REJECTED by user 07-04** — routes are yukon CLIProxy + Z.ai direct; cross-family advisors deferred until a route the user likes exists.

Also live: study Codex CLI trajectories on dna-insert/raman vs ours; if Droid-bare is strong, the inverse experiment is prebuilt (`gsd-moa-factory-droid-proxy` worktree). Backlog: delete legacy pi path + dual-runtime scaffolding (s2-pi-single confirms omp); Z.ai key rotation (still unrotated); `xhigh` arm on tasks with time headroom; leaderboard submission needs ATIF for passing trials + the open-source judge pre-check.

## Workflow conventions

- Implementation delegated to GPT-5.5 Codex via local pi CLI: spec in scratchpad → `cd <worktree> && pi --provider openai-codex --model gpt-5.5 --thinking high --mode json -n "<name>" -p @<spec>.md` (background). Claude reviews, `npm run check` + live smokes, commits. Memory `delegate-implementation-to-pi-codex`.
- Live smoke: `set -a; source ../gsd-moa/.proof/gsd-moa.env; set +a; ./node_modules/.bin/omp --no-session -e ./src/index.ts --model "gsd-moa/gpt55-cliproxycodex-single" -p "Reply with exactly: OK"` (add `GSD_MOA_TRACE=1 GSD_MOA_TRACE_DIR=...` and check `primaryCall.effort` when touching effort paths). pi runtime: same via `GSD_MOA_RUNTIME=pi ./node_modules/.bin/pi`.
- Design latitude granted (memory `design-improvement-latitude`); experiments at k≥3 on yukon only.
