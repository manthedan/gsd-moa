# Full MoA Flow

`gpt55-glm52-full` expands judgment diversity while preserving the single-writer tool boundary.

```mermaid
flowchart TD
  A[Pi/GSD calls provider gsd-moa<br/>model: gpt55-glm52-full] --> B[streamGsdMoa]
  B --> C[chooseMode => full_moa]
  C --> D[sanitizeReferenceContext<br/>drop tools, tool calls, tool results,<br/>and Pi system prompt]
  D --> E[Parallel tool-less proposer layer]
  E --> E1[Architecture proposer<br/>GLM/Z.ai by default]
  E --> E2[Critical reviewer<br/>GLM/Z.ai by default]
  E --> E3[Implementation proposer<br/>GLM/Z.ai by default]
  E1 --> F[Proposal bundle]
  E2 --> F
  E3 --> F
  F --> G[Optional tool-less synthesis layer]
  G --> H[Inject proposal bundle + synthesis<br/>into final primary context]
  H --> I[Final GPT-5.5 acting call<br/>Factory Codex proxy<br/>normal Pi tools preserved]
  I --> J[Stream final assistant events to Pi]
  J --> K[done/error includes combined usage<br/>and gsd-moa.details for every inner call]
```

```mermaid
sequenceDiagram
  participant Pi as Pi/GSD
  participant MoA as gsd-moa provider
  participant Cache as Reference cache
  participant P as Tool-less proposers
  participant S as Tool-less synthesizer
  participant GPT as GPT-5.5 / Factory proxy

  Pi->>MoA: streamSimple(model=gpt55-glm52-full, context, tools)
  MoA->>MoA: strip routing markers from final context
  MoA->>MoA: sanitizeReferenceContext(context)
  par proposer fan-out
    MoA->>Cache: read proposer architect key
    MoA->>P: complete(tool-less architect context) if miss
  and
    MoA->>Cache: read proposer reviewer key
    MoA->>P: complete(tool-less reviewer context) if miss
  and
    MoA->>Cache: read proposer implementer key
    MoA->>P: complete(tool-less implementer context) if miss
  end
  MoA->>S: complete(tool-less synthesis context) if synthesis enabled/cache miss
  MoA->>GPT: stream(original tools + private proposal guidance)
  GPT-->>MoA: final assistant stream / tool calls
  MoA-->>Pi: final stream events
  MoA-->>Pi: final done/error includes combined usage and diagnostics
```

## Default proposer roles

- `architect`: robust plan, boundaries, sequencing, tradeoffs.
- `reviewer`: bugs, missing requirements, risks, and tests.
- `implementer`: concrete implementation path, edge cases, verification.

Each proposer defaults to the configured reference route. Individual proposer and synthesis routes can be overridden under `.pi/gsd-moa.json` using `fullMoa.proposers[].route` or `fullMoa.synthesis.route`.

## Safety invariant

Full MoA expands judgment diversity, not autonomous writers. Proposers and the synthesizer are private, tool-less reference calls. Only the final primary model receives Pi tools and may act.
