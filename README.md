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
| `gpt55-gemini35flash-single` | Direct primary GPT-5.5 call, with Gemini preset metadata for side-by-side selection. |
| `gpt55-gemini35flash-advisor` | Gemini 3.5 Flash reference/advisor via CLIProxyAPI Antigravity OAuth, then final GPT-5.5 acting call with normal tools. |
| `gpt55-gemini35flash-full` | Default GLM-5.2 + GPT-5.5 full-MoA portfolio, plus a conditional Gemini 3.5 Flash specialist for multimodal/video/OCR/transcription prompts. |
| `gpt55-gemini35flash-auto` | Same deterministic routing policy as `auto`; advisor uses Gemini, while full-MoA conditionally adds the Gemini specialist when predicates match. |

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

```jsonc
{
  "routePresets": {
    "factory-codex-local": {
      "api": "openai-completions",
      "baseUrl": "http://127.0.0.1:8317/v1",
      "apiKey": "$FACTORY_GPT_API_KEY",
      "compat": { "supportsDeveloperRole": false, "maxTokensField": "max_tokens" }
    },
    "zai-coding-plan": {
      "api": "openai-completions",
      "baseUrl": "https://api.z.ai/api/coding/paas/v4",
      "apiKey": "$ZAI_API_KEY",
      "compat": { "thinkingFormat": "zai", "zaiToolStream": true, "supportsDeveloperRole": false, "maxTokensField": "max_tokens" }
    },
    "cliproxyapi": {
      "api": "openai-completions",
      "baseUrl": "http://127.0.0.1:8317/v1",
      "apiKey": "$CLIPROXY_API_KEY",
      "compat": { "supportsDeveloperRole": false, "maxTokensField": "max_tokens" }
    }
  },
  "primary": {
    "provider": "factory-codex",
    "model": "gpt-5.5"
  },
  "reference": {
    "provider": "zai",
    "model": "glm-5.2"
  },
  "fullMoa": {
    "enabled": true,
    "proposers": [
      { "id": "glm52", "label": "GLM-5.2 reference" },
      {
        "id": "gpt55",
        "label": "GPT-5.5 reference",
        "modelRef": "factory-codex/gpt-5.5",
        "routePreset": "factory-codex-local"
      }
    ],
    "synthesis": {
      "enabled": true,
      "modelRef": "factory-codex/gpt-5.5",
      "routePreset": "factory-codex-local",
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

### Modular reference portfolios

Full-MoA proposers can now be unconditional references or conditional specialists. Routing is standardized as `modelRef` + `routePreset` + optional `route` overrides: `modelRef` names the logical model, `routePreset` names the transport/auth/compat profile, and `route` only overrides exceptional fields.

```jsonc
{
  "fullMoa": {
    "proposers": [
      {
        "id": "gemini35flash",
        "label": "Gemini multimodal specialist",
        "modelRef": "antigravity/gemini-3.5-flash-low",
        "routePreset": "cliproxyapi",
        "route": { "maxTokens": 65536 },
        "when": {
          "anyCapability": ["image", "video", "audio"],
          "anyKeyword": ["youtube", "video", "transcribe", "screenshot", "diagram", "ocr"]
        }
      }
    ]
  }
}
```

Conditional proposers are included when any keyword or detected capability matches. Unconditional proposers still have no `when`. Set `enabled: false` to park a specialist in the portfolio without running it; diagnostics will report it as skipped with reason `disabled`. The `gsd-moa.details` diagnostic includes a `portfolio` array explaining which references were selected or skipped and why.

The Gemini preset also parks a Claude specialist for A/B tests without enabling it by default:

```jsonc
{
  "fullMoa": {
    "proposers": [
      {
        "id": "claude46",
        "label": "Claude Sonnet 4.6 specialist",
        "enabled": true,
        "modelRef": "antigravity/claude-sonnet-4-6",
        "routePreset": "cliproxyapi"
      }
    ]
  }
}
```

Override the parked Claude model with `GSD_MOA_CLAUDE_MODEL`, `modelRef`, or route fields. Current CLIProxyAPI/Antigravity installs may expose model IDs such as `claude-sonnet-4-6` and `claude-opus-4-6-thinking`.

## Gemini Flash via Antigravity / CLIProxyAPI

The `gpt55-gemini35flash-*` aliases use CLIProxyAPI's OpenAI-compatible endpoint as a local proxy to Antigravity OAuth. This replaces the legacy Gemini CLI path, which no longer supports Gemini Code Assist for individual subscriptions.

Setup:

```bash
brew install cliproxyapi

# One-time Antigravity OAuth login. The local callback uses port 51121.
cliproxyapi --antigravity-login

# Run the local proxy. Default endpoint is http://127.0.0.1:8317/v1.
cliproxyapi

# If your CLIProxyAPI config uses api-keys, export one before launching Pi.
export CLIPROXY_API_KEY=your-cli-proxy-api-key

# In another shell, confirm which Gemini model id the proxy exposes.
curl -s http://127.0.0.1:8317/v1/models \
  ${CLIPROXY_API_KEY:+-H "Authorization: Bearer $CLIPROXY_API_KEY"} | jq '.data[].id'

# The preset defaults to the Antigravity model id seen in current CLIProxyAPI installs.
export GSD_MOA_GEMINI_MODEL=gemini-3.5-flash-low
export GSD_MOA_GEMINI_BASE_URL=http://127.0.0.1:8317/v1

# Then select one of the Gemini aliases in Pi.
/model gpt55-gemini35flash-advisor --provider gsd-moa
```

Notes:

- A Google AI Pro/Ultra subscription is not the same thing as Gemini API billing. Direct API-key use should configure a normal `google` route with `api: "google-generative-ai"` and `apiKey: "$GEMINI_API_KEY"`.
- The subscription-oriented aliases point at CLIProxyAPI's local OpenAI-compatible server. The default Antigravity model id is `gemini-3.5-flash-low`; set `GSD_MOA_GEMINI_MODEL` if `/v1/models` reports a different id.
- Advisor mode uses Gemini directly as the private reference. Full-MoA mode keeps the normal GLM-5.2 + GPT-5.5 portfolio and adds Gemini only when the request looks multimodal/video/OCR/transcription-related. The final acting call remains GPT-5.5 through Pi, so normal Pi tools stay single-writer.
- If you configure CLIProxyAPI with a non-default API key, export `CLIPROXY_API_KEY` before launching Pi.

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
- full-MoA portfolio selection/skipping reasons
- combined current-turn usage

## Smoke Checklist

1. `npm run check` passes.
2. `pi -a -e ./src/index.ts --list-models gpt55-glm52` shows provider `gsd-moa` with the four aliases.
3. Selecting `gpt55-glm52-single` produces a normal streamed response.
4. Selecting `gpt55-glm52-advisor` with `ZAI_API_KEY` set runs a GLM advisor call and then a GPT final response.
5. Selecting `gpt55-glm52-full` runs GLM-5.2 and GPT-5.5 as tool-less private advisors, optional GPT-5.5 execution-memo synthesis, injects that private context as privileged guidance, adds a non-private execution note when tools are present, and then runs one GPT final response.
6. Tool calls, if any, come only from the final GPT call.

## Advisor and Full MoA Flows

See [`docs/ADVISOR-MODE.md`](docs/ADVISOR-MODE.md) for advisor mode, [`docs/FULL-MOA.md`](docs/FULL-MOA.md) for full reference-model MoA flow diagrams, and [`docs/TERMINAL-BENCH.md`](docs/TERMINAL-BENCH.md) for the single-vs-full proof loop.

## Future Work

See [`docs/FUTURE.md`](docs/FUTURE.md) for OpenAI-compatible proxy extraction and future hardening notes.
