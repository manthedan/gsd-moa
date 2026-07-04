# Session Handoff — oh-my-pi port + Terminal-Bench experiments

Last updated: 2026-07-04 ~12:45 PT.

## RUNNING RIGHT NOW (check first!)

**Droid bare-harness control arm on yukon** (started 2026-07-04 12:20 PT; 8 tasks × k=3, expect several hours):
```bash
ssh yukon 'tail -3 ~/projects/gsd-moa/s2-droid.log; pgrep -f "[r]un-droid-arm.sh" >/dev/null && echo RUNNING'
```
Script: yukon `~/projects/gsd-moa/run-droid-arm.sh` (untracked scratch, mirrors run-slice2.sh). Output `jobs/s2-droid/`. Agent `harbor_agents.droid_agent:DroidAgent` at checkout `a197744`. Droid runs at **backend-default effort** (custom models can't set reasoning effort) — bracket against s2-single (high) and the probe's none arm. Harbor task ceilings bound runtime; droid has no self-pacing budget knob.

**The yukon checkout is at `a197744` and MUST NOT be pulled until the droid arm finishes** (trials mount it read-only). Bare repo is at `2bd9fc9` (aggregator droid-log integrity scan) — pull after.

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

## When the droid arm finishes (in order)

1. Aggregate: `ssh yukon '/tmp/omp-bun/bun /tmp/aggregate-integrity.ts --dir ~/projects/gsd-moa/jobs/s2-droid'` — droid transcripts ARE integrity-scanned now (`2bd9fc9`: `agent/droid/output.stream-jsonl`, fallback `output.txt`).
2. `git pull --ff-only` the yukon checkout to `2bd9fc9`.
3. Update `docs/TERMINAL-BENCH-RESULTS.md` with the S2 + droid four-way read (our harness vs pi vs Droid vs public Codex CLI, model held constant via CLIProxy). S2 aggregate tables were snapshotted this session; re-run step 1 commands per arm if needed.
4. Then the post-S2 queue below.

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

1. **Async advisor arm** (`asyncAdvisor.enabled`, default off) — cancellations still dominate caffe-class tasks at high effort.
2. **Study Codex CLI trajectories** on dna-insert/raman (public passes) vs ours to localize the residual gap; if Droid-bare beats us there, mine its stream-jsonl the same way.
3. If Droid-bare is strong: inverse experiment prebuilt — `gsd-moa-factory-droid-proxy` worktree exposes gsd-moa as Droid's model (Droid outer harness + our MoA inner).
4. mac-mini CLIProxy migration (user OAuth) → Gemini/Claude reference arms + multimodal slice (LemonHarness-style perception tool).
5. Backlog: delete legacy pi path + dual-runtime scaffolding (s2-pi-single read confirms omp — capability parity shown); Z.ai key rotation (still unrotated); `xhigh` arm on tasks with time headroom; leaderboard submission needs ATIF for passing trials + the open-source judge pre-check.

## Workflow conventions

- Implementation delegated to GPT-5.5 Codex via local pi CLI: spec in scratchpad → `cd <worktree> && pi --provider openai-codex --model gpt-5.5 --thinking high --mode json -n "<name>" -p @<spec>.md` (background). Claude reviews, `npm run check` + live smokes, commits. Memory `delegate-implementation-to-pi-codex`.
- Live smoke: `set -a; source ../gsd-moa/.proof/gsd-moa.env; set +a; ./node_modules/.bin/omp --no-session -e ./src/index.ts --model "gsd-moa/gpt55-cliproxycodex-single" -p "Reply with exactly: OK"` (add `GSD_MOA_TRACE=1 GSD_MOA_TRACE_DIR=...` and check `primaryCall.effort` when touching effort paths). pi runtime: same via `GSD_MOA_RUNTIME=pi ./node_modules/.bin/pi`.
- Design latitude granted (memory `design-improvement-latitude`); experiments at k≥3 on yukon only.
