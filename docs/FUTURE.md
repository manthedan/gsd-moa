# Future Architecture Notes

## Full MoA

v1 deliberately ships `single`, `advisor`, and conservative `auto`. Full proposal fan-out is deferred until advisor mode proves useful.

A future `full_moa` mode should:

1. Run multiple tool-less proposal/reference calls.
2. Synthesize proposals with one final acting model.
3. Keep the single-writer invariant: only the final model receives tools.
4. Use strict budget/latency gates so `auto` selects full MoA only for rare high-leverage work such as final milestone audits, hard debugging failures, or security signoff.
5. Report every inner call in diagnostics and combined usage.

## CLIProxyAPI / OpenAI-Compatible Proxy Extraction

`router-for-me/CLIProxyAPI` remains a future portability candidate. The likely extraction path is:

1. Keep the current provider orchestration API (`UpstreamClient`) as the seam.
2. Move routing/advisor/cache logic behind an OpenAI-compatible `/chat/completions` or Responses-style endpoint.
3. Let Pi, GSD, or other coding agents target that endpoint as a normal OpenAI-compatible provider.
4. Preserve the same safety rules: reference calls are tool-less, final calls own tools, and `auto` is deterministic.

This should not be started until the Pi provider prototype has real workflow evidence that advisor mode is worth its latency/cost.

## Rich Status Events

If Pi gains provider-level progress/status events, `gsd-moa` can surface:

- `Running GLM advisor...`
- `Advisor cache hit/miss`
- `Synthesizing with GPT...`

Until then, status is recorded in final diagnostics rather than emitted as extra assistant text.
