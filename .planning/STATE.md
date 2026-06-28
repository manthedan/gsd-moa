---
gsd_state_version: 1.0
milestone: v1.1
milestone_name: Full MoA Build-out and Dogfood Evaluation
current_phase: 7
current_phase_name: Realistic Evaluation Task Suite and Rubric
status: in_progress
stopped_at: First Harbor Terminal-Bench A/B proof completed on fix-git; ready for broader medium/hard evals and auto tuning
last_updated: "2026-06-28T05:25:00.000Z"
last_activity: 2026-06-28
last_activity_desc: Installed Harbor, passed oracle smoke, and ran single vs full_moa on terminal-bench/fix-git
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
Plan: First live A/B sample complete
Status: In progress
Last activity: 2026-06-28 — Harbor oracle smoke plus single/full_moa fix-git comparison completed

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

- Last 5 plans: Phase 5 full MoA build-out complete; Phase 6 trace/proof harness complete; first Terminal-Bench A/B smoke complete
- Trend: Initial evidence suggests full_moa adds latency/cost without benefit on easy tasks; needs harder review/debug samples

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

- Run a medium/hard Terminal-Bench review/debug sample where proposal diversity may matter.
- Define the human usefulness rubric for Terminal-Bench plus GSD skill tasks.
- Tune `auto` to avoid full_moa on easy tool-loop tasks unless the prompt merits it.

### Blockers/Concerns

- Live proof runs require Factory proxy availability and valid `FACTORY_GPT_API_KEY` / `ZAI_API_KEY`.
- Full MoA has higher latency/cost; proof needs judge whether quality justifies it.
- Need avoid benchmark theater; evidence should support a human decision about usefulness.
- Harbor custom agent now mounts/copies the repo into the task container and installs Node 24; local runs still require Factory proxy availability from Docker via `host.docker.internal`.
- Full-MoA tool-loop traces showed first-turn live proposer/synthesis calls and later cache hits; consider skipping advisory reruns after tool results or including tool-result state in cache policy.

## Notes

v1.0 archive lives in `.planning/milestones/`.
