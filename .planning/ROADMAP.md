# Roadmap: v1.1 Full MoA Build-out and Dogfood Evaluation

## Overview

Before the testing/proof milestone, `gsd-moa` should implement the full Hermes-style feature delta: tool-less reference-model fan-out, optional tool-less synthesis, and one final tool-capable acting call. After that, the proof harness should compare `single`, `advisor`, and `full_moa` on realistic Pi/GSD work.

## Phases

**Phase Numbering:** Continuing from v1.0; archived phases 1–4 live under `.planning/milestones/v1.0-phases/`.

- [x] **Phase 5: Full MoA Feature Build-out** - Add explicit full-MoA alias, reference-model fan-out, optional synthesis, diagnostics, cache behavior, and docs.
- [x] **Phase 6: Proof Harness and Artifact Capture** - Add a local live-run harness that executes `single`, `advisor`, and `full_moa` through the configured Factory/Z.ai proxy routes and writes durable, redacted artifacts.
- [ ] **Phase 7: Realistic Evaluation Task Suite and Rubric** - Define representative Pi/GSD tasks plus a usefulness rubric for comparing single vs advisor/full-MoA outputs. First Harbor sample completed on `terminal-bench/fix-git`.
- [ ] **Phase 8: Dogfood Run, Summary, and Decision Gate** - Run the suite, inspect results, document advisor/full-MoA value, and decide whether to harden, adjust, or pause.

## Phase Details

### Phase 5: Full MoA Feature Build-out

**Goal**: Implement full MoA before testing while preserving the single-writer tool boundary.
**Mode:** mvp
**Depends on**: v1.0 complete
**Requirements**: [MOA-01, MOA-02, MOA-03, MOA-04, MOA-05]
**Status**: Complete
**Success Criteria**:

1. `gpt55-glm52-full` is registered and selectable.
2. Full MoA runs multiple tool-less reference models in parallel against sanitized context.
3. Optional synthesis layer consumes reference outputs without tools.
4. Final GPT receives original tools plus private proposal/synthesis guidance.
5. Diagnostics include all reference/synthesizer/primary inner calls, usage, and cache hit/miss.
6. Routing markers are stripped before all upstream calls.

### Phase 6: Proof Harness and Artifact Capture

**Goal**: A developer can run a local proof command that compares `single`, `advisor`, and `full_moa` on the same input and saves enough trace evidence to inspect what happened.
**Mode:** mvp
**Depends on**: Phase 5
**Requirements**: [PROOF-01, PROOF-02, PROOF-03]
**Status**: Complete
**Success Criteria**:

1. A local command/script runs live proof cases through `gsd-moa` using the configured Factory GPT-5.5 proxy and Z.ai GLM-5.2 route.
2. Each case can run all three modes against identical prompt/context input.
3. Run artifacts are stored under a gitignored proof directory with stable filenames.
4. Artifacts include redacted config, prompt/input, output, diagnostics, route metadata, latency, usage, and cache hit/miss.
5. Missing proxy keys or unavailable local proxy fail with actionable setup messages.

### Phase 7: Realistic Evaluation Task Suite and Rubric

**Goal**: The proof harness has meaningful tasks and a review rubric focused on whether advisor/full-MoA modes improve real work.
**Mode:** mvp
**Depends on**: Phase 6
**Requirements**: [EVAL-01, EVAL-02]
**Status**: In progress — Harbor installed, oracle smoke passed, `single` and `full_moa` both passed `terminal-bench/fix-git`.
**Success Criteria**:

1. The suite includes plan review, code review, debugging, architecture critique, and milestone audit cases.
2. Case inputs are realistic but safe to run without mutating the repository.
3. The rubric asks whether advisor/full-MoA caught issues single missed, improved final recommendations, or added unnecessary noise.
4. The rubric captures latency/cost tolerance and when expensive modes should be avoided.
5. Example reviewer notes are included so future runs are comparable.

### Phase 8: Dogfood Run, Summary, and Decision Gate

**Goal**: A real dogfood run produces an evidence-backed decision about advisor/full-MoA usefulness and next steps.
**Mode:** mvp
**Depends on**: Phase 7
**Requirements**: [EVAL-03, SAFE-01, OBS-03, DOC-03]
**Success Criteria**:

1. At least five proof cases run end-to-end with `single`, `advisor`, and `full_moa` variants.
2. Summary identifies where advisor/full-MoA helped, hurt, or was not worth the overhead.
3. Summary includes observed latency/usage/cache behavior and reviewer conclusions.
4. Artifacts demonstrate GLM calls remain tool-less and final GPT calls are the only tool-capable path.
5. Final decision gate recommends one of: harden/publish, adjust prompts/routing, expand evals, or pause.

## Progress

**Execution Order:**
Phases execute in numeric order: 5 → 6 → 7 → 8

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 5. Full MoA Feature Build-out | 1/1 | Complete | 2026-06-27 |
| 6. Proof Harness and Artifact Capture | 3/3 | Complete | 2026-06-27 |
| 7. Realistic Evaluation Task Suite and Rubric | 1/2 | In progress | - |
| 8. Dogfood Run, Summary, and Decision Gate | 0/3 | Planned | - |
