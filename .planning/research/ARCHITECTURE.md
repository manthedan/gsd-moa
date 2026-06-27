# Architecture Research: GSD MoA Pi Provider

**Date:** 2026-06-27

## Recommended Architecture

```text
Pi agent harness
  ↓
Pi model registry/model picker
  ↓
gsd-moa provider extension
  ↓
Mode policy: single | advisor | auto
  ↓
Upstream call adapter(s)
  ├─ primary: GPT-5.5 via configured Pi/OpenAI route
  └─ reference: GLM-5.2 via Z.ai subscription route
```

## Components

### 1. Extension Entry Point

Registers provider `gsd-moa` with three models and a custom `streamSimple` implementation. Loads `.pi/gsd-moa.json` on startup/request.

### 2. Config Loader

Reads and validates project-local configuration. Supplies defaults for:

- primary provider/model
- reference provider/model
- alias-to-mode mapping
- auto policy
- cache settings
- prompt versions
- usage reporting options

### 3. Mode Policy

Pure deterministic function:

```ts
type MoaMode = "single" | "advisor";
function chooseMode(request): MoaMode
```

For v1:

- `*-single` forces single.
- `*-advisor` forces advisor.
- `*-auto` chooses single/advisor only.
- Explicit off marker forces single.
- Explicit advisor marker or plan/review/verification/security patterns choose advisor.
- Tool-loop continuations and small edits choose single.

### 4. Context Sanitizer

Builds a reference-safe message view:

- keep user/assistant text
- drop system prompt if desired for cost/privacy
- drop tool result messages
- drop tool calls
- drop tool schemas
- strip internal routing markers before upstream calls

This mirrors Hermes' reference-message strategy.

### 5. Advisor Runner

Calls GLM-5.2 through the configured Z.ai route with no tools. Produces short structured advice suitable for injection into the final call. Uses cache before spending tokens.

### 6. Final Runner

Calls GPT-5.5 through the configured primary route with normal Pi context and tools. In advisor mode, injects advisor guidance into the final prompt as private/contextual guidance.

### 7. Stream Orchestrator

Implements Pi `streamSimple` stream contract:

- single: proxy primary stream events through immediately.
- advisor: wait for cached/fresh advisor result, then stream primary final call.
- on error: emit Pi-compatible assistant error message.
- on completion: aggregate usage/cost and attach details.

### 8. Cache

Stores advisor output only. Key includes:

- mode
- reference provider/model
- advisor prompt version
- normalized latest task
- normalized relevant context/diff/failure digest when available
- config-relevant knobs

### 9. Tests / Fake Streams

Mock upstream stream functions should simulate:

- text completion
- tool call completion
- usage blocks
- errors
- aborts

## Build Order Implications

1. Package skeleton and config schema.
2. Mode policy and context sanitizer tests.
3. Fake upstream stream harness.
4. `single` mode provider pass-through.
5. `advisor` orchestration with advice injection.
6. Cache.
7. Usage/cost aggregation.
8. Pi model picker/manual smoke test.

## Sources

- Pi custom provider docs: `/Users/macthedan/.nvm/versions/node/v24.16.0/lib/node_modules/@earendil-works/pi-coding-agent/docs/custom-provider.md`
- Hermes MoA docs: https://hermes-agent.nousresearch.com/docs/user-guide/features/mixture-of-agents
- Hermes MoA loop source: https://github.com/NousResearch/hermes-agent/blob/main/agent/moa_loop.py
