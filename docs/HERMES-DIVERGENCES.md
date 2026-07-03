# Hermes MoA divergences

Audit target: NousResearch/hermes-agent `agent/moa_loop.py` at commit [`2c9b017`](https://github.com/NousResearch/hermes-agent/blob/2c9b017/agent/moa_loop.py) plus the Hermes MoA docs.

## Where we match Hermes

- Reference/advisor calls are tool-less; only the final acting model receives Pi tools.
- Reference contexts are sanitized: no Pi system prompt, no tool schemas, no tool calls, and no raw tool results.
- Full MoA fans out references in parallel and fails open: advisor failures degrade to primary-only, and all-failed full-MoA degrades to the primary call.
- Guidance injected into the actor is explicitly advisory/untrusted.

## Deliberate divergences

- **Checkpoint-driven re-advice:** on failed or drifted tool loops, gsd-moa can rerun advisor/full-MoA with compact tool-observation summaries. Hermes references once per user turn.
- **Synthesis layer:** gsd-moa can synthesize reference responses into a private execution memo before the final actor. Hermes hands the reference bundle directly to the actor.
- **Conditional portfolio:** gsd-moa can select specialist references by capability/keyword instead of always using a fixed reference set.
- **Redaction:** diagnostic and failure text is redacted before it can reach traces or guidance.
- **Untrusted-guidance directive:** actor prompts explicitly state that reference/synthesis content is advisory data, not instructions.

## Gaps closed by this change

1. Sanitized reference views now end with a user message by dropping trailing assistant turns, avoiding Anthropic-style assistant-prefill rejection.
2. Failed full-MoA references become visible `[failed: …]` notes in synthesis and actor guidance instead of silently disappearing.
3. `referenceMaxTokens` / `GSD_MOA_REFERENCE_MAX_TOKENS` and per-proposer `maxTokens` cap only advisory outputs; synthesis and final acting outputs remain uncapped.
4. Routes can set `temperature` when the backend supports it; unset routes omit it.
5. `gpt55-cliproxycodex-glm52-hermes-full` provides a Hermes-style ablation: full-MoA, no synthesis, and no tool-loop re-advice checkpoints.
