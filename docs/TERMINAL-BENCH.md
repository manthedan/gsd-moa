# Terminal-Bench proof plan

Goal: compare plain GPT-5.5 (`gsd-moa/gpt55-glm52-single`) against full MoA (`gsd-moa/gpt55-glm52-full`) on identical Harbor / Terminal-Bench tasks, then tune `auto` against real task outcomes.

## Trace capture

Tracing is disabled in checked-in config for normal privacy. Proof runs opt in with `GSD_MOA_TRACE=1` or through `npm run proof:pi`.

```json
"trace": {
  "enabled": false,
  "dir": ".proof/traces",
  "includeContexts": true,
  "includeOutputs": true
}
```

Each provider call writes `.proof/traces/<run-id>.json` containing:

- selected policy/mode and reason
- redacted provider config
- input context
- proposer contexts and outputs, including exposed `thinking` blocks if upstream returns them
- synthesis context and output, including exposed `thinking` blocks if upstream returns them
- final primary context with injected MoA guidance
- compact primary stream events, including `thinking_delta` / `thinking_end`
- final assistant message, diagnostics, usage, cache status, and `tracePath`

Hidden chain-of-thought that the upstream API does not expose cannot be recovered. Exposed `thinking` blocks are preserved.

## Quick Pi comparison before Harbor

Use the local proof runner to compare one prompt through `single` and `full`:

```bash
npm run proof:pi -- \
  --prompt "Deeply review this repo's provider architecture and identify the highest-risk bug." \
  --models gsd-moa/gpt55-glm52-single,gsd-moa/gpt55-glm52-full
```

Artifacts are written to `.proof/runs/<timestamp>/`:

```text
prompt.md
manifest.json
SUMMARY.md
gsd-moa_gpt55-glm52-single/events.jsonl
gsd-moa_gpt55-glm52-single/summary.json
gsd-moa_gpt55-glm52-full/events.jsonl
gsd-moa_gpt55-glm52-full/summary.json
```

Provider traces are linked from `summary.json.moaDetails.tracePath` and live under each model run's `traces/` directory.

## Harbor / Terminal-Bench

Harbor docs recommend validating the install with the oracle first:

```bash
harbor run -d terminal-bench/terminal-bench-2 -a oracle
```

For a Pi custom agent, this repo includes a starter Harbor installed agent:

```text
harbor/pi_gsd_moa_agent.py
```

Example baseline run:

```bash
PI_GSD_MOA_MODEL=gsd-moa/gpt55-glm52-single \
PI_GSD_MOA_EXTENSION=/workspace/gsd-moa/src/index.ts \
harbor run \
  -d terminal-bench/terminal-bench-2 \
  --agent harbor.pi_gsd_moa_agent:PiGsdMoaAgent \
  -n 1
```

Example full-MoA run:

```bash
PI_GSD_MOA_MODEL=gsd-moa/gpt55-glm52-full \
PI_GSD_MOA_EXTENSION=/workspace/gsd-moa/src/index.ts \
harbor run \
  -d terminal-bench/terminal-bench-2 \
  --agent harbor.pi_gsd_moa_agent:PiGsdMoaAgent \
  -n 1
```

Notes:

- The Harbor agent assumes `PI_GSD_MOA_EXTENSION` resolves inside the task container. If Harbor does not mount this repo into the container, either mount it explicitly or install a published package version of `pi-gsd-moa` and point Pi at that extension.
- Pass `FACTORY_GPT_API_KEY`, `ZAI_API_KEY`, and `GSD_MOA_TRACE=1` through the Harbor environment without committing secrets.
- Keep initial runs small (`-n 1` or a selected task) until trace volume, cost, and latency are understood.

## Evaluation loop

1. Run one task with `single` and `full`.
2. Compare Harbor score/pass result.
3. Read Pi JSON events and `.proof/traces/*`.
4. Classify the outcome:
   - MoA helped: proposer/synthesis found a critical issue or improved tool plan.
   - MoA hurt: noisy guidance, wrong critique, too much latency/cost, or final model ignored useful guidance.
   - Implementation bug: wrong routing, cache issue, missing tools on final, leaked markers, missing trace.
5. Tune proposer prompts and `auto.fullMoaKeywords` / `auto.advisorKeywords`.
6. Repeat on a broader Terminal-Bench slice and GSD-skill dogfood tasks.
