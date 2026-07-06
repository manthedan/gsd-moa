# S2 MoA Trace Forensics (F0)

2026-07-04. Digest of all 47 recoverable MoA trials from `jobs/s2-ckpt-full` + `jobs/s2-hermes-full` (one hermes gcode trial left no traces — the NonZeroAgentExitCode crash). Method: yukon-side digest of per-call traces (`/tmp/moa_forensics.py` → `/tmp/moa-forensics/`); advisor text, injected-guidance timeline, actor next-actions, per-role latencies. No `pi-output.jsonl` reads.

## Headline: the deficit is mostly self-inflicted latency, with a specific culprit

**The GPT-5.5 self-proposer cannot answer inside `referenceTimeoutMs` (120s) at high effort.** Across s2-ckpt-full it aborted at the timeout in **92/156 injections (59%)**, mean latency 101s; in hermes-full initial advice, 23/36 (64%). GLM-5.2 answers in mean 31–36s and essentially never times out. Since the dual-proposer pair runs per injection, every checkpoint costs ~2 minutes of wall clock, most of it spent waiting for an advisory that arrives **truncated mid-sentence and is injected anyway**.

Consequences by task (ckpt-full):

- **mcmc** (2/3 cancelled): 11–14 injections/trial, advisor Σ 1365–1627s. In `5qDEHVx`, ~1500s of the ~1600s window between first and last call was advisor-blocked — the actor was starved of its own clock and cancelled at the ceiling. Single passed mcmc 2/3.
- **gcode** (0/3; single 1/3): 6–7 injections ate ~10 of 15 minutes. `RddXF98` failed un-cancelled but time-starved — still undecoded at remaining=163s.
- **raman**: advisor Σ ~500s of the 900s budget (55%+) on a task nobody passes anyway — pure waste.
- Arm-wide: refΣ 13.7m mean out of 20.8m wall (66%), vs single's 13.0m wall total.

Secondary advisor defects:

- **GLM `FAIL:length` ×8 across arms** — `referenceMaxTokens` 8192 exhausted (reasoning eats the budget), advice truncated.
- **Truncated/aborted advice is injected** rather than dropped — the actor receives mid-sentence fragments after paying full timeout for them.
- **Drift checkpoints are trigger-happy**: up to 10 drift re-advisories per trial (`driftToolResultThreshold: 3`, `maxToolResults: 4`) — the schedule multiplies the per-injection cost.

## Advice content: plausible, topically followed, not additive — and contradictory at decisive junctures

Advice quality is genuinely decent (correct strategies, useful pitfalls). The actor visibly works along advised lines. But in the sampled trials, no injection rescued a doomed trajectory, and the two proposers **contradict each other exactly where it matters**:

- gcode `RddXF98`: GLM insists the text is object 1 (low-Z, sparse strokes); GPT-5.5 insists object 0 (Z≈64.88) — opposite answers to the trial's pivotal question, injected side by side.
- extract-elf `wfFU2M9` (hermes): GLM says ".data-first extractor"; GPT-5.5 (truncated) says "all file-backed PT_LOAD segments" — the conflict lands on the design choice that decides the ≥75%-coverage criterion.
- GLM occasionally offers wrong-answer bait ("safest answer is the `M117` string / 'Embossed text'"); the actor correctly declined each sampled instance.

## hermes-full is the natural control: small tax, still 4/24

Turn-boundary skipping made hermes-full effectively **initial-advice-only** (1–2 injections, advisor Σ 69–395s). Its 2-pass gap to single (4 vs 6) is within noise at n=24; its distinctive failures were **confident wrong-scope completions** — both failed extract-elf trials produced a clean-running `extract.js` with **0.0% address coverage** ("finished", zero overlap with the reference address set). Initial advice neither caused nor caught that.

## Bucket verdicts (48 trials)

| bucket | verdict |
|---|---|
| (c) clock lost to advisor | **dominant for ckpt-full's passable-four failures** (mcmc ×2 cancelled, gcode ×3 starved, overfull ×2 cancelled) |
| (d) capability floor | hard-file/raman/torch/caffe — 24 trials, advice irrelevant, both arms 0 (matches single) |
| (b) advice adopted and wrong | no clear instance found; conflicts add arbitration noise, not observed wrong turns |
| (a) advice ignored | not the story — advice is read and topically followed |

## Actionable fixes (feed F1/F2/F3)

1. **Drop the GPT-5.5 self-proposer from advisory pools** (or fix its effort/timeout mismatch). GLM-only advice costs ~35s/injection instead of ~120s; the self-proposer contributed 59% aborts and the contradictions above. Cheapest possible ablation: rerun ckpt-full config with `proposers: [glm52]` — this alone returns most of the stolen clock.
2. **Never inject aborted/truncated advice** — drop it and log; paying 120s for a fragment is the worst of both worlds. (Same for `FAIL:length` fragments, or raise `referenceMaxTokens`.)
3. **Calm the drift cadence** (or kill drift re-advice outright per the S2 core read; keep failure-scope only → F2 rescue mode).
4. **Review-before-done has live targets**: the 0%-coverage extract-elf completions are exactly the confident-wrong class a done-gate reviewer could catch by sanity-checking output against the task's own example (addresses from 0x400000). Supports F4's offline replay.

Raw digests: yukon `/tmp/moa-forensics/` (also `summary.tsv` per-trial: reward, injections by scope, advisor Σ).
