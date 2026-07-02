# Time-aware execution and async advisor

## Harness env contract

The harness may set these per task before streaming begins:

- `GSD_MOA_DEADLINE_EPOCH_MS` — absolute wall-clock deadline in epoch milliseconds.
- `GSD_MOA_BUDGET_MS` — total task budget `T` in milliseconds.

These are runtime inputs, not `.pi/gsd-moa.json` settings. Harbor agents should set them at task start; do not edit `harbor_agents/` for this provider-side integration.

If neither variable is set, or `timeAware.enabled` is false, provider behavior is unchanged. With only a deadline, the provider knows remaining time and uses `timeAware.minReserveMs` as the reserve floor. With both variables, it computes elapsed time and phase.

## Phase schedule

The default schedule follows the LemonHarness time-aware execution pattern (arXiv:2606.24311): surface elapsed/remaining budget to the model every turn and keep the work proportional to the phase.

| Phase | Cumulative budget | Strategy |
| --- | ---: | --- |
| Explore | 0–30% | inspection, planning, environment setup |
| Implement | 30–60% | primary solution construction |
| Validate | 60–90% | lock in the result; targeted verification only |
| Reserve | 90–100% | preserve output; do not start new state-changing actions; finalize |

A 5% grace band after each boundary reports the previous phase. Reserve handling still suppresses non-explicit advisor/full-MoA checkpoint runs when the remaining budget is below reserve.

## Async advisor

`asyncAdvisor` is experimental and default off:

```jsonc
{
  "asyncAdvisor": { "enabled": false, "maxPendingMs": 600000 }
}
```

When enabled, advisor checkpoints for tool-loop `failure` or `drift` scopes run in the background instead of blocking the current primary turn. A later matching turn injects the settled guidance, clears it, and starts a fresh background advisor. Failed background advisors are reported once in diagnostics and then replaced by a fresh background run.

The session key is `sha256(alias + first user-message text)`. Limitation: two concurrent sessions with identical opening user text and alias share a key; this is accepted for the experiment.

## Model limits

CLIProxy Codex route metadata for `gpt-5.5` now advertises `contextWindow: 272_000` and `maxTokens: 128_000`. This applies to the CLIProxy Codex aliases in `src/registry.ts` only; the Factory proxy metadata in `src/config.ts` is intentionally unchanged. Probe evidence against `127.0.0.1:8318` accepted a 192,814-token prompt, rejected about 275K tokens with `context_too_large`, and accepted `max_tokens: 999999` (apparently ignored/clamped upstream), matching a 272K input context and 128K output limit.
