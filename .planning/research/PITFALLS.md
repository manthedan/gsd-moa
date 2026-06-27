# Pitfalls Research: GSD MoA Pi Provider

**Date:** 2026-06-27

## Critical Pitfalls

### 1. Letting Reference Models Call Tools

**Risk:** Competing tool calls, conflicting edits, ambiguous shell results, and unsafe multi-writer behavior.

**Prevention:** Enforce `context.tools = undefined` for advisor/reference calls and test it directly.

**Phase:** First implementation phase.

### 2. Recursing Into `gsd-moa`

**Risk:** Advisor/final calls accidentally select `gsd-moa` as an upstream provider and recurse until failure.

**Prevention:** Validate config and runtime model selection; reject upstream provider `gsd-moa`.

**Phase:** Config/schema phase.

### 3. Rewriting Provider Serialization Poorly

**Risk:** Tool calls, images, reasoning, usage, aborts, and provider quirks break subtly.

**Prevention:** Reuse Pi provider internals where possible; isolate direct API code behind adapter interfaces.

**Phase:** Provider adapter phase.

### 4. Breaking Streaming Semantics

**Risk:** Pi expects ordered assistant message stream events. Bad event ordering can corrupt UI/session state.

**Prevention:** Start with `single` pass-through and fake stream tests before adding advisor orchestration.

**Phase:** Stream implementation phase.

### 5. Misleading Usage/Cost

**Risk:** GSD/Pi budget telemetry only sees the final call and underreports MoA spend.

**Prevention:** Aggregate usage from advisor + final calls and include detail metadata for inner calls.

**Phase:** Usage aggregation phase.

### 6. Overusing Advisor Mode

**Risk:** Latency/cost balloon; normal editing feels slow.

**Prevention:** Deterministic conservative auto policy; default to single for small edits and tool-loop continuations.

**Phase:** Auto policy phase.

### 7. Cache Key Too Broad or Too Narrow

**Risk:** Broad keys reuse stale advice; narrow keys miss all useful reuse.

**Prevention:** Include prompt version and normalized task/context/diff/failure digest; expose cache TTL/config.

**Phase:** Cache phase.

### 8. Z.ai Endpoint Confusion

**Risk:** General API endpoint vs Coding Plan endpoint affects subscription quota and compatibility.

**Prevention:** Document `.pi/gsd-moa.json` route settings and default v1 reference route for Z.ai subscription/coding endpoint as appropriate.

**Phase:** Config/docs phase.

### 9. Building Proxy Too Soon

**Risk:** More moving parts before proving advisor mode is useful.

**Prevention:** Keep CLIProxyAPI/OpenAI-compatible proxy as an architecture seam/future phase, not v1 implementation.

**Phase:** Roadmap scoping.

## Sources

- Hermes MoA docs: https://hermes-agent.nousresearch.com/docs/user-guide/features/mixture-of-agents
- Hermes MoA loop source: https://github.com/NousResearch/hermes-agent/blob/main/agent/moa_loop.py
- Z.ai tool integration docs: https://docs.z.ai/devpack/tool/others
- CLIProxyAPI README: https://github.com/router-for-me/CLIProxyAPI
