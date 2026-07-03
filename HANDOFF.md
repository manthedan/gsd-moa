# Session Handoff — oh-my-pi port + Terminal-Bench dev experiments

Last updated: 2026-07-02 ~23:30 PT. Previous session: full audit → fix cycle → oh-my-pi port → yukon experiment infrastructure → 36-trial dev matrix + reruns.

## Where you are

- **Worktree**: `/Users/macthedan/projects/gsd-moa-omp`, branch `oh-my-pi-port` (main repo: `~/projects/gsd-moa`, branch `main` — diverged, do not confuse). Other experiment worktrees exist (`gsd-moa-factory-droid-proxy`, etc.).
- **HEAD**: `db33555` — history (all reviewed, 80/80 tests, `npm run check` green):
  `ec1c1ba` audit fixes (fail-open refs, guidance-in-messages, periodic drift, `src/reference-call.ts`) → port to `@oh-my-pi/*` 16.3.2 via `src/pi-compat.ts` adapter → live omp smoke tests → `src/registry.ts` single-source alias registry → time-aware execution (`src/time.ts`, LemonHarness arXiv:2606.24311) + async advisor (default OFF) + **corrected GPT-5.5 codex limits 272K/128K (verified by live probe)** → `GSD_MOA_TIME_AWARE` env kill-switch → tar-layout + agent quoting fixes → pure-single policy fix (single aliases no longer fire failure checkpoints) → forensics aggregator.
- **Remote**: bare repo `ssh://yukon/~/repos/gsd-moa.git` (git remote `yukon`). The user's codex agent AMENDS pushed commits — on non-FF rejects, diff remote vs local, confirm local is a superset, then `--force-with-lease`. See memory `multi-agent-git-conventions`.

## RUNNING RIGHT NOW (check first!)

**Pure-single reruns on yukon**, started 23:11 PT, ~2.5–3h, detached:
```bash
ssh yukon 'tail -3 ~/projects/gsd-moa/reruns.log; pgrep -f run-reruns.sh >/dev/null && echo RUNNING'
```
Arms: `e1b-single` (mteb-leaderboard, dna-insert, mcmc-sampling-stan, raman-fitting, gcode-to-text, caffe-cifar-10) + `e2b-single` (torch-tensor-parallelism, overfull-hbox), k=2, on `db33555` (post policy-fix). Ends with `RERUNS DONE`.

## Yukon infrastructure (all working)

- Linux x64, 24 cores, Docker; harbor 0.16.0 via uv (`PATH="$HOME/.local/bin:$PATH"`).
- Checkout `~/projects/gsd-moa` — **never `git pull` there while an experiment is running** (trials mount it read-only).
- Model access: yukon's own CLIProxy (codex OAuth only) on `127.0.0.1:8317`; socat container `cliproxy-fwd` republishes it at `172.17.0.1:8318` for task containers. GLM goes direct to Z.ai. **No antigravity/claude tokens on yukon** — gemini/claude reference aliases need token copies or re-auth there.
- Env files (`~/projects/gsd-moa/.proof/`): `gsd-moa.env` (ZAI key, `GSD_MOA_PRIMARY_BASE_URL`/`GSD_MOA_CODEX_BASE_URL=http://172.17.0.1:8318/v1`, `GSD_MOA_TRACE=1`) and `gsd-moa-nota.env` (adds `GSD_MOA_TIME_AWARE=0`). Not `export`ed — source with `set -a`.
- Runtime bundle `~/projects/gsd-moa/.proof/omp-runtime.tar` — build after dep changes:
  `docker build -f .proof/omp-runtime.Dockerfile --target bundle --output type=tar,dest=.proof/omp-runtime.tar .`
  The Dockerfile is in gitignored `.proof/` — scp it when it changes. Archive MUST be rooted at top level (`.bun/`, `node_modules/`).
- Run recipes: see `run-matrix.sh` / `run-reruns.sh` on yukon (reruns script includes the image pre-pull pre-flight — keep that pattern; missing images previously caused 600s env-start voids).
- Zero-bandwidth reporting (laptop internet is volatile — avoid rsyncing jobs/):
  `ssh yukon '/tmp/omp-bun/bun ~/projects/gsd-moa/scripts/aggregate-tb-results.ts --dir ~/projects/gsd-moa/jobs'`

## Experiment results so far (dev mode, k=2 — directional only)

- **E3 time-aware ablation (the win)**: ta-on 2/8 pass, 5/8 cancelled vs ta-off 1/8, 8/8 cancelled. mcmc-sampling-stan: ta-on **2/2** (26.3m mean, 9 checkpoints) vs ta-off 1/2 (31.6m, 19 checkpoints). Time-aware suppression works.
- **E2 MoA lift**: no separation (torch 0/2 both modes — June's k=1 full-MoA torch win looks like variance; overfull 1/2 both).
- **E1 harness gap** (contaminated by the since-fixed single-alias failure-checkpoint bug; reruns will clean): 2/10 + 2 voids; first-ever local passes on gcode-to-text and mcmc.
- **Dominant failure mode**: cancellations at task time ceilings (22/34 trials) — motivates the async advisor.
- mteb-leaderboard "failures" were infra voids (image pull > 600s env-start limit) — image now cached; aggregator classifies voids separately.
- 0% reference cache hits is **intended** (see memory `moa-caching-philosophy-and-dev-mode`): cache hits = advisor saw nothing new. full_moa = dev mode for tuning `auto`.

## Next steps (in order)

1. When `RERUNS DONE`: run the aggregator on yukon, compare e1b/e2b (clean single) vs matrix arms vs June baselines vs public leaderboard (`docs/TERMINAL-BENCH-LEADERBOARD-COMPARISON.md`).
2. Rewrite `docs/TERMINAL-BENCH-RESULTS.md` as the new evidence snapshot (supersedes June table).
3. Decisions the data supports: make deadline/budget env plumbing standard for all runs (E3); prototype **async advisor** ablation next (`asyncAdvisor.enabled` config exists, default off — needs an experiment arm), since cancellations dominate even with time-aware on.
4. Raise k selectively on interesting deltas (mcmc, gcode, overfull) before believing them.
5. Backlog: dual-runtime decision (upstream pi vs omp — `pi-compat.ts` makes dual-target feasible); Z.ai key in `.proof/gsd-moa.env` still unrotated (flagged in audit); tool-time pairing yields 0.0 on some older artifacts (harmless, n/a-safe); model-limits fix for factory proxy route unverified (only codex route probed).

## Workflow conventions

- Implementation is delegated to GPT-5.5 Codex via local pi CLI: write a spec file in the scratchpad, then
  `cd <worktree> && pi --provider openai-codex --model gpt-5.5 --thinking high --mode json -n "<name>" -p @<spec>.md`
  (background). Claude reviews the diff, runs `npm run check` + a live omp smoke test, then commits. See memory `delegate-implementation-to-pi-codex`.
- Live omp smoke test:
  `set -a; source ../gsd-moa/.proof/gsd-moa.env; set +a; ./node_modules/.bin/omp --no-session -e ./src/index.ts --model "gsd-moa/gpt55-cliproxycodex-single" -p "Reply with exactly: OK"`
  (model flag must be the combined `gsd-moa/<alias>` form; Bun 1.3.14 required on the host).
- User grants latitude for larger design/arch improvements without asking (memory `design-improvement-latitude`); dev experiments run at k=2 on yukon, not the laptop.
