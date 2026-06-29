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
- reference contexts and outputs, including exposed `thinking` blocks if upstream returns them
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
  --models gsd-moa/gpt55-glm52-single,gsd-moa/gpt55-glm52-full \
  --no-tools
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

For a Pi custom agent, this repo includes a Harbor installed agent adapted from the plain-Pi adapter shape in `badlogic/pi-terminal-bench`:

```text
harbor_agents/pi_gsd_moa_agent.py
```

It writes Pi logs and an ATIF trajectory under Harbor's mounted agent log directory:

```text
/logs/agent/trajectory.json              # Harbor ATIF-v1.7 trajectory
/logs/agent/pi-gsd-moa/pi-output.jsonl   # canonical Pi JSON stream
/logs/agent/pi-gsd-moa/events.jsonl      # backwards-compatible copy
/logs/agent/pi-gsd-moa/session.jsonl     # Pi session log
/logs/agent/pi-gsd-moa/stderr.txt
/logs/agent/pi-gsd-moa/traces/*.json
```

Example baseline run:

```bash
PYTHONPATH="$PWD${PYTHONPATH:+:$PYTHONPATH}" \
PI_GSD_MOA_MODEL=gsd-moa/gpt55-glm52-single \
PI_GSD_MOA_REPO=/workspace/gsd-moa \
GSD_MOA_PRIMARY_BASE_URL=http://host.docker.internal:8317/v1 \
harbor run \
  -d terminal-bench/terminal-bench-2 \
  --agent harbor_agents.pi_gsd_moa_agent:PiGsdMoaAgent \
  --mounts '[{"type":"bind","source":"'"$PWD"'","target":"/workspace/gsd-moa","read_only":true}]' \
  -n 1 -i terminal-bench/fix-git -y
```

Example full-MoA run:

```bash
PYTHONPATH="$PWD${PYTHONPATH:+:$PYTHONPATH}" \
PI_GSD_MOA_MODEL=gsd-moa/gpt55-glm52-full \
PI_GSD_MOA_REPO=/workspace/gsd-moa \
GSD_MOA_PRIMARY_BASE_URL=http://host.docker.internal:8317/v1 \
harbor run \
  -d terminal-bench/terminal-bench-2 \
  --agent harbor_agents.pi_gsd_moa_agent:PiGsdMoaAgent \
  --mounts '[{"type":"bind","source":"'"$PWD"'","target":"/workspace/gsd-moa","read_only":true}]' \
  -n 1 -i terminal-bench/fix-git -y
```

Notes:

- The Harbor agent copies `PI_GSD_MOA_REPO` from the mounted path into `/tmp/gsd-moa-ext`, excluding `.proof`, `.git`, `node_modules`, and `.pi/gsd-moa-cache`; then it installs Node 24 plus package deps and loads `/tmp/gsd-moa-ext/src/index.ts` as the Pi extension.
- The agent writes `agent/trajectory.json` in ATIF-v1.7 format. Parent steps capture user/assistant/tool-result flow; gsd-moa proposer/synthesizer calls are represented as embedded `subagent_trajectories`. When trace files are available, those subagent trajectories include copied input context and inner output text; otherwise they fall back to metadata-only diagnostics.
- The agent populates Harbor token/cache/cost context from Pi `message_end` events, following the same broad approach as `pi-terminal-bench`. The final gsd-moa assistant usage already includes inner reference/synthesis model usage.
- Docker runs should use `GSD_MOA_PRIMARY_BASE_URL=http://host.docker.internal:8317/v1` for the Factory proxy.
- The Factory GPT-5.5 primary route is usually a local proxy and may accept a dummy key; the default GLM-5.2 reference route calls Z.ai directly and needs a real `ZAI_API_KEY` unless you redirect it to a proxy.
- Avoid putting real keys directly in long-running process arguments. The Harbor agent supports `PI_GSD_MOA_ENV_FILE` so secrets can be sourced inside the task container instead of passed as `docker compose exec -e KEY=value` arguments.
- Keep initial runs small (`-n 1` and `-l 1`, or a selected task) until trace volume, cost, and latency are understood.

Preferred secret setup for Harbor:

```bash
mkdir -p .proof
chmod 700 .proof
cat > .proof/gsd-moa.env <<'EOF'
FACTORY_GPT_API_KEY=dummy-not-used
ZAI_API_KEY=replace-with-real-zai-key
GSD_MOA_TRACE=1
GSD_MOA_PRIMARY_BASE_URL=http://host.docker.internal:8317/v1
EOF
chmod 600 .proof/gsd-moa.env
```

Then run Harbor with only the file path in the parent environment:

```bash
PI_GSD_MOA_ENV_FILE=/workspace/gsd-moa/.proof/gsd-moa.env \
PI_GSD_MOA_MODEL=gsd-moa/gpt55-glm52-full \
harbor run ...
```

The repo mount already maps local `.proof/gsd-moa.env` to `/workspace/gsd-moa/.proof/gsd-moa.env`; `.proof/` is gitignored. The Harbor agent copies this file inside the task container, changes ownership to the agent user, and keeps it owner-readable only before sourcing it, so host-side `0600` permissions are okay even when the container agent UID differs from the host UID.

## Current results

See [`TERMINAL-BENCH-RESULTS.md`](TERMINAL-BENCH-RESULTS.md) for the current A/B evidence snapshot. As of 2026-06-28, the strongest non-multimodal MoA wins are `torch-tensor-parallelism` and `overfull-hbox`: single GPT-5.5 failed both one-trial runs, while current Hermes-aligned full-MoA passed both.

## Evaluation loop

See [`EVALUATION.md`](EVALUATION.md) for the human rubric and current sanitized evidence snapshot.

1. Run one task with `single` and `full`.
2. Compare Harbor score/pass result.
3. Read `agent/trajectory.json`, Pi JSON events, and `pi-gsd-moa/traces/*` from the Harbor trial artifacts.
4. Classify the outcome:
   - MoA helped: reference/synthesis found a critical issue or improved tool plan.
   - MoA hurt: noisy guidance, wrong critique, too much latency/cost, or final model ignored useful guidance.
   - Implementation bug: wrong routing, cache issue, missing tools on final, leaked markers, missing trace.
5. Tune reference portfolio, synthesis prompt, and `auto.fullMoaKeywords` / `auto.advisorKeywords`.
6. Repeat on a broader Terminal-Bench slice and GSD-skill dogfood tasks.
