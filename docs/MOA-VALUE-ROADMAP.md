# MoA Value Roadmap

2026-07-04. Follows the S2 matrix read; supersedes the ad-hoc "after S2" queue for MoA-value work. Droid control arm and the four-way `TERMINAL-BENCH-RESULTS.md` update are a separate, already-running track.

## Motivating state

S2 (all integrity-clean, k=3, 8 tasks): single **6/24** > ckpt-full **4/24** = hermes-full **4/24**. The ablation pair differed only in checkpoint re-advice → scheduled re-advice does not earn its cost. But the deficit is partly mechanical: ckpt-full averaged 20.8m wall vs single's 13.0m and 9 cancellations vs 4; raman ran pegged at its 15m ceiling. "Advice everywhere" is falsified; "advice when it counts" is untested.

Power discipline (applies to every phase):

- Only the passable four (extract-elf, mcmc, gcode, overfull) carry information; dna/raman/caffe/torch are 0 across all arms — no advisor lifts a task the actor can't do at all. Lift claims come from the passable four at k≥5.
- A Nous-sized +6pp is undetectable at our budgets (~800 trials/arm for 80% power). We hunt **large effects on targeted failure modes** and **mechanism-level metrics** (adoption, recovery-after-stuck, wall-time parity), not smallpass-rate deltas.

Decisions locked 2026-07-04:

- Droid bare-harness control: yes (running).
- **mac-mini CLIProxy host: rejected by user.** Model routes are yukon CLIProxy (codex OAuth → GPT-5.5) and Z.ai direct (GLM-5.2). Cross-family advisors (Claude/Gemini) are deferred until a route the user likes exists.
- Model-mix ablations, rescue-triggered advice, and review-before-done: approved.

## F0 — S2 trace forensics ($0, in progress)

Every S2 MoA inner call left a trace with the advisor text, the injected guidance, the actor's next action, checkpoint scope, and timings (`agent/pi-gsd-moa/traces/*.json`). Yukon-side digest scripts (zero-bandwidth; never touch the 124MB `pi-output.jsonl` unless needed) classify each of the 48 MoA trials:

- **(a) advice ignored** — guidance injected, actor's behavior unchanged → integration/prompt problem.
- **(b) advice adopted, wrong** — actor followed it into a worse path → advisor-choice problem.
- **(c) advice fine, clock lost** — trial cancelled at ceiling with advisor latency material to the miss → latency tax (fixed by F1/F2).
- **(d) capability floor** — task no arm passes; advice irrelevant.

Deliverable: `docs/S2-FORENSICS.md` — diagnosis distribution, advisor latency budget share, adoption rate, and 2–3 quoted exemplars per bucket. **Gates F1–F3 emphasis.**

**DONE 2026-07-04 — read:** bucket (c) dominates — the GPT-5.5 self-proposer aborts at the 120s reference timeout in ~60% of injections (mean 101s vs GLM's 31s), truncated advice is injected anyway, and drift re-advice multiplies the cost (mcmc: ~1500s of a 1600s window advisor-blocked). Advice content is plausible but contradictory at decisive junctures and never rescued a trial. hermes-full ≈ initial-only (small tax, still 4/24, within noise of single). Fixes queued before F1's arm: glm-only proposer pool, drop truncated advice, calm drift cadence. F4 got direct evidence (0%-coverage confident completions).

## F1 — Async advisor arm

`asyncAdvisor` exists (`src/async-advisor.ts`, config `asyncAdvisor.enabled`, default off, `maxPendingMs` 600s). Advice streams in while the actor keeps working → latency tax → ~0.

1. Local smoke with trace check (advice actually arrives and is injected on a later turn).
2. Yukon arm after droid finishes (arms serialize on yukon): passable four + torch, k=3 first look.

Success: wall-time parity with single. Kill: async still trails single on the passable four → the tax wasn't the (main) problem, weight F2/F3 by F0's read.

## F2 — Rescue-triggered advice (the original auto thesis)

Advice fires **only** on detected stuck-ness — repeated tool failures / no-progress loops (failure-checkpoint machinery already exists; S2 ckpt-full fired `failure: 60`). No initial advice, no drift advice, no schedule. Converts the diffuse tax into a targeted intervention exactly where an outside view has the largest plausible effect — and where the effect is big enough to detect.

- Design the trigger from F0's stuck-trial signatures.
- Implementation via the usual codex-delegation flow; new alias (e.g. `gpt55-cliproxycodex-glm52-rescue`).
- Arm: single+rescue vs s2-single, passable four, k≥5.
- Mechanism metric alongside passes: recovery rate within N turns after trigger, vs matched stuck moments in s2-single.

## F3 — Model-mix ablations (no new infra)

All on existing routes; aliases largely pre-built in config:

| arm | alias | question |
|---|---|---|
| self-advice | `gpt55-cliproxycodex-full` (confirm reference routes to cliproxycodex GPT-5.5) | is "second opinion" worth anything without model diversity? |
| inverted pair | `glm52-zai-gpt55-cliproxycodex-nosynth-full` (exists) | does a stronger advisor lift a weaker actor? |
| inverted baseline | GLM-5.2 single (add tiny alias, e.g. `glm52-zai-single`) | required control for the inverted read |

The inverted pair is the cost-frontier story: if cheap-actor + occasional expensive judgment approaches expensive-actor performance, MoA has an economic value proposition even if strong actors gain nothing (headroom for advice plausibly vanishes as the actor nears its ceiling). Passable four, k≥3 to start.

## F4 — Review-before-done

The one place a tool-less second model has a structural edge: catching confident-but-wrong completion.

1. **Offline replay first ($ small, runs from the laptop against Z.ai; no yukon slot needed):** take s2-single failed trials where the actor finished cleanly (reward 0, no cancellation), feed final workspace state + task statement to a GLM-5.2 reviewer prompt, count real-defect catches vs noise flags. This estimates the effect size before any implementation.
2. If catch-rate is material: implement a done-gate in the provider (intercept completion, one advisor review, at most one revision round), alias it, arm it.

## H — Harness-gap track (parallel to the MoA F-track; opened 2026-07-04)

The Droid control (10/24 vs our 6/24, same model) proved some of our "capability floor" is really harness quality. Trajectory mining (`docs/TRAJECTORY-MINING.md`) localized the first concrete defect:

- **H1 — Fix Python execution in the omp harness (highest-leverage item found).** In the TB containers our `eval` tool has no Python kernel and our `bash` tool's PATH lacks `python3`, though the image ships Python 3.12 (Droid runs it fine). On `torch-tensor-parallelism` this alone costs the whole task — the agent writes a correct-shaped solution, cannot execute/verify it, and ships blind (0/3 vs Droid 2/3). Fix both breaks (bundle/fallback a py kernel for `eval`; repair the `bash` PATH), then live-smoke `python3 -c 'import torch'` through the tools on the torch image. Likely explains part of the gap beyond these two tasks.
- **H2 — "install a CLI tool, drive it from Python" recipe** (Droid used apt-get + subprocess for oligotm on `dna-insert`; ours flailed from a JS fallback).
- **H3 — verification-subagent pattern** (Droid spawned an independent checker worker — the role our MoA reference layer is meant to play; ties into the droid-proxy inverse experiment).

## Sequencing

```
now            F0 forensics DONE; H1 (python-exec fix) is highest-leverage, do next; F1 local smoke + F4 offline replay
droid done     four-way read → TERMINAL-BENCH-RESULTS.md DONE; trajectory mining DONE
s3 done        s3-vs-single F0-fix validation read
then, serial   H1 fix+verify → F1 arm → F2 impl+arm → F3 arms → F4 arm (if replay says go)
re-gate        after each arm: kill or continue per criteria above
```

Standard config throughout (effort high, integrity, real budgets, k≥3 floor); yukon runs one experiment at a time.
