# Requirements: GSD MoA Pi Provider

**Defined:** 2026-06-27
**Core Value:** Give GSD/Pi a normal-looking model provider that adds second-model judgment only when it is worth the latency/cost, while preserving safe single-writer tool execution.

## v1 Requirements

Requirements for the first Pi extension/package prototype.

### Package & Configuration

- [x] **PKG-01**: Developer can load the project-local Pi extension/package without modifying Pi core.
- [x] **PKG-02**: Provider `gsd-moa` appears with model aliases `gpt55-glm52-single`, `gpt55-glm52-advisor`, and `gpt55-glm52-auto`.
- [x] **PKG-03**: Developer can configure primary and reference routes in `.pi/gsd-moa.json`.
- [x] **PKG-04**: Configuration supports GPT-5.5 as primary and GLM-5.2 via Z.ai subscription as reference.
- [x] **PKG-05**: Invalid configuration fails fast with actionable errors, including a recursion guard against upstream provider `gsd-moa`.

### Policy & Context

- [x] **POL-01**: `single` mode always routes directly to the configured primary model.
- [x] **POL-02**: `advisor` mode always runs a reference/advisor call before the final primary call.
- [x] **POL-03**: `auto` mode uses deterministic heuristics to choose only `single` or `advisor` in v1.
- [x] **POL-04**: Explicit force/off markers can force advisor or single routing and are stripped before upstream model calls.
- [x] **CTX-01**: Reference/advisor context contains only advisory-safe user/assistant text and excludes tool results, tool calls, and tool schemas.
- [x] **CTX-02**: Final primary context preserves normal Pi tools and receives advisor guidance when advisor mode is active.

### Streaming & Provider Orchestration

- [x] **STR-01**: `streamSimple` emits Pi-compatible assistant stream events for text responses.
- [x] **STR-02**: Single mode streams the primary model response without unnecessary advisor latency.
- [x] **STR-03**: Advisor mode waits for cached/fresh GLM advice before streaming the final GPT response.
- [x] **STR-04**: Final GPT response can emit tool calls through Pi's normal tool loop.
- [x] **STR-05**: Provider handles upstream errors and abort signals with Pi-compatible error/abort messages.

### Cache & Usage

- [x] **CACHE-01**: Advisor outputs are cached using a key that includes prompt version, reference route, normalized task/context, and cache-relevant config.
- [x] **CACHE-02**: Repeated advisor requests with unchanged cache keys reuse cached GLM advice.
- [x] **CACHE-03**: v1 does not cache final tool-capable responses.
- [x] **USAGE-01**: Final assistant message reports combined token usage/cost for all upstream calls.
- [x] **USAGE-02**: Provider details expose selected mode, cache hit/miss, and inner call route metadata for debugging.

### Tests & Documentation

- [x] **TEST-01**: Unit tests cover mode selection, marker stripping, context sanitization, recursion guard, and config validation.
- [x] **TEST-02**: Unit tests use fake upstream streams to cover single/advisor orchestration without real model calls.
- [x] **TEST-03**: Unit tests verify advisor calls receive no tools and final calls preserve tools.
- [x] **TEST-04**: Unit tests verify advisor cache hit/miss behavior and combined usage aggregation.
- [x] **DOC-01**: Documentation explains setup, `.pi/gsd-moa.json`, Z.ai subscription routing, model aliases, and why `auto` is not `full_moa` in v1.
- [x] **DOC-02**: Documentation records the future path for `full_moa` and CLIProxyAPI/OpenAI-compatible proxy extraction.

## v2 Requirements

Deferred to a future milestone.

### Full MoA

- **MOA-01**: Provider supports proposal fan-out from GPT-5.5 and GLM-5.2 followed by synthesis.
- **MOA-02**: `auto` can choose full MoA only for rare high-leverage gates such as final signoff or hard failure recovery.

### Proxy Portability

- **PROXY-01**: MoA orchestration can run behind an OpenAI-compatible local proxy.
- **PROXY-02**: CLIProxyAPI integration is evaluated as a portability layer for non-Pi GSD runtimes.

### Rich Observability

- **OBS-01**: Provider exposes richer live status events for advisor and final phases when Pi supports them.
- **OBS-02**: Provider can export structured telemetry for budget dashboards.

## Out of Scope

| Feature | Reason |
|---------|--------|
| Full MoA in v1 | Advisor mode should prove value first with lower latency/cost. |
| Multiple tool-capable writers | Avoids conflicting tool calls, shell results, and patches. |
| LLM-based router | Defeats the cost goal; routing should be deterministic and cheap. |
| GSD Core workflow branching for MoA | Provider-layer abstraction keeps GSD portable and simple. |
| Blind final response caching | Tool-capable coding actions depend on mutable filesystem state. |
| Production local proxy in v1 | Pi extension prototype is the fastest validation path. |

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| PKG-01 | Phase 1 | Complete |
| PKG-02 | Phase 1 | Complete |
| PKG-03 | Phase 1 | Complete |
| PKG-04 | Phase 1 | Complete |
| PKG-05 | Phase 1 | Complete |
| POL-01 | Phase 1 | Complete |
| POL-02 | Phase 1 | Complete |
| POL-03 | Phase 1 | Complete |
| POL-04 | Phase 1 | Complete |
| CTX-01 | Phase 1 | Complete |
| CTX-02 | Phase 3 | Complete |
| STR-01 | Phase 2 | Complete |
| STR-02 | Phase 2 | Complete |
| STR-03 | Phase 3 | Complete |
| STR-04 | Phase 2 | Complete |
| STR-05 | Phase 2 | Complete |
| CACHE-01 | Phase 3 | Complete |
| CACHE-02 | Phase 3 | Complete |
| CACHE-03 | Phase 3 | Complete |
| USAGE-01 | Phase 3 | Complete |
| USAGE-02 | Phase 3 | Complete |
| TEST-01 | Phase 1 | Complete |
| TEST-02 | Phase 2 | Complete |
| TEST-03 | Phase 3 | Complete |
| TEST-04 | Phase 3 | Complete |
| DOC-01 | Phase 4 | Complete |
| DOC-02 | Phase 4 | Complete |

**Coverage:**

- v1 requirements: 27 total
- Mapped to phases: 27
- Unmapped: 0 ✓

---
*Requirements defined: 2026-06-27*
*Last updated: 2026-06-27 after initial definition*
