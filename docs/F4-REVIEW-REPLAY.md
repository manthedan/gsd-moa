# F4 — Review-before-done offline replay (torch-tensor-parallelism)

2026-07-05/06. Runs from the laptop against Z.ai direct (no yukon slot). Estimates the
effect size of a GLM-5.2 "done-gate" review before implementing it in the provider
(MOA-VALUE-ROADMAP.md §F4). Motivated by the s4 read: torch losses are solution
correctness on an execute-unverifiable task — exactly where a tool-less second model
should have a structural edge.

## Method

- **Positives (7)**: final `/app/parallel_linear.py` from every failed torch trial —
  s4-posth1-single ×3, s2-single ×3 (all reward 0, no cancellation, agent finished with a
  confident completion claim), plus droid's one failing trial. Our files reconstructed by
  replaying the trials' `write` + hashline `edit` tool calls with `@oh-my-pi/hashline`
  `parsePatch`/`applyEdits` (verified against the edit tool's recorded post-edit line
  echoes; all files py_compile clean). Droid files from its post-patch full-file `Read`
  results / single Add-File patch.
- **Negative controls (2)**: droid's two *passing* torch solutions (reward 1). A reviewer
  that flags everything would flag these too.
- **Reviewer**: GLM-5.2, Z.ai coding endpoint, blind: task statement + final file only.
  Completion-gate prompt, JSON verdict APPROVE/REVISE + defects, explicitly told to flag
  only defects that break the tested behaviors (init/sharding, outputs, grads; ws 1/2/4).
- **Arms**: `nothink` (thinking disabled, 2–15s/review ≈ production advisor latency) and
  `think` (thinking enabled, 32k budget, 35–657s ≈ offline ceiling). k=3 each.
  54 reviews total. Full bundle (reconstructed solutions, raw reviews.jsonl, harness,
  ground truth, per-arm scorecards): `~/projects/gsd-moa/.proof/runs/f4-replay-2026-07-05/`.

## Ground truth (verifier logs + droid pass/fail diff)

All 7 failing solutions pass every ws=1 test and fail only ws=2/4. Two real defect
families:

1. **Collective autograd semantics** — using `torch.distributed.nn.functional`
   all_gather/all_reduce (or custom `autograd.Function`s with an extra `all_reduce` in
   backward) scales weight grads by ~world_size → "weight grad mismatch" asserts.
2. **Row input contract** — the tests feed RowParallelLinear an **already-sharded** input
   at ws>1. Unconditional slicing/chunking of that input → `2x0` matmuls / narrow
   out-of-range. Droid's passers survive only via a defensive dual-width check; the task
   statement does not state the convention. Code-invisible.

Per-solution details: `ground_truth.md` in the run bundle.

## Results

Review-level scoring: **catch** = REVISE naming a real mechanism; **noise** = REVISE with
only wrong/speculative defects; **miss** = APPROVE on a failing solution.

| | nothink | think |
|---|---|---|
| catches on failing solutions | **5/21 (24%)** | **4/21 (19%)**¹ |
| noise-REVISE on failing solutions | 1 | 4 (hallucinated or speculative mechanisms) |
| false alarms on passing controls | **3/6 (50%)** | **0/6** |
| latency per review | 2–15s | 35s–15m (median ~5m) |

¹ Denominator counts one review (3LG7mvd k=2) that exhausted the full 32k thinking budget
after 15 minutes without emitting a verdict (`finish_reason: length`) — itself a
done-gate failure mode.

Per-solution (k=3 majority, union of catches):

| solution | real defect | nothink | think |
|---|---|---|---|
| s4 3LG7mvd | collective autograd | CATCH 3/3 | noise 2/2 + 1 budget-exhausted (hallucinated all_gather return type)² |
| s4 h4q4xxn | custom backward all_reduce + row slice | CATCH 2/3 | CATCH 3/3 — both mechanisms textbook-exact |
| s4 paHnJue | collective autograd + row narrow | miss 0/3 | miss 1 + noise 2 |
| s2 B2Jp2xh | collective autograd | miss 0/3 | miss 0/3 |
| s2 GsETQLC | collective autograd + row slice | miss 0/3 | CATCH 1/3 |
| s2 Zd3yW9E | row chunk contract | miss 0/3 (conf 0.95!) | miss 0/3 (conf 0.92–0.95) |
| droid V3hkWcV | row slice contract | miss/noise | miss 0/3 |
| droid TVF6v8z (PASS) | — | approve 2/3 | approve 3/3 |
| droid 8KbmGN6 (PASS) | — | approve 1/3 (majority FALSE ALARM) | approve 3/3 |

² Claimed `torch.distributed.nn.functional.all_gather` returns a dim-0-concatenated
tensor (it returns a per-rank tuple) and that outputs would be mis-shaped — verifier
shows outputs passed, only grads failed. Right verdict, fabricated reason.

## Read

1. **The catch signal is real but narrow.** When GLM catches, it names the exact defect
   (`_AllGatherLastDim.backward` should slice, not all_reduce; `_AllReduceSum.backward`
   should be identity). A revision round started from those reviews would plausibly fix
   the trial. Solutions caught at least once by either arm: 3/7.
2. **The dominant failure family is structurally uncatchable offline.** The row-input
   contract violation was caught **0/24** opportunities across both arms — it requires
   knowing an unstated test convention. No reviewer prompt fixes epistemic absence; the
   fix is actor-side (defensive coding norms) or execution, not review.
3. **Thinking buys specificity, not sensitivity.** 6/6 correct approves on passing
   controls (nothink: 3/6) at 20–100× the latency, no catch-rate gain, plus a new
   failure mode: confidently fabricated API facts producing right-verdict/wrong-reason
   REVISEs — poison for an automated revision loop, which would steer the actor at a
   non-defect.
4. **Detection is surface-form lottery, and confidence is uninformative.** B2Jp2xh fails
   by the same mechanism caught 3/3 on 3LG7mvd yet went APPROVE 6/6; misses ship at
   conf 0.92–0.95. Verdict confidence cannot gate escalation.

## Verdict for the F4 done-gate

**Do not implement the naive gate** (intercept completion → one review → revision round):
~20–25% catch rate on real confidently-wrong completions, and at production latency the
false-alarm rate on correct work (50%) would send back half of the good completions.

What the evidence does support, if F4 continues:
- **nothink-only, k≥2, REVISE-consensus-gated**: at k=3 nothink, unanimous/majority
  REVISE separates cleanly on this sample (3LG7mvd 3/3, h4q4xxn 2/3 vs controls' 0/3+1/3
  … but 8KbmGN6's 2/3 noise majority breaks it). Marginal.
- **Scope the gate to what review can see**: distributed/autograd-heavy diffs where the
  actor could not execute its own verification. On that slice the catch rate is
  meaningfully higher (the collective-autograd family was caught at least once on 3/5
  solutions).
- Biggest lever is actor-side, not reviewer-side: h4q4xxn/paHnJue/Zd3yW9E-class losses
  come from committing to one interpretation of an ambiguous contract. Droid's edge on
  torch (2/3) came from defensive dual-width handling, not from knowing the convention.

Recommended F-track re-weighting: F2 (rescue-triggered advice) remains the live MoA
hypothesis; F4 done-gate only in the scoped form, if at all. The "defensive-coding on
unverifiable contracts" observation feeds H-track (harness prompt guidance) at ~zero cost.
