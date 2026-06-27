# Feature Research: GSD MoA Pi Provider

**Date:** 2026-06-27

## Table Stakes

### Provider & Model Selection

- Register provider `gsd-moa` in Pi.
- Expose aliases:
  - `gpt55-glm52-single`
  - `gpt55-glm52-advisor`
  - `gpt55-glm52-auto`
- Make the provider appear in Pi model listing/model picker.

### Routing Modes

- `single`: direct primary GPT-5.5 call.
- `advisor`: GLM-5.2 tool-less advisory call, then GPT-5.5 final/tool-capable call with advice injected.
- `auto`: deterministic v1 router that chooses only `single` or `advisor`.

### Tool Safety

- Strip tools from reference/advisor calls.
- Preserve tools for final/acting primary call.
- Add recursion guard so `gsd-moa` never calls `gsd-moa` as an upstream provider.

### Configuration

- Project-local `.pi/gsd-moa.json` with primary/reference routes, mode defaults, cache config, prompt versions, and routing toggles.
- Z.ai subscription route for GLM-5.2 reference calls.

### Cache

- Cache advisor outputs by prompt version + normalized request/task context.
- Do not cache final tool-capable actions in v1.

### Usage & Observability

- Combine upstream usage/cost into the final assistant message.
- Preserve details about selected mode and inner calls for debugging.
- Provide status/trace information without leaking internal MoA markers upstream.

### Tests

- Unit-test mode selection.
- Unit-test tool stripping and final tool preservation.
- Unit-test advice injection.
- Unit-test advisor cache hit/miss.
- Unit-test recursion guard.
- Unit-test combined usage aggregation.

## Differentiators

- GSD-aware auto policy using markers such as `<!-- gsd-moa:advisor -->`, `<!-- gsd-moa:off -->`, or future workflow hints.
- Later `full_moa` mode for expensive proposal fan-out and synthesis.
- OpenAI-compatible local proxy extraction using CLIProxyAPI or a similar gateway.
- Rich interactive UI/status events for “Running GLM advisor…” and “Synthesizing with GPT…”.

## Anti-Features / Explicit Non-Goals

- Multi-writer tool execution.
- Tool schemas sent to advisor/reference calls.
- LLM-based router decision.
- Full MoA in v1.
- Workflow-specific branching inside GSD Core.
- Final response caching for mutable coding actions.

## Sources

- Hermes MoA docs: https://hermes-agent.nousresearch.com/docs/user-guide/features/mixture-of-agents
- Hermes MoA loop source: https://github.com/NousResearch/hermes-agent/blob/main/agent/moa_loop.py
- Pi custom provider docs: `/Users/macthedan/.nvm/versions/node/v24.16.0/lib/node_modules/@earendil-works/pi-coding-agent/docs/custom-provider.md`
