# MoA Value Roadmap

2026-07-04. Follows the S2 matrix read; supersedes the ad-hoc "after S2" queue for MoA-value work. Droid control arm and the four-way `TERMINAL-BENCH-RESULTS.md` update are a separate, already-running track.

> **2026-07-08: Roadmap v2 below supersedes the F-track sequencing in this document.** The F-sections are kept as the experiment record; their statuses are summarized in the v2 ledger.
>
> **2026-07-09 hardening:** M1 telemetry is now parsed by the tracked Terminal-Bench aggregator (gate arm/fire, verifier evidence, pass/fail evidence, and post-gate behavior). Trace writes are boundary-flushed instead of rewritten per token delta, and zero-valued private-route pricing is reported as unpriced rather than free.

## Motivating state

S2 (all integrity-clean, k=3, 8 tasks): single **6/24** > ckpt-full **4/24** = hermes-full **4/24**. The ablation pair differed only in checkpoint re-advice → scheduled re-advice does not earn its cost. But the deficit is partly mechanical: ckpt-full averaged 20.8m wall vs single's 13.0m and 9 cancellations vs 4; raman ran pegged at its 15m ceiling. "Advice everywhere" is falsified; "advice when it counts" is untested.

Power discipline (applies to every phase):

- Only the passable four (extract-elf, mcmc, gcode, overfull) carry information; hard-file/raman/caffe/torch are 0 across all arms — no advisor lifts a task the actor can't do at all. Lift claims come from the passable four at k≥5.
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

- **H1 — Fix Python execution in the omp harness (highest-leverage item found) — FIXED (`f71facc`), smoke pending.** Corrected root cause (2026-07-04, verified on yukon): the torch/hard-file images ship **no python3 at all**; Droid had one only because `droid_agent.py`'s install phase apt-gets python3, while our omp adapter's prebuilt fast path returned before its own apt block. The omp tools (brush, eval kernel probe, PATH) were behaving correctly. Fix: system deps now install on every adapter path, with a `python` shim and a 0s skip when already present. Remaining: post-S3 tool-level smoke on the torch image — `python3 -m py_compile` + an `eval` py cell through actual omp tools (`import torch` is not a valid smoke; apt python has no torch — even Droid failed that import and passed via `py_compile`). Likely explains part of the gap beyond these two tasks.
- **H2 — "install a CLI tool, drive it from Python" recipe** (Droid used apt-get + subprocess for the checker CLI on `hard-file-task`; ours flailed from a JS fallback).
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

---

# Roadmap v2 — 2026-07-08

Reconciles the F-track results with an external strategy review (2026-07-08). Supersedes the v1 sequencing above.

> **2026-07-09 status:** M1 DONE — CONTINUE (13/23 vs same-commit control 11/23; mechanism fully validated, +3 on the passable four concentrated where fires were universal, zero wall-time cost; gate stays on in future arms). M2 DONE — GLM-5.2 as actor adds **zero** complementarity (7/23, strict subset of GPT coverage, clock-bound, 8 cancellations); torch all-fail broken by the *control* (1/3 — first torch pass ever) ⇒ torch is approach-shaped, not model-shaped. M4 stays parked (no actor-diversity support; only the F4 think-mode reviewer data argues for it). **M3 is the main track.** Full read: `TERMINAL-BENCH-RESULTS.md` top section.

## Thesis of record

**A single strong terminal actor should do most work. MoA is a sparse, typed reviewer/rescue system that fires at high-leverage judgment points — where execution feedback is weak or the actor is stuck.** Harness quality moves pass rate more than MoA does (Droid 10/24 vs our 6/24, same model/proxy); MoA competes at specific decision points, not everywhere.

## F-track status ledger

| item | status | read |
|---|---|---|
| F0 forensics | DONE | latency tax dominated; fixes validated by s3 (6/24, zero referenceFailures) |
| F1 async advisor | PARKED | clock-class losses shrank after F0 fixes + rescue; revisit only if timeout rate grows |
| F2 rescue advice | DONE — mechanism validated, kept on | 1 clean fire/20 trials, cured the stuck loop, ~24s overhead, zero spurious. Default-on in future arms; not expected to carry pass lift |
| F3 model-mix ablations | FOLDED into M2 | oracle framing answers the same question cheaper (see M2) |
| F4 review-before-done | naive form NO-GO (offline replay 07-05/06) | 24%/19% catch, 50% nothink false alarms, dominant defect family invisible to diff-only review 0/24. Scoped closed-loop variant parked behind M2 (→ M4) |
| H1 python-exec | CLOSED (`f71facc`) | hard-file 0/3 → 1/3; torch reclassified to solution correctness — the remaining Droid gap is not tooling |

## M1 — Mechanical done-gate + structured session state (DONE — CONTINUE)

The cheapest attack on the dominant remaining failure mode: ships-blind finalization (torch trials wrote plausible code and finished without any execution check). A **deterministic** provider-side gate — no second model, no LLM routing:

- Derive structured session state from the context: files modified, commands run, verifier evidence (verifier ran? passed?).
- When the actor finalizes after modifying files with **no verifier evidence in the whole session**, inject a one-shot harness note: run the most relevant verifier now, or state in one line why verification is impossible — then finish. At most one retry (in-process ledger cap; injected notes do not persist in session context — F2 lesson).
- Default off; enabled per-alias. Zero behavior change for existing aliases.
- Diagnostics feed two new standard metrics: **verifier-run-before-done rate** and **gate fire rate + post-gate behavior** (verified / justified / ignored).

Arm: `single+donegate` vs s2-single on passable four + torch, k≥5 on passable four, k≥3 torch. Decision rule: gate should fire on a material share of former ships-blind losses and post-gate verification should convert some to passes or honest blockers; if fire rate ≈ 0 or post-gate behavior is all "justified/ignored", the gate is a no-op and gets folded into prompt guidance instead.

## M2 — Model-diversity oracle (DONE — no complementary GLM actor wins)

Before paying for any new MoA configuration: run each candidate model as an **independent single actor under the same harness** on the stratified slice and compute single-best, oracle score (any-model-pass), all-fail rate, pairwise complementarity, tokens/pass, wall/pass, and priced cost/pass only where route pricing is configured. The oracle advantage is a ceiling for *routing among unchanged independent answers*, not a mathematical ceiling for synthesis or review; low complementarity is a negative signal, not proof that collaboration cannot help.

- Already have: GPT-5.5 single (s2-single 6/24 + s4 hard-four). Droid control (10/24) remains harness evidence and must not be treated as a model-diversity sample.
- Need: **GLM-5.2 single** (`glm52-zai-single` alias — ships with M1) under the same omp harness, passable four + hard canaries, k≥3.
- Slice hygiene: add 2–4 untried mid-difficulty tasks at arm time to cut passable-four overfitting.

Gates M4 and any cross-model portfolio work. Oracle headroom high but realized MoA low → the problem is integration, not the portfolio.

## M3 — GSD-typed checkpoints inside the TB harness (the strategic pivot)

Implement GSD-style plan / implement / verify / review phases as **typed checkpoints in the omp harness**, staying on the execution-graded TB substrate — not a second framework with custom benchmarks. MoA becomes eligible only at checkpoint boundaries (strategy selection, post-verify-failure root-cause, review-before-done), each with its own trigger, budget, and ledger. Design doc after the M1 arm read; implementation is the next codex-delegation cycle after that. Custom GSD micro-benchmarks come later, derived from trace-mined failure modes (50–100 clean trials first).

## M4 — Scoped review-before-done (PARKED; the only F4 survivor)

M2 found no actor-model complementarity, so M4 is not funded as a broad arm. Reconsider it only if a semantic-risk slice (distributed/autograd-heavy + actor-couldn't-execute) produces reviewer-side catch evidence. Closed-loop form only: reviewer sees task + diff + verification transcript, outputs approve/block with a concrete `command_to_run` the actor must execute or explicitly reject — this is the loop the offline replay could not test, and the only mechanism with a story for the diff-invisible defect family. Think-mode reviews only (nothink false-alarm rate disqualifying); expectations remain anchored to the F4 replay numbers, not the MoA literature.

## Metrics (all future arms)

pass rate · integrity-clean pass rate · tokens/pass · wall/pass · priced cost/pass when route pricing is configured · timeout rate · **verifier-run-before-done rate** · **gate fire rate + post-gate behavior** · rescue fire rate · (reviewer arms) block precision + missed-block rate.

## Sequencing

```
done        M1 implementation + same-commit control arm; M2 GLM single arm + oracle read
now         commit audit hardening → rebuild Yukon bundle → live smoke → tracked reaggregation
then        M3 typed-checkpoint design/eval contract → deterministic prototype → controlled arm
parked      M4 unless semantic-risk reviewer evidence overturns the M2/F4 negative signal
re-gate     after each arm, per decision rules above
```

Standard config unchanged (omp runtime, effort high, integrity on, real budgets, k≥3 floor, rescue on where aliased); yukon serializes arms.
