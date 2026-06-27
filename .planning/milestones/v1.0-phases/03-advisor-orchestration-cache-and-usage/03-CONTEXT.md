# Phase 3: Advisor Orchestration, Cache, and Usage - Context

**Gathered:** 2026-06-27
**Status:** Ready for planning
**Mode:** Autonomous smart discuss

<domain>
## Phase Boundary

Add advisor mode end-to-end: run GLM-5.2 as a private, tool-less advisor; inject its guidance into the final GPT-5.5 call; cache advisor outputs; and report combined usage/details.

</domain>

<decisions>
## Implementation Decisions

- Advisor calls use the sanitized reference context from Phase 1 and explicitly set `tools: undefined`.
- Advisor completion uses the same injectable upstream adapter as primary streaming.
- Cache only advisor text/usage envelopes; final tool-capable responses are never cached.
- Cache hits should not add historical advisor usage to the current turn's combined usage.
- Attach MoA routing/cache/inner-call details as an assistant diagnostic with type `gsd-moa.details`.

</decisions>

<code_context>
## Existing Code Insights

Phase 2 added `streamGsdMoa()` and `UpstreamClient`. Phase 3 extends stream orchestration around those seams with advisor, cache, and usage modules.

</code_context>

<specifics>
## Specific Ideas

- Cache key includes prompt version, reference route, normalized context, and auto policy.
- `auto` remains limited to `single`/`advisor`.
- Final call receives the original context/tools plus advisor guidance appended to the system prompt.

</specifics>

<deferred>
## Deferred Ideas

- Rich live status events for advisor start/end.
- Full MoA proposal fan-out and synthesis.

</deferred>
