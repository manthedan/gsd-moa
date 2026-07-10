---
gsd_state_version: 1.0
milestone: v1.2
milestone_name: Sparse MoA Value Evaluation
current_phase: 11
current_phase_name: GSD-Typed Checkpoints
status: in_progress
stopped_at: M1 and M2 complete; audit hardening validated; M3 design/prototype next
last_updated: "2026-07-09T00:00:00.000Z"
last_activity: 2026-07-09
last_activity_desc: Completed M1/M2 arms and project-wide hardening; final dual-runtime checks and autoreview are clean
progress:
  total_phases: 4
  completed_phases: 2
  total_plans: 4
  completed_plans: 2
  percent: 50
---

# Project State

## Project Reference

See `.planning/PROJECT.md`, `.planning/ROADMAP.md`, and the authoritative detailed roadmap at `docs/MOA-VALUE-ROADMAP.md`.

**Core value:** Keep one strong terminal actor as the writer and spend second-model judgment only at sparse, high-leverage checkpoints.

**Current focus:** Roadmap v2 M3 — design and prototype typed plan/implement/verify/review checkpoints inside the OMP/Terminal-Bench harness.

## Current Position

- M1 done-gate: complete — 13/23 vs same-commit single control 11/23; mechanism validated, directional but not statistically conclusive.
- M2 diversity oracle: complete — GLM-5.2 single 7/23, slower, with no complementary wins over GPT-5.5 on the evaluated slice.
- Audit hardening: complete locally — final Codex autoreview clean; 199/199 tests pass in each runtime.
- M3: active — AI/design contract, deterministic typed checkpoint prototype, and controlled arm remain.
- M4: parked — no broad reviewer/model-diversity justification from M2.

## Decisions

- Harness quality has higher demonstrated leverage than broad MoA.
- Mechanical done-gate stays enabled in future experiment aliases so evidence accumulates without a dedicated expensive arm.
- Rescue advice remains sparse and capped; scheduled checkpoint re-advice is not the default thesis.
- GLM actor/model-mix ablations are stopped unless a new same-harness complementarity signal appears.
- Droid remains a harness control, not a model-diversity sample.
- Oracle advantage bounds routing among unchanged answers; it does not mathematically bound synthesis or review.
- Private/subscription routes without configured prices report cost as `unpriced`; use tokens/pass and wall/pass for the default economic read.
- Only the final actor receives tools.

## Pending

1. Commit and sync the audit hardening.
2. Rebuild the Yukon runtime bundle and run a live OMP/proxy smoke because dependency versions changed.
3. Reaggregate M1/M2 artifacts with the tracked aggregator; keep the original arm commit pinned in comparisons.
4. Produce the M3 typed-checkpoint design/evaluation contract and prototype.
5. Run a controlled M3 arm; optionally use rescue+done-gate as the low-cost control combination.

## Concerns

- Live runs require valid proxy routes and credentials.
- Benchmark arms must use the tracked aggregator; `/tmp` scripts are not authoritative.
- M1's original classifier missed R-workflow verification; targeted R support is being added before reaggregation.
- The hardened done-gate semantics differ from arm commit `e3d0d98` (failed writes and compound/heredoc behavior), so cross-arm reports must pin commits.
- Nine moderate OpenTelemetry advisories remain transitively owned by OMP; npm's suggested remediation is an incompatible downgrade.
