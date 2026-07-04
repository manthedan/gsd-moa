# Session Handoff — oh-my-pi port + Terminal-Bench experiments

Last updated: 2026-07-04 ~01:00 PT.

## RUNNING RIGHT NOW (check first!)

**S2 matrix on yukon** (started 2026-07-03 19:53 PT; single arm took ~4.5h, MoA arms slower — expect `S2 DONE` early-to-mid afternoon 07-04):
```bash
ssh yukon 'tail -3 ~/projects/gsd-moa/s2.log; pgrep -f "[r]un-slice2.sh" >/dev/null && echo RUNNING'
```
Arms on `eefef56`, k=3, standard config: `s2-single` (DONE — results below) / `s2-ckpt-full` (nosynth, in progress) / `s2-hermes-full` / `s2-pi-single` (passable tasks only) × 8 tasks (mcmc, gcode, overfull, extract-elf, dna, raman, torch, caffe). The ckpt-vs-hermes pair differs ONLY in checkpoint re-advice (both no-synthesis) — this is the MoA core-question ablation. s2-pi-single is the capability check backing the omp decision (the probe's 0-0 tie had no discriminating power; this runs pi where passes actually happen).

**The yukon checkout is at `eefef56` and MUST NOT be pulled until `S2 DONE`** (trials mount it read-only). Local branch is 3 commits ahead (`a57af25` docs, `43c378a` + `814729b` droid adapter) — pushed to the bare repo, pull after S2.

## s2-single baseline (DONE, 2026-07-04 early AM — first fully clean numbers)

extract-elf **2/3** · mcmc **2/3** · gcode 1/3 · overfull 1/3 · dna/raman/torch 0/3 · caffe 0/3 (all cancellations) → 6/24 overall, **50% on the passable four**, all integrity-clean. We are now inside public Codex CLI's band on the passable set (mcmc 2/3 vs their 2/5). The hard residue is dna/raman/caffe/torch.

## When S2 finishes (in order)

1. Aggregate all four arms integrity-scored (`/tmp/aggregate-integrity.ts` on yukon, zero-bandwidth):
   `ssh yukon '/tmp/omp-bun/bun /tmp/aggregate-integrity.ts --dir ~/projects/gsd-moa/jobs/s2-<arm>'`
   Reads: (a) ckpt-full vs hermes-full vs single = does checkpoint re-advice earn its cost (the project's core question — MoA has never shown pass lift over single at k≥2); (b) s2-pi-single vs s2-single on the passable four = real capability footing for the omp decision.
2. `git pull --ff-only` the yukon checkout to `814729b`+ and **smoke the Droid adapter** (see Droid section).
3. Run the Droid control arm on the same 8 tasks (mirror `run-slice2.sh`; agent `harbor_agents.droid_agent:DroidAgent`; no gsd-moa env knobs apply except `PI_GSD_MOA_ENV_FILE` + `GSD_MOA_CODEX_BASE_URL`).
4. Update `docs/TERMINAL-BENCH-RESULTS.md` with the S2 + droid four-way read (our harness vs pi vs Droid vs public Codex CLI, model held constant via CLIProxy).

## Droid bare-harness control (ready, pending runner smoke)

- `harbor_agents/droid_agent.py` (`814729b`) + `docs/DROID-CONTROL.md`. Verified on the dev machine (droid 0.147.0): `droid exec -m custom:<id>` ACCEPTS custom selectors — issue #787 does not reproduce; invalid selectors still get `Invalid model`.
- Auth: the dev machine's working session pair (`auth.v2.file`/`auth.v2.key`) is on yukon at `.proof/droid-auth/` (mode 600); the run command copies it into container `~/.factory/`. No `FACTORY_API_KEY` needed (still supported via env file). **Tokens can expire — re-copy `~/.factory/auth.v2.*` from the dev machine on auth failures.**
- Custom model entry mirrors the dev machine's proven CLIProxy config: `provider: "openai"`, explicit `id: "custom:GSD-MOA-Droid-Control-0"` / `index: 0`, baseUrl `$GSD_MOA_CODEX_BASE_URL`.
- Effort caveat: droid custom models don't support reasoning-effort — the arm runs at backend default; bracket against `s2-single` (high) and the probe's `none` arm.
- Smoke on yukon: run one cheap task (e.g. extract-elf, k=1) with the droid agent, then check `/logs/agent/droid/stderr.txt` (auth + selector), `output.stream-jsonl` exists, and CLIProxy actually served the calls.

## Where you are (state + decisions)

- **Worktree**: `/Users/macthedan/projects/gsd-moa-omp`, branch `oh-my-pi-port` at `814729b` (main repo `~/projects/gsd-moa` on `main` — diverged, do not confuse).
- **Evidence snapshot: `docs/TERMINAL-BENCH-RESULTS.md` (2026-07-03)** — the July 3 probe (0/48 integrity-scored) and its findings: all historical mteb passes were reward-hacked; effort high = efficiency/parity, not passes; **runtime = omp**; per-task budgets were wrong until `c07c6ad`.
- **Commit stack 07-03→04** (each reviewed, live-smoked, `npm run check` green both runtimes): `f0afe87` dual-runtime adapter → `b6831f6` effort default-high (+`supportsReasoningEffort` compat, without which omp drops the field) → `befaee4` Hermes audit gaps (user-last ref views, failed-ref notes, `referenceMaxTokens`, route temperature, hermes-full alias; `docs/HERMES-DIVERGENCES.md`) → `7ab2ed8` autoreview fixes (pi CLI flags — pi arm was DOA without it; effort in cache keys) → `127c60d` benchmark integrity (aggregator zeroing + `GSD_MOA_BENCH_INTEGRITY` directive) → `131b571` `GSD_MOA_EFFORT=none` (true wire-omit; `inherit` defers to host which silently resolves high) → `c07c6ad` `tb-agent-budget.sh` → `eefef56`/`a57af25` docs → `43c378a`+`814729b` droid adapter.
- **Remote**: bare repo `ssh://yukon/~/repos/gsd-moa.git`. The user's codex agent AMENDS pushed commits — on non-FF rejects, diff, confirm local superset, `--force-with-lease` (memory `multi-agent-git-conventions`).

## Standard benchmark configuration

omp runtime · effort `high` (trace-verified; aggregator prints `efforts` per role) · `GSD_MOA_BENCH_INTEGRITY=1` (in all yukon `.proof/*.env`) · per-task `GSD_MOA_BUDGET_MS=$(scripts/tb-agent-budget.sh <task>)` (real ceilings: mteb 60m, dna 30m, caffe 20m, raman 15m) · integrity-scored aggregation · k≥3.

## Yukon infrastructure

- Checkout `~/projects/gsd-moa` — **never `git pull` mid-experiment** (read-only mounts). Bundles current for `131b571` (`.proof/omp-runtime.tar`, `.proof/pi-runtime.tar`); the droid commits touch no bundled src, so no rebuild needed for S2 follow-ups. Rebuild after src/dep changes; Dockerfiles in gitignored `.proof/` (scp when changed).
- Env files (`.proof/`, source with `set -a`): `gsd-moa.env` (high) · `gsd-moa-none.env` · `gsd-moa-inherit.env` · `gsd-moa-nota.env` (time-aware off) — all with `GSD_MOA_BENCH_INTEGRITY=1`. `droid-auth/` holds the droid session pair.
- Artifacts: `jobs/s2-*` (current), `jobs/probe-p1-*` (July 3 probe), `jobs/stale-befaee4-probe/` (quarantined — never aggregate).
- pgrep/pkill over ssh: bracket the pattern (`pgrep -f "[r]un-slice2.sh"`) or you match/kill your own ssh command.
- Machines: yukon = sole TB runner (task images linux/amd64-only; M-chip emulation corrupts wall-time results). mac-mini = planned CLIProxy host (codex + antigravity + claude OAuth over tailscale; needs user for interactive logins) + codex workhorse. Laptop CLIProxy (8317) is DOWN as of 07-04 — droid local runs need it or the yukon route.

## After S2 + droid (queue)

1. **Async advisor arm** (`asyncAdvisor.enabled`, default off) — cancellations still dominate caffe-class tasks at high effort.
2. **Study Codex CLI trajectories** on dna-insert/raman (public passes) vs ours to localize the residual gap; if Droid-bare beats us there, mine its stream-jsonl the same way.
3. If Droid-bare is strong: the inverse experiment is prebuilt — `gsd-moa-factory-droid-proxy` worktree exposes gsd-moa as Droid's model (Droid outer harness + our MoA inner) — tests whether the reference layer adds value inside a stronger harness.
4. mac-mini CLIProxy migration (user OAuth) → Gemini/Claude reference arms + multimodal slice (LemonHarness-style perception tool).
5. Backlog: delete legacy pi path + dual-runtime scaffolding after the s2-pi-single read confirms; extend aggregator integrity scan to droid log filenames; Z.ai key rotation (still unrotated); `xhigh` arm on tasks with time headroom; leaderboard submission needs ATIF for passing trials + the open-source judge pre-check.

## Workflow conventions

- Implementation delegated to GPT-5.5 Codex via local pi CLI: spec in scratchpad → `cd <worktree> && pi --provider openai-codex --model gpt-5.5 --thinking high --mode json -n "<name>" -p @<spec>.md` (background). Claude reviews, `npm run check` + live smokes, commits. Memory `delegate-implementation-to-pi-codex`.
- Live smoke: `set -a; source ../gsd-moa/.proof/gsd-moa.env; set +a; ./node_modules/.bin/omp --no-session -e ./src/index.ts --model "gsd-moa/gpt55-cliproxycodex-single" -p "Reply with exactly: OK"` (add `GSD_MOA_TRACE=1 GSD_MOA_TRACE_DIR=...` and check `primaryCall.effort` when touching effort paths). pi runtime: same via `GSD_MOA_RUNTIME=pi ./node_modules/.bin/pi`.
- Design latitude granted (memory `design-improvement-latitude`); experiments at k≥3 on yukon only.
