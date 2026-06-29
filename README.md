# gsd-moa

A Pi custom provider for running GPT-5.5 normally, with optional Mixture-of-Agents support from GLM-5.2, Gemini, Claude, and other private reference models.

`gsd-moa` is designed for Pi and GSD-style coding workflows where most turns should stay fast and single-model, but harder turns benefit from private second opinions before the final acting model uses tools.

## What it does

`gsd-moa` registers a provider named `gsd-moa`.

From Pi’s point of view, it behaves like a normal model provider:

```text
/model gpt55-glm52-auto --provider gsd-moa
```

Internally, the provider can route each request through one of three modes:

| Mode | What happens | Use when |
|---|---|---|
| `single` | GPT-5.5 answers directly. | Normal coding turns, tool loops, quick edits. |
| `advisor` | A private tool-less reference model gives advice, then GPT-5.5 acts with normal Pi tools. | Planning, debugging, risky changes, review. |
| `full_moa` | Multiple tool-less reference models respond first; their outputs can be synthesized into private guidance for the final acting call. | Expensive final checks or hard tasks where multiple perspectives are worth the cost. |

Only the final acting model receives Pi tools. Reference models never receive tool schemas, tool calls, tool results, or the Pi system prompt.

## How the MoA flow works

The core design is single-writer, multi-advisor:

```text
Pi/GSD request
  ↓
gsd-moa provider
  ↓
choose mode: single | advisor | full_moa
  ↓
reference/advisor calls, if needed
  - no tools
  - sanitized context
  - cached when safe
  ↓
private guidance is appended to the final model context
  ↓
final acting call
  - normal Pi tools preserved
  - streams back to Pi
```

### Single mode

```text
request → GPT-5.5 → response/tool call
```

This is the default cheap path.

### Advisor mode

```text
request
  ├─ private advisor call, no tools
  ↓
GPT-5.5 final acting call, with tools
  ↓
response/tool call
```

Advisor outputs are cached by normalized context and prompt version. Final tool-capable responses are not cached.

### Full MoA mode

```text
request
  ├─ GLM-5.2 reference
  ├─ GPT-5.5 reference
  ├─ optional specialist references
  ↓
optional synthesis memo
  ↓
final acting call, with tools
```

This is intentionally more expensive and should be used sparingly.

## Model aliases

The main aliases are:

| Alias | Mode |
|---|---|
| `gpt55-glm52-single` | Force GPT-5.5 only. |
| `gpt55-glm52-advisor` | Force GLM-5.2 advisor + GPT-5.5 final call. |
| `gpt55-glm52-full` | Force full reference-model MoA. |
| `gpt55-glm52-auto` | Let the provider choose the mode deterministically. |

Additional alias families are available for local subscription/proxy setups:

| Family | Purpose |
|---|---|
| `gpt55-gemini35flash-*` | Use Gemini Flash via CLIProxyAPI/Antigravity as advisor or conditional specialist. |
| `gpt55-cliproxycodex-*` | Route GPT/Codex calls through CLIProxyAPI instead of Factory. |
| `gpt55-*-full` portfolio aliases | Force specific full-MoA reference portfolios, including Gemini or Claude variants. |
| `glm52-zai-gpt55-cliproxycodex-*` | Experimental GLM-5.2 acting model with GPT-5.5/Codex references. |

See `src/models.ts` for the exact registered model IDs.

## Install

```bash
npm install
npm run check
pi -a -e ./src/index.ts
```

Then select the provider in Pi:

```text
/model gpt55-glm52-auto --provider gsd-moa
```

For local development, load `./src/index.ts` directly with `-e`.

## Configuration

Project-local config lives at:

```text
.pi/gsd-moa.json
```

Minimal example:

```jsonc
{
  "primary": {
    "provider": "factory-codex",
    "model": "gpt-5.5"
  },
  "reference": {
    "provider": "zai",
    "model": "glm-5.2"
  },
  "trace": {
    "enabled": false,
    "dir": ".proof/traces"
  }
}
```

Common environment variables:

```bash
export FACTORY_GPT_API_KEY=...
export ZAI_API_KEY=...
export CLIPROXY_API_KEY=...          # for CLIProxyAPI presets
export GSD_MOA_CODEX_MODEL=gpt-5.5   # optional Codex preset override
export GSD_MOA_GEMINI_MODEL=gemini-3-flash
```

The default GPT-5.5 route expects a local OpenAI-compatible Codex/Factory-style proxy. The default GLM-5.2 route expects a Z.ai-compatible endpoint. CLIProxyAPI route presets default to `http://127.0.0.1:8318/v1`. Override route presets in `.pi/gsd-moa.json` when using a different provider, proxy, port, model ID, or subscription path.

## Modular specialists

Full MoA can include unconditional references or conditional specialists. A proposer can use:

- `modelRef` for the logical model, such as `provider/model`
- `routePreset` for transport/auth/compat settings
- `route` for exceptional per-model overrides
- `when` predicates to run only for matching prompts

Example:

```jsonc
{
  "fullMoa": {
    "proposers": [
      {
        "id": "gemini35flash",
        "label": "Gemini multimodal specialist",
        "modelRef": "antigravity/gemini-3-flash",
        "routePreset": "cliproxyapi",
        "when": {
          "anyCapability": ["image", "video", "audio"],
          "anyKeyword": ["youtube", "video", "transcribe", "screenshot", "diagram", "ocr"]
        }
      }
    ]
  }
}
```

Conditional proposers are included when a keyword or detected capability matches. Set `enabled: false` to park a specialist without running it. The `gsd-moa.details` diagnostic records which references were selected or skipped and why.

See [`docs/MODULAR-MOA.md`](docs/MODULAR-MOA.md) for the modular portfolio design.

## Prompt controls

You can force a mode for one turn with HTML markers:

| Marker | Effect |
|---|---|
| `<!-- gsd-moa:single -->` or `<!-- gsd-moa:off -->` | Force single mode. |
| `<!-- gsd-moa:advisor -->` or `<!-- gsd-moa:on -->` | Force advisor mode. |
| `<!-- gsd-moa:full -->` or `<!-- gsd-moa:full_moa -->` | Force full MoA mode. |

Markers are stripped before upstream model calls.

Specialists can also be forced with an include marker in the prompt text:

```text
gsd-moa:include=gemini35flash
```

## Safety model

- Reference models are private advisors only.
- Reference models receive sanitized context with no tool schemas, tool calls, tool results, or Pi system prompt.
- Only the final acting call can call tools.
- The provider prevents recursive `gsd-moa` calls.
- Advisor/reference outputs may be cached.
- Final tool-capable responses are never cached.

## Observability

Final assistant messages include `gsd-moa.details`, which records:

- selected mode
- routing reason
- cache hit/miss
- inner provider/model calls
- selected or skipped MoA references
- combined usage for the current turn

Tracing is disabled by default. Enable it with:

```bash
export GSD_MOA_TRACE=1
```

or run:

```bash
npm run proof:pi
```

Trace files are written to the configured trace directory.

## Docs

- [`docs/ADVISOR-MODE.md`](docs/ADVISOR-MODE.md) — advisor mode flow
- [`docs/FULL-MOA.md`](docs/FULL-MOA.md) — full MoA flow
- [`docs/MODULAR-MOA.md`](docs/MODULAR-MOA.md) — modular specialists and model references
- [`docs/TERMINAL-BENCH.md`](docs/TERMINAL-BENCH.md) — benchmark/proof loop notes
- [`docs/EVALUATION.md`](docs/EVALUATION.md) — current evidence snapshot
- [`docs/FUTURE.md`](docs/FUTURE.md) — hardening and proxy extraction ideas

## Development

```bash
npm run typecheck
npm test
npm run check
```

## License

MIT
