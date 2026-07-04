# Droid bare-harness control arm

`harbor_agents/droid_agent.py` runs Factory's `droid exec` as a Harbor installed agent. It is a **bare-harness control**: Droid drives plain `gpt-5.5` through the same CLIProxy OpenAI-compatible endpoint used by gsd-moa, but it bypasses the gsd-moa Pi/OMP provider entirely.

## What it measures

This arm isolates the benchmark result of:

```text
Factory Droid agent loop + CLIProxy + backend model
```

from the gsd-moa arm:

```text
Pi/OMP agent loop + gsd-moa provider orchestration + CLIProxy/backend models
```

Logs are written under `/logs/agent/droid/`:

```text
output.txt            # Droid stdout; requested as stream-json
output.stream-jsonl   # copy for later integrity scans
stderr.txt            # Droid stderr plus wrapper diagnostics
install.log           # installer/version/config log
prompt.txt            # exact prompt passed via droid exec -f
settings.json         # redacted copy of the custom-model config
```

## Effort caveat

Factory's current BYOK custom-model config uses `~/.factory/settings.json` with `customModels`. The documented custom-model fields do not include reasoning effort, and the Droid Exec docs currently say reasoning effort is not yet supported for custom models.

Therefore `DROID_REASONING_EFFORT` is accepted and logged, but the adapter does **not** pass `-r/--reasoning-effort` for the custom model. Treat this as measuring Droid at backend/default effort, comparable to a `GSD_MOA_EFFORT=none` control rather than the high-effort gsd-moa arm.

## Environment

Use `PI_GSD_MOA_ENV_FILE` for secrets; do not pass keys directly in Harbor argv.

Example `.proof/gsd-moa.env`:

```bash
FACTORY_API_KEY=replace-with-factory-api-key
CLIPROXY_API_KEY=replace-with-cliproxy-key
GSD_MOA_CODEX_BASE_URL=http://172.17.0.1:8318/v1
```

Non-secret controls:

```bash
DROID_MODEL=gpt-5.5                 # backend model sent through CLIProxy
DROID_AUTONOMY=high                 # low | medium | high; default high
DROID_REASONING_EFFORT=high         # logged only for custom models; see caveat
GSD_MOA_CODEX_BASE_URL=http://172.17.0.1:8318/v1
PI_GSD_MOA_ENV_FILE=/workspace/gsd-moa/.proof/gsd-moa.env
```

## Harbor run example

```bash
PYTHONPATH="$PWD${PYTHONPATH:+:$PYTHONPATH}" \
DROID_MODEL=gpt-5.5 \
DROID_AUTONOMY=high \
DROID_REASONING_EFFORT=high \
GSD_MOA_CODEX_BASE_URL=http://172.17.0.1:8318/v1 \
PI_GSD_MOA_ENV_FILE=/workspace/gsd-moa/.proof/gsd-moa.env \
harbor run \
  -d terminal-bench/terminal-bench-2 \
  --agent harbor_agents.droid_agent:DroidAgent \
  --mounts '[{"type":"bind","source":"'"$PWD"'","target":"/workspace/gsd-moa","read_only":true}]' \
  -n 1 -i terminal-bench/fix-git -y
```

## Follow-up

Integrity sweeps/aggregation do not scan Droid logs yet. Add `/logs/agent/droid/output.stream-jsonl` and/or `/logs/agent/droid/output.txt` to the aggregator's scan list before relying on this arm for contamination checks.

## Known risk pending live verification

`droid exec -m` with custom-model selectors has a reported rejection bug ([Factory-AI/factory#787](https://github.com/Factory-AI/factory/issues/787) — "only the current session default custom model works via --model"). The adapter passes `-m custom:GSD-MOA-Droid-Control-0`; if the runner smoke test hits the rejection, fall back to establishing the custom model as the session default (check `droid exec --help` / current settings schema on the installed version) and drop `-m`.
