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

## v1.1 Requirements

Requirements for completing full MoA before the testing/proof milestone, then proving advisor/full-MoA usefulness before hardening.

### Full MoA Build-out

- [x] **MOA-01**: Provider supports tool-less multi-proposer fan-out before one final tool-capable primary call.
- [x] **MOA-02**: Provider supports an optional tool-less synthesis layer over proposer outputs.
- [x] **MOA-03**: Provider exposes a `gpt55-glm52-full` alias and explicit full-MoA markers.
- [x] **MOA-04**: `auto` can choose full MoA only for configured high-leverage keywords while tool-loop continuations stay single.
- [x] **MOA-05**: Diagnostics include proposer/synthesizer inner-call provider/model, usage, and cache hit/miss.

### Proof Harness

- [ ] **PROOF-01**: A local command/script runs live proof tasks through `gsd-moa` using the Factory GPT-5.5 proxy and Z.ai GLM-5.2 route.
- [ ] **PROOF-02**: Each proof task can run `gpt55-glm52-single`, `gpt55-glm52-advisor`, and `gpt55-glm52-full` against the same input.
- [ ] **PROOF-03**: Proof runs write durable artifacts under a gitignored run directory with prompts, outputs, diagnostics, latency, usage, cache hit/miss, and redacted config.

### Evaluation Tasks & Rubric

- [ ] **EVAL-01**: The proof suite includes realistic plan review, code review, debugging, architecture critique, and milestone audit tasks.
- [ ] **EVAL-02**: A human-review rubric scores whether advisor/full-MoA modes catch issues, improve recommendations, change final output usefully, and justify latency/cost.
- [ ] **EVAL-03**: The suite produces an aggregate summary explaining when advisor or full-MoA mode appears worth choosing over single mode.

### Safety & Observability

- [ ] **SAFE-01**: Proof artifacts demonstrate that GLM advisor/proposer/synthesizer calls remain tool-less and final GPT calls are the only tool-capable calls.
- [ ] **OBS-03**: Proof artifacts expose `gsd-moa.details` and route metadata sufficiently to debug advisor/full-MoA influence and cache behavior.
- [ ] **DOC-03**: Documentation includes current advisor-mode and full-MoA flow diagrams plus proof-harness usage instructions.

## v2 Requirements

Deferred to a future milestone.

### Proxy Portability

- **PROXY-01**: MoA orchestration can run behind an OpenAI-compatible local proxy.
- **PROXY-02**: CLIProxyAPI integration is evaluated as a portability layer for non-Pi GSD runtimes.

### Rich Observability

- **OBS-01**: Provider exposes richer live status events for advisor and final phases when Pi supports them.
- **OBS-02**: Provider can export structured telemetry for budget dashboards.

## Out of Scope

| Feature | Reason |
|---------|--------|
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
| MOA-01 | Phase 5 | Complete |
| MOA-02 | Phase 5 | Complete |
| MOA-03 | Phase 5 | Complete |
| MOA-04 | Phase 5 | Complete |
| MOA-05 | Phase 5 | Complete |
| PROOF-01 | Phase 6 | Planned |
| PROOF-02 | Phase 6 | Planned |
| PROOF-03 | Phase 6 | Planned |
| EVAL-01 | Phase 7 | Planned |
| EVAL-02 | Phase 7 | Planned |
| EVAL-03 | Phase 8 | Planned |
| SAFE-01 | Phase 8 | Planned |
| OBS-03 | Phase 8 | Planned |
| DOC-03 | Phase 8 | Planned |

**Coverage:**

- v1 requirements: 27 total, complete
- v1.1 requirements: 14 total, 5 complete and 9 mapped to planned phases
- Unmapped: 0 ✓

---
*Requirements defined: 2026-06-27*
*Last updated: 2026-06-27 after full MoA build-out*
