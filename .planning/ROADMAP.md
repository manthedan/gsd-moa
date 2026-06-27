# Roadmap: v1.1 Useful Proof / Dogfood Evaluation

## Overview

Before hardening or publishing `gsd-moa`, prove that advisor mode is useful on realistic Pi/GSD work. This milestone builds a repeatable proof harness, a small live evaluation suite, and human-readable evidence that explains when `gpt55-glm52-advisor` is worth using instead of `gpt55-glm52-single`.

## Phases

**Phase Numbering:** Continuing from v1.0; archived phases 1–4 live under `.planning/milestones/v1.0-phases/`.

- [ ] **Phase 5: Proof Harness and Artifact Capture** - Add a local live-run harness that executes `single` and `advisor` through the configured Factory/Z.ai proxy routes and writes durable, redacted artifacts.
- [ ] **Phase 6: Realistic Evaluation Task Suite and Rubric** - Define representative Pi/GSD tasks plus a usefulness rubric for comparing single vs advisor outputs.
- [ ] **Phase 7: Dogfood Run, Summary, and Decision Gate** - Run the suite, inspect results, document advisor-mode value, and decide whether to harden, adjust, or pause.

## Phase Details

### Phase 5: Proof Harness and Artifact Capture

**Goal**: A developer can run a local proof command that compares `single` and `advisor` on the same input and saves enough trace evidence to inspect what happened.
**Mode:** mvp
**Depends on**: v1.0 complete
**Requirements**: [PROOF-01, PROOF-02, PROOF-03]
**Success Criteria** (what must be TRUE):

1. A local command/script runs live proof cases through `gsd-moa` using the configured Factory GPT-5.5 proxy and Z.ai GLM-5.2 route.
2. Each case can run both `gpt55-glm52-single` and `gpt55-glm52-advisor` against identical prompt/context input.
3. Run artifacts are stored under a gitignored proof directory with stable filenames.
4. Artifacts include redacted config, prompt/input, output, diagnostics, route metadata, latency, usage, and cache hit/miss.
5. Missing proxy keys or unavailable local proxy fail with actionable setup messages.

**Plans**: 3 plans

Plans:

- [ ] 05-01: Add proof harness CLI/script and package command.
- [ ] 05-02: Add redacted artifact writer with latency/usage/diagnostic capture.
- [ ] 05-03: Add setup validation for Factory GPT and Z.ai proxy routes.

### Phase 6: Realistic Evaluation Task Suite and Rubric

**Goal**: The proof harness has meaningful tasks and a review rubric focused on whether advisor mode improves real work.
**Mode:** mvp
**Depends on**: Phase 5
**Requirements**: [EVAL-01, EVAL-02]
**Success Criteria** (what must be TRUE):

1. The suite includes plan review, code review, debugging, architecture critique, and milestone audit cases.
2. Case inputs are realistic but safe to run without mutating the repository.
3. The rubric asks whether advisor mode caught issues single missed, improved final recommendations, or added unnecessary noise.
4. The rubric captures latency/cost tolerance and when advisor mode should be avoided.
5. Example reviewer notes are included so future runs are comparable.

**Plans**: 2 plans

Plans:

- [ ] 06-01: Author representative proof cases from this repo/GSD workflow.
- [ ] 06-02: Define human usefulness rubric and reviewer note format.

### Phase 7: Dogfood Run, Summary, and Decision Gate

**Goal**: A real dogfood run produces an evidence-backed decision about advisor mode's usefulness and next steps.
**Mode:** mvp
**Depends on**: Phase 6
**Requirements**: [EVAL-03, SAFE-01, OBS-03, DOC-03]
**Success Criteria** (what must be TRUE):

1. At least five proof cases run end-to-end with both `single` and `advisor` variants.
2. Summary identifies where advisor mode helped, hurt, or was not worth the overhead.
3. Summary includes observed latency/usage/cache behavior and reviewer conclusions.
4. Artifacts demonstrate GLM calls remain tool-less and final GPT calls are the only tool-capable path.
5. Docs include advisor-mode diagram and proof-harness usage instructions.
6. Final decision gate recommends one of: harden/publish, adjust prompts/routing, expand evals, or pause.

**Plans**: 3 plans

Plans:

- [ ] 07-01: Run dogfood proof suite and collect artifacts.
- [ ] 07-02: Write aggregate proof summary and usefulness decision.
- [ ] 07-03: Update docs with advisor flow diagram and proof usage.

## Progress

**Execution Order:**
Phases execute in numeric order: 5 → 6 → 7

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 5. Proof Harness and Artifact Capture | 0/3 | Planned | - |
| 6. Realistic Evaluation Task Suite and Rubric | 0/2 | Planned | - |
| 7. Dogfood Run, Summary, and Decision Gate | 0/3 | Planned | - |
