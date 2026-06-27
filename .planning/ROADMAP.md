# Roadmap: GSD MoA Pi Provider

## Overview

Build the provider from the inside out: first establish the package/config foundation and deterministic policy, then prove Pi provider streaming with mockable upstream calls, then add advisor orchestration with safe tool boundaries, caching, and usage aggregation, and finally harden the prototype with docs and a Pi smoke-test path. The roadmap uses vertical MVP slices so each phase leaves the provider more runnable and verifiable.

## Phases

**Phase Numbering:**

- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

Decimal phases appear between their surrounding integers in numeric order.

- [x] **Phase 1: Package, Config, and Policy Foundation** - Create the Pi package skeleton, config schema, deterministic router, context sanitizer, and foundational tests. (completed 2026-06-27)
- [x] **Phase 2: Single-Mode Provider Stream** - Register the `gsd-moa` provider and prove single-mode primary streaming/tool-call pass-through with fake upstreams. (completed 2026-06-27)
- [x] **Phase 3: Advisor Orchestration, Cache, and Usage** - Add GLM advisor orchestration, advice injection, advisor cache, tool-safety enforcement, and combined usage reporting. (completed 2026-06-27)
- [ ] **Phase 4: Integration Docs and Prototype Validation** - Document setup and run the local Pi extension smoke path, with future `full_moa`/proxy notes captured.

## Phase Details

### Phase 1: Package, Config, and Policy Foundation

**Goal**: A local, package-shaped Pi extension foundation exists with validated config, mode routing, safe context preparation, and unit tests.
**Mode:** mvp
**Depends on**: Nothing (first phase)
**Requirements**: [PKG-01, PKG-02, PKG-03, PKG-04, PKG-05, POL-01, POL-02, POL-03, POL-04, CTX-01, TEST-01]
**Success Criteria** (what must be TRUE):

  1. Developer can load the project-local package/extension skeleton without Pi core changes.
  2. `.pi/gsd-moa.json` is parsed, defaulted, and validated with actionable errors.
  3. Deterministic policy maps aliases and markers to v1 modes (`single` or `advisor`) without LLM routing.
  4. Reference-safe context generation strips tools/tool transcript while preserving useful user/assistant text.
  5. Tests cover config validation, recursion guard, mode selection, marker stripping, and context sanitization.

**Plans**: 3 plans

Plans:

- [x] 01-01: Create package skeleton, extension entry, config schema, and defaults.
- [x] 01-02: Implement deterministic mode policy, marker stripping, and recursion/config guards.
- [x] 01-03: Implement reference-safe context sanitizer and foundational unit tests.

### Phase 2: Single-Mode Provider Stream

**Goal**: `gsd-moa` can act as a Pi provider in single mode, streaming a primary GPT-compatible response and preserving normal Pi tool behavior.
**Mode:** mvp
**Depends on**: Phase 1
**Requirements**: [STR-01, STR-02, STR-04, STR-05, TEST-02]
**Success Criteria** (what must be TRUE):

  1. Pi model registry can see/select the `gsd-moa` aliases.
  2. `gpt55-glm52-single` streams fake and real-adapter primary responses through Pi-compatible stream events.
  3. Final primary calls receive normal Pi tools and can emit tool calls through Pi's normal loop.
  4. Upstream errors and aborts become Pi-compatible assistant error/abort messages.
  5. Fake upstream stream tests prove text, tool-call, usage, error, and abort paths without real model spend.

**Plans**: 2 plans

Plans:

- [x] 02-01: Register provider/models and implement fake upstream stream harness plus single-mode pass-through.
- [x] 02-02: Add primary adapter integration, tool-call preservation, and error/abort handling tests.

### Phase 3: Advisor Orchestration, Cache, and Usage

**Goal**: Advisor mode safely runs GLM-5.2 without tools, injects cached/fresh advice into the GPT-5.5 final call, and reports combined usage/cost.
**Mode:** mvp
**Depends on**: Phase 2
**Requirements**: [CTX-02, STR-03, CACHE-01, CACHE-02, CACHE-03, USAGE-01, USAGE-02, TEST-03, TEST-04]
**Success Criteria** (what must be TRUE):

  1. `gpt55-glm52-advisor` runs a tool-less GLM reference/advisor call before the final GPT call.
  2. `gpt55-glm52-auto` chooses advisor only for deterministic high-leverage triggers and otherwise stays single.
  3. Advisor output is cached by prompt version, reference route, normalized task/context, and cache-relevant config.
  4. Final GPT call receives advisor guidance and normal tools; reference/advisor calls receive no tools.
  5. Final assistant message includes combined usage/cost and details for mode, cache hit/miss, and inner routes.

**Plans**: 3 plans

Plans:

- [x] 03-01: Implement advisor runner, prompt versioning, advice shape, and advice injection.
- [x] 03-02: Implement advisor cache key/storage/TTL and no-final-action-cache safeguards.
- [x] 03-03: Aggregate usage/cost/details and test advisor tool-safety, cache behavior, and auto routing.

### Phase 4: Integration Docs and Prototype Validation

**Goal**: The prototype is documented and validated as a local Pi extension/package with clear setup, Z.ai routing, model alias semantics, and future expansion notes.
**Mode:** mvp
**Depends on**: Phase 3
**Requirements**: [DOC-01, DOC-02]
**Success Criteria** (what must be TRUE):

  1. Documentation explains installing/loading the local Pi package-shaped extension.
  2. Documentation includes a complete `.pi/gsd-moa.json` example for GPT-5.5 primary and Z.ai GLM-5.2 reference routing.
  3. Documentation explains `single`, `advisor`, and `auto`, including why v1 `auto` is not `full_moa`.
  4. Documentation records future `full_moa` and CLIProxyAPI/OpenAI-compatible proxy extraction paths.
  5. A local smoke checklist verifies provider selection and basic single/advisor behavior.

**Plans**: 2 plans

Plans:

- [ ] 04-01: Write setup/config/model-alias documentation and local smoke checklist.
- [ ] 04-02: Capture future full MoA/proxy architecture notes and final prototype validation evidence.

## Progress

**Execution Order:**
Phases execute in numeric order: 1 → 2 → 3 → 4

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Package, Config, and Policy Foundation | 3/3 | Complete | 2026-06-27 |
| 2. Single-Mode Provider Stream | 2/2 | Complete | 2026-06-27 |
| 3. Advisor Orchestration, Cache, and Usage | 3/3 | Complete | 2026-06-27 |
| 4. Integration Docs and Prototype Validation | 0/2 | Not started | - |
