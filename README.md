# pi-gsd-moa

Hermes-inspired advisor/router provider for upstream Pi and Pi-derived GSD workflows.

`pi-gsd-moa` registers a Pi custom provider named `gsd-moa`. The provider lets Pi select a normal model id while the provider decides whether to run a cheap single-writer primary call or a private GLM advisor pass before the final GPT acting call. v1 is MoA-inspired advisor mode, not full multi-proposal MoA fan-out.

## Model Aliases

Use provider `gsd-moa` with one of these model ids:

| Model | Behavior |
|---|---|
| `gpt55-glm52-single` | Direct primary GPT-5.5 call. Fastest/cheapest. |
| `gpt55-glm52-advisor` | Tool-less GLM-5.2 advisor call, then final GPT-5.5 acting call with normal tools. |
| `gpt55-glm52-auto` | Deterministic v1 policy chooses `single` or `advisor`; it never chooses full MoA in v1. |

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
| `<!-- gsd-moa:single -->` or `<!-- gsd-moa:off -->` | Force single mode. |

Markers are stripped before upstream model calls.

## Safety Model

- GLM reference/advisor calls receive no tool schemas, no tool calls, no tool results, and no system prompt from Pi.
- Only the final GPT acting call receives normal Pi tools.
- Upstream routes are validated so `gsd-moa` cannot call itself recursively.
- v1 caches advisor text only; final tool-capable responses are never cached.

## Observability

Final assistant messages include a `gsd-moa.details` diagnostic containing:

- selected mode and requested mode
- routing reason
- advisor cache hit/miss
- inner call provider/model details
- combined current-turn usage

## Smoke Checklist

1. `npm run check` passes.
2. `pi -a -e ./src/index.ts --list-models gpt55-glm52` shows provider `gsd-moa` with the three aliases.
3. Selecting `gpt55-glm52-single` produces a normal streamed response.
4. Selecting `gpt55-glm52-advisor` with `ZAI_API_KEY` set runs a GLM advisor call and then a GPT final response.
5. Tool calls, if any, come only from the final GPT call.

## Advisor Flow

See [`docs/ADVISOR-MODE.md`](docs/ADVISOR-MODE.md) for the current advisor-mode sequence and safety boundary diagram.

## Future Work

See [`docs/FUTURE.md`](docs/FUTURE.md) for deferred full MoA and OpenAI-compatible proxy extraction notes.
