# Phase 2: Single-Mode Provider Stream - Context

**Gathered:** 2026-06-27
**Status:** Ready for planning
**Mode:** Autonomous smart discuss

<domain>
## Phase Boundary

Register `gsd-moa` as a Pi provider and prove that single mode can stream primary-model responses through Pi-compatible events while preserving normal tool access.

</domain>

<decisions>
## Implementation Decisions

- Reuse Pi's `@earendil-works/pi-ai/compat` stream/complete adapters for real upstream calls.
- Keep the upstream adapter behind an injectable `UpstreamClient` so tests avoid real model spend.
- `gpt55-glm52-single` should perform exactly one primary call.
- Preserve `context.tools` unchanged for the final primary call.
- Normalize thrown upstream failures into Pi `error` events.

</decisions>

<code_context>
## Existing Code Insights

Phase 1 provided config loading, alias policy, and context helpers. Phase 2 extends those with `src/upstream.ts`, `src/stream.ts`, and `src/index.ts`.

</code_context>

<specifics>
## Specific Ideas

- Use `routeToModel()` to merge config routes with Pi builtin model metadata when available.
- Use `streamGsdMoa()` as both testable orchestration function and provider `streamSimple` registration.
- Tests should fake stream event sequences and assert forwarding/error behavior.

</specifics>

<deferred>
## Deferred Ideas

- Advisor orchestration, cache, and usage aggregation remain Phase 3.

</deferred>
