# Phase 1: Package, Config, and Policy Foundation - Context

**Gathered:** 2026-06-27
**Status:** Ready for planning
**Mode:** Autonomous smart discuss

<domain>
## Phase Boundary

Create the project-local Pi package skeleton, configuration schema/defaults, deterministic mode policy, recursion guard, marker stripping, and reference-safe context sanitizer.

</domain>

<decisions>
## Implementation Decisions

- Use a publishable package-shaped TypeScript extension named `pi-gsd-moa`.
- Keep provider id `gsd-moa` and expose aliases without the provider prefix in model ids.
- Use `.pi/gsd-moa.json` as the project-local config file.
- Default GLM reference route uses Z.ai coding endpoint with `$ZAI_API_KEY`.
- Make routing deterministic: fixed aliases plus marker/keyword heuristics for `auto`.
- Enforce recursion guard at config validation time.

</decisions>

<code_context>
## Existing Code Insights

The repo was planning-only. Pi custom provider docs define `pi.registerProvider()` and `streamSimple`; provider implementation will import Pi types from `@earendil-works/pi-ai/compat` and extension types from `@earendil-works/pi-coding-agent`.

</code_context>

<specifics>
## Specific Ideas

- Marker controls: `<!-- gsd-moa:advisor -->`, `<!-- gsd-moa:on -->`, `<!-- gsd-moa:single -->`, `<!-- gsd-moa:off -->`.
- Advisor context must exclude tools, tool calls, tool results, and system prompt.
- Keep pure functions independently testable before provider streaming work begins.

</specifics>

<deferred>
## Deferred Ideas

- Full MoA fan-out and synthesis.
- Local OpenAI-compatible proxy extraction.

</deferred>
