---
gsd_state_version: 1.0
milestone: v1.1
milestone_name: Full MoA Build-out and Dogfood Evaluation
current_phase: 7
current_phase_name: Realistic Evaluation Task Suite and Rubric
status: planning
stopped_at: Trace/proof harness complete; ready to run Terminal-Bench and define evaluation rubric
last_updated: "2026-06-27T21:05:00.000Z"
last_activity: 2026-06-27
last_activity_desc: Added provider trace capture, Pi proof runner, and Terminal-Bench integration notes
progress:
  total_phases: 4
  completed_phases: 2
  total_plans: 9
  completed_plans: 4
  percent: 50
---

# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-06-27)

**Core value:** Give GSD/Pi a normal-looking model provider that adds second-model/multi-proposer judgment only when it is worth the latency/cost, while preserving safe single-writer tool execution.
**Current focus:** v1.1 — Full MoA Build-out and Dogfood Evaluation

## Current Position

Phase: 7 of 8 (Realistic Evaluation Task Suite and Rubric)
Plan: Not started
Status: Planning
Last activity: 2026-06-27 — Trace/proof harness completed for Pi and Terminal-Bench experiments

Progress: [█████░░░░░] 50%

## Performance Metrics

**Velocity:**

- Total plans completed: 1 in current milestone
- Average duration: -
- Total execution time: -

**By Phase:**

| Phase | Plans | Total | Avg/Plan |
|-------|-------|-------|----------|
| 5 | 1/1 | - | - |
| 6 | 3/3 | - | - |
| 7 | 0/2 | - | - |
| 8 | 0/3 | - | - |

**Recent Trend:**

- Last 5 plans: Phase 5 full MoA build-out complete; Phase 6 trace/proof harness complete
- Trend: Ready to move from plumbing to live benchmark evidence

*Updated after each plan completion*

## Accumulated Context

### Decisions

Decisions are logged in PROJECT.md Key Decisions table.
Recent decisions affecting current work:

- v1.0 shipped the provider prototype and archived phases 1–4.
- Use Factory Droid's local GPT-5.5 Codex proxy for primary calls when appropriate.
- Use Z.ai Coding Plan GLM-5.2 for reference/advisor/proposer/synthesis calls by default.
- Implement full MoA before testing based on expert review; testing now compares `single`, `advisor`, and `full_moa`.
- Preserve single-writer invariant: only final GPT gets tools.

### Pending Todos

- Install/configure Harbor if needed and run oracle smoke.
- Run first Terminal-Bench sample with `single` and `full_moa`.
- Define the human usefulness rubric for Terminal-Bench plus GSD skill tasks.

### Blockers/Concerns

- Live proof runs require Factory proxy availability and valid `FACTORY_GPT_API_KEY` / `ZAI_API_KEY`.
- Full MoA has higher latency/cost; proof needs judge whether quality justifies it.
- Need avoid benchmark theater; evidence should support a human decision about usefulness.
- Harbor custom agent currently assumes the gsd-moa extension path is visible inside the task container or a package version is installed.

## Notes

v1.0 archive lives in `.planning/milestones/`.
