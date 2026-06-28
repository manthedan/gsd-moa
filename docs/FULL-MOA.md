# Full MoA Flow

`gpt55-glm52-full` follows the Hermes/OpenRouter Model Fusion shape: run multiple tool-less reference models over the same sanitized conversation, optionally synthesize their outputs, then let one final GPT-5.5 acting call use normal Pi tools.

```mermaid
flowchart TD
  A[Pi/GSD calls provider gsd-moa<br/>model: gpt55-glm52-full] --> B[streamGsdMoa]
  B --> C[chooseMode => full_moa]
  C --> D[sanitizeReferenceContext<br/>drop tools, tool calls, tool results,<br/>and Pi system prompt]
  D --> E[Parallel tool-less reference layer]
  E --> E1[GLM-5.2 reference<br/>Z.ai]
  E --> E2[GPT-5.5 reference<br/>Factory proxy]
  E1 --> F[Reference response bundle]
  E2 --> F
  F --> G[Optional tool-less GPT-5.5 synthesis layer]
  G --> H[Inject reference bundle + synthesis<br/>into final primary context]
  H --> I[Final GPT-5.5 acting call<br/>Factory proxy<br/>normal Pi tools preserved]
  I --> J[Stream final assistant events to Pi]
  J --> K[done/error includes combined usage<br/>and gsd-moa.details for every inner call]
```

```mermaid
sequenceDiagram
  participant Pi as Pi/GSD
  participant MoA as gsd-moa provider
  participant Cache as Reference cache
  participant R as Tool-less references
  participant S as Tool-less synthesizer
  participant GPT as GPT-5.5 / Factory proxy

  Pi->>MoA: streamSimple(model=gpt55-glm52-full, context, tools)
  MoA->>MoA: strip routing markers from final context
  MoA->>MoA: sanitizeReferenceContext(context)
  par reference fan-out
    MoA->>Cache: read GLM-5.2 reference key
    MoA->>R: complete(tool-less sanitized context) if miss
  and
    MoA->>Cache: read GPT-5.5 reference key
    MoA->>R: complete(tool-less sanitized context) if miss
  end
  MoA->>S: complete(tool-less synthesis context) if synthesis enabled/cache miss
  MoA->>GPT: stream(original tools + private reference guidance)
  GPT-->>MoA: final assistant stream / tool calls
  MoA-->>Pi: final stream events
  MoA-->>Pi: final done/error includes combined usage and diagnostics
```

## Default reference portfolio

- `glm52`: GLM-5.2 through the configured Z.ai reference route.
- `gpt55`: GPT-5.5 through the configured Factory proxy route.
- `synthesis`: GPT-5.5 through the Factory proxy, tool-less, summarizing reference responses into actionable guidance for the final actor.
- `primary`: GPT-5.5 through the Factory proxy, tool-capable, owns all file/terminal actions.

The reference models receive the same sanitized conversation rather than role-specific architect/reviewer/implementer prompts. Diversity comes from model differences first; GSD-specific behavior belongs primarily in `auto` routing, which decides when full MoA is worth the overhead.

Individual reference and synthesis routes can be overridden under `.pi/gsd-moa.json` using `fullMoa.proposers[].route` or `fullMoa.synthesis.route`.

## Safety invariant

Full MoA expands judgment diversity, not autonomous writers. Reference models and the synthesizer are private and tool-less. Only the final primary model receives Pi tools and may act.
