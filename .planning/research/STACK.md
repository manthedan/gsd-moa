# Stack Research: GSD MoA Pi Provider

**Date:** 2026-06-27
**Domain:** Pi custom model provider / Hermes-inspired Mixture-of-Agents middleware

## Recommendation

Build the v1 prototype as a TypeScript Pi extension/package named `pi-gsd-moa` that registers a custom provider `gsd-moa` via `pi.registerProvider()` and supplies a custom `streamSimple` implementation.

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
