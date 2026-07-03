# Session Handoff — oh-my-pi port + Terminal-Bench dev experiments

Last updated: 2026-07-03 (day session). Previous: audit → omp port → yukon infra → 36-trial matrix + reruns. This session: rerun analysis → **effort-level discovery** → dual-runtime adapter landed → effort-config codex task launched → Hermes MoA audit.

## Where you are

- **Worktree**: `/Users/macthedan/projects/gsd-moa-omp`, branch `oh-my-pi-port` (main repo: `~/projects/gsd-moa`, branch `main` — diverged, do not confuse). Other experiment worktrees exist (`gsd-moa-factory-droid-proxy`, etc.).
- **HEAD**: `f0afe87` **dual-runtime adapter** — same commit runs on omp AND upstream pi (`GSD_MOA_RUNTIME=pi|omp` or Bun auto-detect; `@earendil-works/*` optional peers; harbor agent `PI_GSD_MOA_CLI=pi`; 87/87 tests both runtimes; live smokes pass on both, incl. pi full-MoA with GLM ref). Prior history at `db33555`: audit fixes → omp port → registry → time-aware (LemonHarness arXiv:2606.24311) + async advisor (default OFF) + corrected GPT-5.5 codex limits 272K/128K → `GSD_MOA_TIME_AWARE` kill-switch → pure-single policy fix → forensics aggregator.
- **Remote**: bare repo `ssh://yukon/~/repos/gsd-moa.git` (git remote `yukon`). The user's codex agent AMENDS pushed commits — on non-FF rejects, diff remote vs local, confirm local is a superset, then `--force-with-lease`. See memory `multi-agent-git-conventions`. **f0afe87 not yet pushed to yukon.**

## RUNNING RIGHT NOW (check first!)

**Codex task `effort-config`** (local pi CLI, background) implementing configurable reasoning effort, spec at scratchpad `effort-config-spec.md`. When done: review diff, `npm run check`, live smokes (omp + pi), commit.

## THE EFFORT DISCOVERY (2026-07-03 — biggest confounder found so far)

**All our TB runs sent NO reasoning_effort.** Chain: run scripts never set `PI_GSD_MOA_THINKING_LEVEL` → harbor agent passes no `--thinking` → `omp --no-session` fresh container has no default → `options.reasoning` undefined → serializer omits the field → backend default (likely medium) applied. Traces confirm: zero effort keys. **Meanwhile harbor's codex agent hard-defaults `model_reasoning_effort=high`** — so the public Codex CLI leaderboard numbers are at HIGH. Every leaderboard comparison we made is effort-confounded; the "public agents pass, we fail" cluster (mteb, dna-insert, raman, caffe) may be an effort gap, not a harness gap. LemonHarness paper doesn't disclose effort. `xhigh` exists for GPT-5.5-codex.

User decision: GPT **and** GLM run at high; effort configurable; default high; benchmarks pinned high. → the running `effort-config` codex task (route-level `effort`, `GSD_MOA_EFFORT` env, default high, precedence route > host --thinking > env > default, effort recorded in traces + aggregator, harbor agent defaults `--thinking high`). After it lands: set `GSD_MOA_EFFORT=high` in yukon `.proof/*.env` too.

## Rerun results (e1b/e2b clean-single, k=2 — aggregated 2026-07-03)

- **The single-alias checkpoint bug cost TIME, not passes**: clean single ≈ half the wall time (dna 3.9m vs 13.5m, torch 9.8m vs 19.6m), 2/16 cancellations vs 22/34 in MoA arms.
- **mcmc**: clean single 2/2 @ 20.5m — matches ta-on full-MoA 2/2 @ 26.3m, cheaper. E3's "win" = time-aware rescues MoA from its own overhead, NOT MoA+ta > single.
- **MoA shows zero pass-rate lift over clean single at k=2 anywhere.** June torch full-MoA win looks like k=1 variance (torch now 0/2 all modes; e2b no cancellations — genuinely hard).
- gcode 1/2 → 0/2 (variance); mteb now runs (image cached) but fails 0/2 on merit.

## Planned: pi-vs-omp probe (falsification test of the omp choice)

Single-mode only, 4 tasks where public GPT-5.5 agents pass but we fail (mteb-leaderboard, dna-insert, raman-fitting, caffe-cifar-10), pi vs omp, same commit/route, k=3, **effort pinned high both arms** + a third omp-at-default-effort arm to isolate the effort effect. ~1 overnight. Needs: pi-runtime bundle for yukon (Node-based `pi-runtime.tar`, mirror omp bundle pattern; Dockerfile target in gitignored `.proof/` — scp it), run-probe.sh. If pi ≈ omp → commit to omp, delete legacy path. Don't run full-matrix runtime A/B — waste.

## Hermes MoA audit (2026-07-03, vs moa_loop.py @2c9b017)

Match: single-writer tools, advisory system prompt (ported verbatim-ish), sanitized text-only reference view, parallel fan-out, fail-open, recursion guards, tail injection. Deliberate divergences (keep): checkpoint-driven re-advice with tool observations (Hermes runs refs ONCE per user turn, never sees tool results), separate synthesis layer, conditional portfolio, secret redaction, untrusted-guidance directive. **Gaps worth fixing (user not yet asked→asked, pending decision)**: (1) no trailing-assistant strip in `sanitizeReferenceContext` — Anthropic-style refs can 400 on prefill (matters for parked Claude alias); (2) failed references vanish silently from actor's view (Hermes injects `[failed: …]` notes); (3) no `referenceMaxTokens` output cap — direct latency lever vs our cancellation-dominant failure mode; (4) no ref/synthesis temperature knobs; (5) consider a "hermes-style" arm (refs once per turn, checkpoints off) as ablation of our central bet.

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

1. When codex `effort-config` finishes: review, check, live smokes both runtimes, commit. Then set `GSD_MOA_EFFORT=high` in yukon `.proof/*.env`, push `oh-my-pi-port` to yukon (`--force-with-lease` rules apply), rebuild omp bundle if deps changed.
2. Build the pi-runtime bundle + run-probe.sh; run the pi-vs-omp + effort probe (see "Planned" section above). This supersedes the old "compare vs leaderboard" step — comparisons are effort-confounded until rerun at high.
3. Rewrite `docs/TERMINAL-BENCH-RESULTS.md` as the new evidence snapshot (supersedes June table; note the effort caveat on all pre-2026-07-03 data).
4. Pending user decision: Hermes audit gaps 1–3 (trailing-assistant strip, failed-ref notes, referenceMaxTokens) as a follow-up codex spec; "hermes-style" ablation arm; async advisor arm (cancellations dominate).
5. Backlog: Gemini-as-perception-tool track (LemonHarness pattern — needs multimodal task slice + antigravity tokens on yukon); Z.ai key in `.proof/gsd-moa.env` still unrotated; tool-time pairing 0.0 on old artifacts (harmless); factory proxy model-limits fix unverified.

## Workflow conventions

- Implementation is delegated to GPT-5.5 Codex via local pi CLI: write a spec file in the scratchpad, then
  `cd <worktree> && pi --provider openai-codex --model gpt-5.5 --thinking high --mode json -n "<name>" -p @<spec>.md`
  (background). Claude reviews the diff, runs `npm run check` + a live omp smoke test, then commits. See memory `delegate-implementation-to-pi-codex`.
- Live omp smoke test:
  `set -a; source ../gsd-moa/.proof/gsd-moa.env; set +a; ./node_modules/.bin/omp --no-session -e ./src/index.ts --model "gsd-moa/gpt55-cliproxycodex-single" -p "Reply with exactly: OK"`
  (model flag must be the combined `gsd-moa/<alias>` form; Bun 1.3.14 required on the host).
- User grants latitude for larger design/arch improvements without asking (memory `design-improvement-latitude`); dev experiments run at k=2 on yukon, not the laptop.
