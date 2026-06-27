# Project Research Summary

**Date:** 2026-06-27
**Project:** GSD MoA Pi Provider

## Key Findings

### Stack

Use a TypeScript Pi extension/package (`pi-gsd-moa`) that registers a custom provider `gsd-moa` with `streamSimple`. Prefer Pi provider internals from `@earendil-works/pi-ai/compat` for upstream OpenAI/Z.ai-compatible calls, with a mockable adapter boundary for tests.

### Table Stakes

- Provider appears in Pi model selection.
- Aliases: `gpt55-glm52-single`, `gpt55-glm52-advisor`, `gpt55-glm52-auto`.
- v1 modes: single, advisor, auto.
- `auto` only chooses single/advisor in v1; it is not full MoA.
- Reference/advisor calls are tool-less.
- Final GPT-5.5 acting call preserves tools.
- Advisor cache avoids repeated GLM spend.
- Combined usage/cost is reported.
- `.pi/gsd-moa.json` configures primary/reference routes.
- GLM-5.2 reference route targets Z.ai subscription.

### Architecture

The provider should act as policy-aware middleware:

```text
Pi request → gsd-moa policy → optional cached GLM advisor → GPT final stream → Pi assistant response
```

Hermes' MoA pattern validates the core design: MoA is a virtual provider; reference models run first without tool schemas; the aggregator/acting model receives normal tools and owns the actual response/tool calls.

### Watch Outs

- Never send tools to reference models.
- Add recursion guard against `gsd-moa` upstreams.
- Do not use an LLM router.
- Do not cache final tool-capable actions.
- Be careful with Z.ai endpoint selection for subscription/coding-plan access.
- Avoid starting with CLIProxyAPI/proxy implementation before proving Pi provider value.

## Implications for Roadmap

1. Start with package/config/test scaffolding.
2. Implement deterministic policy and context sanitization first.
3. Build fake upstream streams before real provider calls.
4. Ship `single` pass-through before advisor mode.
5. Add advisor mode with cache and usage aggregation.
6. Finish with Pi smoke tests and docs.
7. Defer full MoA and CLIProxyAPI-compatible proxy to later phases.

## Sources

- Hermes MoA docs: https://hermes-agent.nousresearch.com/docs/user-guide/features/mixture-of-agents
- Hermes MoA source: https://github.com/NousResearch/hermes-agent/blob/main/agent/moa_loop.py
- Pi custom provider docs: `/Users/macthedan/.nvm/versions/node/v24.16.0/lib/node_modules/@earendil-works/pi-coding-agent/docs/custom-provider.md`
- Pi extension docs: `/Users/macthedan/.nvm/versions/node/v24.16.0/lib/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md`
- Z.ai OpenAI SDK docs: https://docs.z.ai/guides/develop/openai/python
- Z.ai API intro: https://docs.z.ai/api-reference/introduction
- Z.ai tool integration/coding endpoint: https://docs.z.ai/devpack/tool/others
- CLIProxyAPI README: https://github.com/router-for-me/CLIProxyAPI
