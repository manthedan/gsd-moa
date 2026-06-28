# pi-gsd-moa

Hermes-inspired MoA/advisor/router provider for upstream Pi and Pi-derived GSD workflows.

`pi-gsd-moa` registers a Pi custom provider named `gsd-moa`. The provider lets Pi select a normal model id while the provider decides whether to run a cheap single-writer primary call, a private GLM advisor pass, or a Hermes-style tool-less reference-model MoA layer before the final GPT acting call.

## Model Aliases

Use provider `gsd-moa` with one of these model ids:

| Model | Behavior |
|---|---|
| `gpt55-glm52-single` | Direct primary GPT-5.5 call. Fastest/cheapest. |
| `gpt55-glm52-advisor` | Tool-less GLM-5.2 advisor call, then final GPT-5.5 acting call with normal tools. |
| `gpt55-glm52-full` | Tool-less GLM-5.2 + GPT-5.5 reference fan-out, optional tool-less GPT-5.5 execution-memo synthesis layer, then final GPT-5.5 acting call with normal tools. |
| `gpt55-glm52-auto` | Deterministic policy chooses `single`, `advisor`, or `full_moa` from alias, markers, tool-loop state, and keywords. |

## Local Installation

From this repository:

```bash
npm install
npm run check
pi -a -e ./src/index.ts
```

Then select the provider/model in Pi, for example:

```text
/model gpt55-glm52-auto --provider gsd-moa
```

The package is intentionally shaped for publishing against upstream Pi (`@earendil-works/pi-*`): `package.json` declares the Pi extension entry under `pi.extensions`. For day-to-day local smoke tests, load `./src/index.ts` directly with `-e`.

## Configuration

Configuration is project-local at `.pi/gsd-moa.json`.

```json
{
  "primary": {
    "provider": "factory-codex",
    "model": "gpt-5.5",
    "api": "openai-completions",
    "baseUrl": "http://127.0.0.1:8317/v1",
    "apiKey": "$FACTORY_GPT_API_KEY",
    "compat": {
      "supportsDeveloperRole": false,
      "maxTokensField": "max_tokens"
    }
  },
  "reference": {
    "provider": "zai",
    "model": "glm-5.2",
    "api": "openai-completions",
    "baseUrl": "https://api.z.ai/api/coding/paas/v4",
    "apiKey": "$ZAI_API_KEY",
    "compat": {
      "thinkingFormat": "zai",
      "zaiToolStream": true,
      "supportsDeveloperRole": false,
      "maxTokensField": "max_tokens"
    }
  },
  "fullMoa": {
    "enabled": true,
    "proposers": [
      {
        "id": "glm52",
        "label": "GLM-5.2 reference"
      },
      {
        "id": "gpt55",
        "label": "GPT-5.5 reference",
        "route": {
          "provider": "factory-codex",
          "model": "gpt-5.5",
          "api": "openai-completions",
          "baseUrl": "http://127.0.0.1:8317/v1",
          "apiKey": "$FACTORY_GPT_API_KEY"
        }
      }
    ],
    "synthesis": {
      "enabled": true,
      "route": {
        "provider": "factory-codex",
        "model": "gpt-5.5",
        "api": "openai-completions",
        "baseUrl": "http://127.0.0.1:8317/v1",
        "apiKey": "$FACTORY_GPT_API_KEY"
      },
      "prompt": "Synthesize the reference responses into concise, actionable guidance for the final acting model. Focus on next steps, tool-use strategy, risks, and disagreements. Do not call tools or write patches."
    }
  },
  "trace": {
    "enabled": false,
    "dir": ".proof/traces",
    "includeContexts": true,
    "includeOutputs": true
  }
}
```

Set the Factory proxy key and Z.ai key before running locally:

```bash
export FACTORY_GPT_API_KEY=... # Factory Droid custom GPT-5.5 Codex-subscription route
export ZAI_API_KEY=...         # Factory Droid custom GLM-5.2 Z.ai Coding Plan route
```

You can extract them from `~/.factory/settings.json` without committing secrets.

The default primary route uses Factory Droid's local OpenAI-compatible Codex subscription proxy (`http://127.0.0.1:8317/v1`) for GPT-5.5. The default reference route uses Z.ai's GLM Coding Plan/OpenAI-compatible endpoint. If you are not using a Coding Plan subscription, change `baseUrl` to the general Z.ai endpoint your account supports.

## Routing Controls

Prompt markers can override the selected alias for a single turn:

| Marker | Effect |
|---|---|
| `<!-- gsd-moa:advisor -->` or `<!-- gsd-moa:on -->` | Force advisor mode. |
| `<!-- gsd-moa:full -->` or `<!-- gsd-moa:full_moa -->` | Force full MoA mode. |
| `<!-- gsd-moa:single -->` or `<!-- gsd-moa:off -->` | Force single mode. |

Markers are stripped before upstream model calls.

## Safety Model

- Reference/advisor/synthesizer calls receive no tool schemas, no tool calls, no tool results, and no system prompt from Pi.
- Only the final GPT acting call receives normal Pi tools.
- Upstream routes are validated so `gsd-moa` cannot call itself recursively.
- Tool-less reference outputs are cached; final tool-capable responses are never cached.

## Observability

Tracing is disabled for normal checked-in config. Set `GSD_MOA_TRACE=1` or use `npm run proof:pi` to opt in. When tracing is enabled, provider traces are written to the configured trace dir and linked from `gsd-moa.details.tracePath`. Exposed `thinking` blocks from upstream responses are preserved in trace files.

Final assistant messages include a `gsd-moa.details` diagnostic containing:

- selected mode and requested mode
- routing reason
- advisor/full-MoA cache hit/miss
- inner call provider/model details for reference-model, synthesizer, and primary calls
- combined current-turn usage

## Smoke Checklist

1. `npm run check` passes.
2. `pi -a -e ./src/index.ts --list-models gpt55-glm52` shows provider `gsd-moa` with the four aliases.
3. Selecting `gpt55-glm52-single` produces a normal streamed response.
4. Selecting `gpt55-glm52-advisor` with `ZAI_API_KEY` set runs a GLM advisor call and then a GPT final response.
5. Selecting `gpt55-glm52-full` runs GLM-5.2 and GPT-5.5 as tool-less private advisors, optional GPT-5.5 execution-memo synthesis, injects that private context as privileged guidance, adds a non-private execution note when tools are present, and then runs one GPT final response.
6. Tool calls, if any, come only from the final GPT call.

## Advisor and Full MoA Flows

See [`docs/ADVISOR-MODE.md`](docs/ADVISOR-MODE.md) for advisor mode, [`docs/FULL-MOA.md`](docs/FULL-MOA.md) for full reference-model MoA flow diagrams, [`docs/TERMINAL-BENCH.md`](docs/TERMINAL-BENCH.md) for the single-vs-full proof loop, and [`docs/EVALUATION.md`](docs/EVALUATION.md) for the human rubric plus current evidence snapshot.

## Future Work

See [`docs/FUTURE.md`](docs/FUTURE.md) for OpenAI-compatible proxy extraction and future hardening notes.
