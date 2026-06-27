# Future Architecture Notes

## Full MoA Hardening

`gpt55-glm52-full` now implements tool-less multi-proposer fan-out, optional tool-less synthesis, and one final tool-capable acting call. Future hardening should focus on:

1. Budget and latency gates so `auto` selects full MoA only for high-leverage work.
2. More configurable proposer portfolios, including optional heterogeneous routes.
3. Better per-inner-call status reporting if Pi exposes provider progress events.
4. Proof artifacts that show when full MoA beats advisor mode enough to justify cost.
5. Optional output-shape contracts for planner/reviewer/debugger use cases.

The single-writer invariant should remain non-negotiable: proposers and synthesizers advise only; final primary owns tools.

## CLIProxyAPI / OpenAI-Compatible Proxy Extraction

`router-for-me/CLIProxyAPI` remains a future portability candidate. The likely extraction path is:

1. Keep the current provider orchestration API (`UpstreamClient`) as the seam.
2. Move routing/advisor/cache/full-MoA logic behind an OpenAI-compatible `/chat/completions` or Responses-style endpoint.
3. Let Pi, GSD, or other coding agents target that endpoint as a normal OpenAI-compatible provider.
4. Preserve the same safety rules: reference calls are tool-less, final calls own tools, and `auto` is deterministic.

This should not be started until the Pi provider prototype has real workflow evidence that advisor/full-MoA modes are worth their latency/cost.

## Rich Status Events

If Pi gains provider-level progress/status events, `gsd-moa` can surface:

- `Running GLM advisor...`
- `Running full MoA proposers...`
- `Advisor/proposer cache hit/miss`
- `Synthesizing proposal bundle...`
- `Streaming final GPT response...`

Until then, status is recorded in final diagnostics rather than emitted as extra assistant text.
