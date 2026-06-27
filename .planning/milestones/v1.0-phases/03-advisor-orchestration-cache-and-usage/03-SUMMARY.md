# Phase 3 Summary: Advisor Orchestration, Cache, and Usage

## Status
Complete.

## Delivered
- Tool-less GLM advisor runner with private advisor prompt.
- Advisor guidance injection into the final GPT call.
- Advisor-only file cache with TTL and cache key based on prompt version, route, normalized context, and policy config.
- Combined current-turn usage aggregation for fresh advisor + primary calls.
- `gsd-moa.details` diagnostics with mode, reason, cache hit/miss, and inner call routes.
- Tests for advisor safety, final tool preservation, cache reuse, combined usage, and auto routing.

## Verification
- `npm run check` passed.

## Next
Phase 4 should document installation/configuration, model alias semantics, smoke testing, and future full MoA/proxy paths.
