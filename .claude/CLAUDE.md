<!-- GSD:project-start source:PROJECT.md -->

## Project

**GSD MoA Pi Provider**

A prototype Pi extension/package that adds a `gsd-moa` model provider implementing a Hermes-inspired Mixture-of-Agents (MoA) facade for agentic coding workflows. Pi and GSD see normal model IDs like `gsd-moa/gpt55-glm52-auto`, while the provider decides whether to call GPT-5.5 directly or first obtain tool-less GLM-5.2 advisory feedback before the final GPT-5.5 acting call.

The project starts as a local Pi package-shaped prototype, with a clean path to publish as a reusable Pi package and later extract into an OpenAI-compatible local proxy if cross-runtime portability is needed.

**Core Value:** Give GSD/Pi a normal-looking model provider that adds second-model judgment only when it is worth the latency/cost, while preserving safe single-writer tool execution.

### Constraints

- **Runtime**: Initial implementation targets Pi (`pi.dev`) extension/provider APIs — fastest path to prototype.
- **Package shape**: Code should be organized like a reusable Pi package (`pi-gsd-moa`) even while developed locally.
- **Tool safety**: Only final/acting calls can receive tools; advisor/reference calls must be tool-less and read-only.
- **Cost control**: Routing must be deterministic and cheap; do not call another LLM to decide whether to use MoA.
- **Latency control**: Default mode is effectively single/direct for normal turns; advisor is reserved for higher-leverage calls.
- **Testability**: Real upstream model calls must be replaceable by mocks/fakes in tests.
- **Configuration**: Primary and reference provider/model routes must be configurable in `.pi/gsd-moa.json`; v1 assumes GLM access through a Z.ai subscription.
- **Cache correctness**: Cache advisor outputs with prompt-versioned keys; avoid caching final tool-capable actions unless explicitly read-only in a future phase.

<!-- GSD:project-end -->

<!-- GSD:stack-start source:research/STACK.md -->

## Technology Stack

## Recommendation

## Primary Stack

| Layer | Recommendation | Rationale | Confidence |
|-------|----------------|-----------|------------|
| Runtime | Pi extension API | Pi supports custom providers and custom streaming through extensions. | High |
| Language | TypeScript | Native Pi extension format; loaded via jiti without precompile for local development. | High |
| Package shape | Pi package manifest in `package.json` with `pi.extensions` | Keeps project-local prototype publishable/reusable. | High |
| Provider registration | `pi.registerProvider("gsd-moa", { streamSimple, models })` | Official Pi custom provider surface. | High |
| Upstream delegation | `@earendil-works/pi-ai/compat` provider APIs where possible | Avoids rewriting provider serialization/streaming and preserves Pi compatibility. | Medium-High |
| Config | `.pi/gsd-moa.json` | Project-local, explicit primary/reference routes and cache settings. | High |
| Reference model route | Z.ai subscription via OpenAI-compatible protocol | User selected Z.ai subscription; Z.ai docs support OpenAI-compatible APIs and `glm-5.2`. | High |
| Cache storage | Project-local cache under `.pi/gsd-moa-cache/` or `.pi/cache/gsd-moa/` | Keeps cached advisor outputs local and easy to invalidate. | Medium |
| Tests | Node test runner/Vitest-compatible unit tests with fake stream clients | Provider orchestration must be testable without real model spend. | High |

## External Protocol Notes

- Pi custom providers can define `streamSimple(model, context, options)` and emit Pi assistant message stream events.
- Z.ai documents OpenAI SDK compatibility with base URL `https://api.z.ai/api/paas/v4/` for general API use and `https://api.z.ai/api/coding/paas/v4` for GLM Coding Plan subscription usage in supported tools.
- CLIProxyAPI is a future portability candidate because it exposes OpenAI/Gemini/Claude/Codex/Grok-compatible API interfaces for CLI model access, but it is not part of v1.

## What Not To Use First

- Do not start with a standalone proxy. It adds deployment/config burden before validating provider-layer value in Pi.
- Do not hand-roll all OpenAI/Z.ai serialization if Pi provider internals can be reused.
- Do not implement full MoA fan-out in v1; advisor mode is the cheaper, safer proving ground.

## Sources

- Pi custom provider docs: `/Users/macthedan/.nvm/versions/node/v24.16.0/lib/node_modules/@earendil-works/pi-coding-agent/docs/custom-provider.md`
- Pi extension docs: `/Users/macthedan/.nvm/versions/node/v24.16.0/lib/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md`
- Hermes MoA docs: https://hermes-agent.nousresearch.com/docs/user-guide/features/mixture-of-agents
- Hermes MoA loop source: https://github.com/NousResearch/hermes-agent/blob/main/agent/moa_loop.py
- Z.ai OpenAI SDK docs: https://docs.z.ai/guides/develop/openai/python
- Z.ai API introduction: https://docs.z.ai/api-reference/introduction
- Z.ai tool integration / coding endpoint: https://docs.z.ai/devpack/tool/others
- CLIProxyAPI README: https://github.com/router-for-me/CLIProxyAPI

<!-- GSD:stack-end -->

<!-- GSD:conventions-start source:CONVENTIONS.md -->

## Conventions

Conventions not yet established. Will populate as patterns emerge during development.
<!-- GSD:conventions-end -->

<!-- GSD:architecture-start source:ARCHITECTURE.md -->

## Architecture

Architecture not yet mapped. Follow existing patterns found in the codebase.
<!-- GSD:architecture-end -->

<!-- GSD:skills-start source:skills/ -->

## Project Skills

No project skills found. Add skills to any of: `.claude/skills/`, `.agents/skills/`, `.cursor/skills/`, `.github/skills/`, or `.codex/skills/` with a `SKILL.md` index file.
<!-- GSD:skills-end -->

<!-- GSD:workflow-start source:GSD defaults -->

## GSD Workflow Enforcement

Before using Edit, Write, or other file-changing tools, start work through a GSD command so planning artifacts and execution context stay in sync.

Use these entry points:

- `/gsd-quick` for small fixes, doc updates, and ad-hoc tasks
- `/gsd-debug` for investigation and bug fixing
- `/gsd-execute-phase` for planned phase work

Do not make direct repo edits outside a GSD workflow unless the user explicitly asks to bypass it.
<!-- GSD:workflow-end -->

<!-- GSD:profile-start -->

## Developer Profile

> Profile not yet configured. Run `/gsd-profile-user` to generate your developer profile.
> This section is managed by `generate-claude-profile` -- do not edit manually.
<!-- GSD:profile-end -->
