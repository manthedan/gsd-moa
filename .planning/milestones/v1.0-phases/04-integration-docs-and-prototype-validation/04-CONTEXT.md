# Phase 4: Integration Docs and Prototype Validation - Context

**Gathered:** 2026-06-27
**Status:** Ready for planning
**Mode:** Autonomous smart discuss

<domain>
## Phase Boundary

Document installation, configuration, model alias behavior, Z.ai routing, safety model, smoke testing, and future architecture notes for full MoA/proxy extraction.

</domain>

<decisions>
## Implementation Decisions

- Local smoke testing should load `./src/index.ts` with `pi -a -e`.
- The package remains publishable via `package.json` Pi metadata, but local docs prioritize direct extension loading.
- Document Z.ai Coding Plan endpoint by default and call out the general endpoint alternative.
- Capture future full MoA and CLIProxyAPI/OpenAI-compatible proxy extraction separately from v1 docs.

</decisions>

<code_context>
## Existing Code Insights

The implementation now has complete v1 single/advisor/auto provider logic and tests. Phase 4 adds README/docs and extension registration smoke validation.

</code_context>

<specifics>
## Specific Ideas

- README should include model aliases, config example, safety model, observability, and smoke checklist.
- Future notes should describe full MoA and proxy extraction without implying v1 support.

</specifics>

<deferred>
## Deferred Ideas

- Publishing automation.
- Live Pi end-to-end model call, blocked on real OpenAI/Z.ai credentials in the environment.

</deferred>
