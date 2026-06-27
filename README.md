# pi-gsd-moa

Hermes-inspired Mixture-of-Agents provider for Pi/GSD.

`pi-gsd-moa` registers a Pi custom provider named `gsd-moa`. The provider lets GSD select a normal model id while the provider decides whether to run a cheap single-writer primary call or a private GLM advisor pass before the final GPT acting call.

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

The package is intentionally shaped for publishing: `package.json` declares the Pi extension entry under `pi.extensions`. For day-to-day local smoke tests, load `./src/index.ts` directly with `-e`.

## Configuration

Configuration is project-local at `.pi/gsd-moa.json`.

```json
{
  "primary": {
    "provider": "openai",
    "model": "gpt-5.5",
    "api": "openai-responses"
  },
  "reference": {
    "provider": "zai-coding-cn",
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

Set your Z.ai key before advisor mode:

```bash
export ZAI_API_KEY=...
```

The default reference route uses Z.ai's GLM Coding Plan/OpenAI-compatible endpoint. If you are not using a Coding Plan subscription, change `baseUrl` to the general Z.ai endpoint your account supports.

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

## Future Work

See [`docs/FUTURE.md`](docs/FUTURE.md) for deferred full MoA and OpenAI-compatible proxy extraction notes.
