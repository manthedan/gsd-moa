# GSD MoA Pi Provider

## What This Is

A prototype Pi extension/package that adds a `gsd-moa` model provider implementing a Hermes-inspired Mixture-of-Agents (MoA) facade for agentic coding workflows. Pi and GSD see normal model IDs like `gsd-moa/gpt55-glm52-auto`, while the provider decides whether to call GPT-5.5 directly or first obtain tool-less GLM-5.2 advisory feedback before the final GPT-5.5 acting call.

The project starts as a local Pi package-shaped prototype, with a clean path to publish as a reusable Pi package and later extract into an OpenAI-compatible local proxy if cross-runtime portability is needed.

## Core Value

Give GSD/Pi a normal-looking model provider that adds second-model judgment only when it is worth the latency/cost, while preserving safe single-writer tool execution.

## Current Milestone: v1.1 Useful Proof / Dogfood Evaluation

**Goal:** Prove `gsd-moa` is useful on real Pi/GSD work before hardening or publishing.

**Target features:**
- A repeatable live proof harness that runs `single` vs `advisor` on realistic coding-agent tasks.
- Trace artifacts that show route, latency, usage, cache behavior, and advisor influence without leaking secrets.
- A human-readable summary that answers when advisor mode is worth the extra latency/cost.

## Requirements

### Validated

- [x] v1.0 shipped a local Pi provider prototype with `single`, `advisor`, and `auto` aliases.
- [x] v1.0 enforced the single-writer tool policy: GLM advisor calls are tool-less; final GPT calls keep Pi tools.
- [x] v1.0 proved Factory GPT-5.5 proxy + Z.ai GLM-5.2 routes can work together locally.

### Active

- [ ] Build a proof harness that can run live `single` and `advisor` comparisons through the configured Factory/Z.ai proxy routes.
- [ ] Capture per-run artifacts that are useful for judgment: prompts, outputs, diagnostics, usage, latency, cache hit/miss, and redacted config.
- [ ] Include realistic GSD/Pi tasks where advisor mode should plausibly matter: plan review, code review, debugging, architecture critique, and milestone audit.
- [ ] Provide a scoring/review rubric focused on usefulness, not benchmark theater.
- [ ] Produce an aggregated proof summary that says when `gpt55-glm52-advisor` appears worth using over `single`.

### Out of Scope

- Hardening/publishing before proof of usefulness.
- Leaderboard-style benchmarking or fake statistical precision.
- Full MoA fan-out/synthesis.
- Additional autonomous tool-capable writers.
- Sending secrets into proof artifacts.

## Context

The design is inspired by Nous Research Hermes MoA, specifically the pattern where reference models run first without tool schemas and the aggregator/final model receives the actionable context and tool schema. For agentic coding, this becomes a provider-layer middleware rather than a workflow-layer feature.

The intended stack is Pi's extension/provider API:

- Pi extensions can register providers via `pi.registerProvider()`.
- Custom provider implementations can supply `streamSimple(model, context, options)`.
- Pi already has provider compatibility helpers in `@earendil-works/pi-ai/compat`, including built-in streaming implementations such as OpenAI Responses/Completions and Anthropic Messages.
- The prototype should prefer delegation to those internals where feasible and should isolate the MoA policy/orchestration logic from provider-specific serialization.

The working mental model:

```text
Pi / GSD agent harness
  ↓
gsd-moa provider facade
  ↓
policy: single | advisor | auto
  ↓
upstream calls:
  - single: GPT-5.5 only
  - advisor: GLM-5.2 tool-less critique → GPT-5.5 final acting call
```

The provider aliases should be:

- `gsd-moa/gpt55-glm52-single` — force direct GPT-5.5 call.
- `gsd-moa/gpt55-glm52-advisor` — force GLM advisor then GPT final.
- `gsd-moa/gpt55-glm52-auto` — deterministic router; v1 chooses `single` or `advisor`, never full MoA.

`auto` means “choose the cheapest useful available mode,” not “run the most expensive MoA.” Later, after full MoA exists, `auto` may choose it only for rare gates like final signoff or hard failure recovery.

Potential future portability path:

```text
runtime / harness
  model: gsd-moa/gpt55-glm52-auto
  base_url: http://localhost:8787/v1
      ↓
local MoA gateway / CLIProxyAPI-compatible proxy
      ↓
OpenAI GPT-5.5
Z.ai / OpenRouter GLM-5.2
```

## Constraints

- **Runtime**: Initial implementation targets Pi (`pi.dev`) extension/provider APIs — fastest path to prototype.
- **Package shape**: Code should be organized like a reusable Pi package (`pi-gsd-moa`) even while developed locally.
- **Tool safety**: Only final/acting calls can receive tools; advisor/reference calls must be tool-less and read-only.
- **Cost control**: Routing must be deterministic and cheap; do not call another LLM to decide whether to use MoA.
- **Latency control**: Default mode is effectively single/direct for normal turns; advisor is reserved for higher-leverage calls.
- **Testability**: Real upstream model calls must be replaceable by mocks/fakes in tests.
- **Configuration**: Primary and reference provider/model routes must be configurable in `.pi/gsd-moa.json`; v1 assumes GLM access through a Z.ai subscription.
- **Cache correctness**: Cache advisor outputs with prompt-versioned keys; avoid caching final tool-capable actions unless explicitly read-only in a future phase.

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Implement MoA below GSD Core in the Pi provider layer | GSD should keep seeing a normal model ID; provider middleware is the clean abstraction for routing/fan-out. | — Pending |
| Prototype as a Pi package-shaped extension | Faster iteration than a proxy, while keeping reuse/publishability. | — Pending |
| Provider id is `gsd-moa`; package name is `pi-gsd-moa` | Clear model IDs and package identity. | — Pending |
| v1 supports `single`, `advisor`, and `auto`; defers `full_moa` | Advisor likely captures most value with lower latency/cost than full proposal synthesis. | — Pending |
| `auto` routes only between `single` and `advisor` in v1 | Keeps auto cheap and predictable; full MoA can be added later. | — Pending |
| Only final GPT-5.5 call can use tools | Prevents dueling tool calls, conflicting patches, and complex merge semantics. | — Pending |
| Reuse Pi provider internals where possible | Avoid duplicating provider serialization/streaming logic and stay compatible with Pi's model registry. | — Pending |
| Use project-local `.pi/gsd-moa.json`, not env-only config | Enables primary/reference route configuration and future package usability. | — Pending |
| Route v1 GLM reference calls through a Z.ai subscription | Matches the expected available GLM-5.2 access path for the prototype. | — Pending |
| Keep CLIProxyAPI/OpenAI-compatible proxy as future path | Useful for cross-runtime GSD, but premature for the first Pi prototype. | — Pending |
| Prove usefulness before hardening | Passing tests and smoke checks is insufficient; need dogfood evidence that advisor mode improves real work. | Active in v1.1 |

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition** (via `/gsd-transition`):
1. Requirements invalidated? → Move to Out of Scope with reason
2. Requirements validated? → Move to Validated with phase reference
3. New requirements emerged? → Add to Active
4. Decisions to log? → Add to Key Decisions
5. "What This Is" still accurate? → Update if drifted

**After each milestone** (via `/gsd-complete-milestone`):
1. Full review of all sections
2. Core Value check — still the right priority?
3. Audit Out of Scope — reasons still valid?
4. Update Context with current state

---
*Last updated: 2026-06-27 starting v1.1 useful proof milestone*
