# Modular MoA and conditional multimodal references

Status: partially implemented. This captures the architecture direction after the GPT-5.5 + GLM-5.2 proof harness; Phase A/B and the initial Gemini specialist preset are now in code.

## Motivation

The current provider is intentionally narrow: GPT-5.5 is the primary/final actor, GLM-5.2 is the reference model, and the full-MoA preset hard-codes a small reference portfolio. That was useful for proving the single-writer design quickly, but it is not the shape we want long term.

Desired direction: let users compose a Mixture-of-Agents layer from models they already have configured in Pi, and add specialized references only when a task needs them.

Example target behavior:

- Normal coding/review/debug task: run the default full-MoA portfolio, e.g. GPT-5.5 + GLM-5.2 references, GPT-5.5 synthesis, GPT-5.5 final actor.
- Strong multimodal task, such as understanding/transcribing a YouTube video: run the normal portfolio plus a Gemini reference model, because Gemini is likely stronger for that modality.
- Routine tool-loop task: skip full-MoA unless the router sees a high-leverage reason.

## Design principles

1. **Single writer stays non-negotiable.** Reference models and synthesizers remain tool-less. Only the final primary model receives Pi tools.
2. **Reuse Pi model configuration.** A user who already configured GPT, GLM, Gemini, Claude, etc. for normal Pi use should not duplicate base URLs, API keys, compat flags, or model metadata in `gsd-moa` config.
3. **References are capability-selected, not role-hardcoded.** Prefer model/capability diversity over fixed `architect/reviewer/implementer` personas.
4. **Conditional additions should be cheap and explainable.** The trace/diagnostics should say why a conditional model joined the reference set.
5. **No multimodal theater.** Adding Gemini only helps if the reference context actually contains the media/transcript/image signal Gemini needs. If Pi only provides text, route selection alone is not enough.

## Proposed configuration shape

The current config splits model identity from route details with `modelRef` + `routePreset` + optional `route` overrides:

```jsonc
{
  "routePresets": {
    "factory-codex-local": { "baseUrl": "http://127.0.0.1:8317/v1", "apiKey": "$FACTORY_GPT_API_KEY" },
    "cliproxyapi": { "baseUrl": "http://127.0.0.1:8318/v1", "apiKey": "$CLIPROXY_API_KEY" },
    "cliproxyapi-codex": { "baseUrl": "http://127.0.0.1:8318/v1", "apiKey": "$CLIPROXY_API_KEY" }
  },
  "primary": { "provider": "factory-codex", "model": "gpt-5.5" },
  "fullMoa": {
    "proposers": [
      {
        "id": "glm52",
        "label": "GLM-5.2 reference",
        "modelRef": "zai/glm-5.2"
      },
      {
        "id": "gpt55",
        "label": "GPT-5.5 reference",
        "modelRef": "factory-codex/gpt-5.5",
        "routePreset": "factory-codex-local"
      },
      {
        "id": "gemini-multimodal",
        "label": "Gemini multimodal reference",
        "modelRef": "antigravity/gemini-3-flash"
        "routePreset": "cliproxyapi",
        "when": {
          "anyCapability": ["image", "video", "audio"],
          "anyKeyword": ["youtube", "video", "transcribe", "screenshot", "diagram"]
        }
      }
    ],
    "synthesis": {
      "modelRef": "factory-codex/gpt-5.5",
      "routePreset": "factory-codex-local"
    }
  }
}
```

Implemented syntax: `modelRef` accepts `provider/model` or `{ "provider": "...", "model": "..." }`. `routePreset` names the reusable transport/auth/compat profile. Internally this resolves to provider/model, applies the preset, then applies explicit route overrides; upstream conversion still consults Pi's configured model registry for missing model metadata. The `gpt55-cliproxycodex-*` aliases use `cliproxyapi-codex` for GPT/Codex primary, reference, and synthesis calls while preserving logical route identity as `openai-codex/<model>`. The `gpt55-glm52-gemini35flash-full` alias uses Gemini as an unconditional normal reference rather than a conditional specialist.

## Capability matching

Potential selector inputs:

- Model metadata from Pi: `input: ["text"]` vs `input: ["text", "image"]`, context window, reasoning support, cost.
- Prompt features: keywords like `video`, `youtube`, `transcribe`, `image`, `screenshot`, `diagram`, `OCR`.
- Context attachments: image parts, pasted media, URLs, file extensions, transcript files.
- Explicit user markers: e.g. `[moa:include=gemini-multimodal]` or `[moa:multimodal]`.
- Task class from router: review/debug/architecture/audit vs routine edit/tool-loop.

A first implementation can use deterministic heuristics. Avoid an LLM router until there is evidence that heuristic routing is insufficient.

## Concrete motivating case: Terminal-Bench `extract-moves-from-video`

Terminal-Bench 2 includes `terminal-bench/extract-moves-from-video`, which asks the agent to download a public YouTube video of someone playing Zork, transcribe the text commands entered in the video, and write `/app/solution.txt` with one move per line. The local task description notes a hard 30-minute benchmark budget, internet access, and an expected solution of 285 command lines with a ≥90% similarity verifier.

This is exactly the kind of case where the default GPT+GLM coding portfolio is poorly matched: the challenge is not just shell planning, but video understanding/OCR over a public YouTube video. A Gemini specialist reference could produce a structured move list or timestamped extraction plan, while the final GPT actor remains the only tool-capable writer that creates `/app/solution.txt` and runs verifier checks.

Gemini's current video-understanding docs say the API can accept public YouTube URLs directly as video input in preview, and can also process uploaded video files through the Files API. The docs also note default video frame sampling around 1 FPS, which may miss fast-changing terminal text; for this benchmark we may need prompting that asks Gemini specifically for player-entered commands and/or a fallback path using downloaded frames/OCR when direct YouTube prompting is insufficient.

This example suggests two related but separable features:

1. **Conditional Gemini reference selection:** include Gemini when the prompt/task metadata mentions YouTube, video, transcription, OCR, screenshots, diagrams, or other multimodal signals.
2. **Video input plumbing:** support a reference call that can pass a YouTube URL or uploaded video part to Gemini, rather than merely including the URL as plain text. This may require extending the upstream route/context representation beyond Pi's current text/image-oriented metadata.

## Multimodal caveat

Pi model metadata currently distinguishes text and image input. A YouTube-video workflow needs more than a model switch:

- If the task includes a transcript, Gemini can be a text reference.
- If the task includes frames/screenshots, Gemini can be an image reference.
- If the task only includes a YouTube URL, `gsd-moa` needs either a provider/API path that accepts video URLs/files or a separate media-acquisition/transcript step. Reference models still must not get Pi tools, so any media extraction would need to happen outside the reference call or be supplied by the user/context.

This suggests a staged approach: start with image/transcript-aware Gemini references, spike direct Gemini YouTube URL support for tasks like `extract-moves-from-video`, then consider deterministic frame/OCR enrichment if direct video prompting is not reliable enough.

## Implementation sketch

1. **Model reference resolver**
   - Add a `modelRef` form for `provider/model` or `{ provider, model }`.
   - Resolve it through Pi's configured model registry (`getModel`) and merge explicit route overrides only when needed.
   - Preserve current explicit `route` config for backwards compatibility.

2. **Reference portfolio builder**
   - Convert `fullMoa.proposers` into a selected portfolio for this request.
   - Always include unconditional references.
   - Include conditional references when deterministic capability/prompt/context predicates match.
   - Record inclusion/exclusion reasons in diagnostics and traces.

3. **Capability predicates**
   - Implement simple predicates first: keywords, model input capabilities, presence of image content, URL/file-extension hints.
   - Keep predicates serializable in config.

4. **Gemini reference preset**
   - Provide a documented example for a Pi-configured Gemini model.
   - Default it to conditional, not always-on.
   - Ensure it remains tool-less and advisory.

5. **Tests**
   - Resolver uses Pi model metadata when available and explicit route overrides when needed.
   - Conditional Gemini is included for multimodal prompts and excluded for normal coding prompts.
   - Reference calls still receive no tools/tool results/system prompt.
   - Diagnostics explain selected and skipped references.

## Risks and tradeoffs

- **Auth duplication:** If `gsd-moa` cannot access Pi's normal auth resolution, users may still need route-level `apiKey` overrides. That would undermine the modular goal.
- **API capability mismatch:** Pi's compat layer may not support every Gemini video/audio path even if Gemini itself does.
- **Cost creep:** Conditional references can silently turn cheap tasks expensive unless diagnostics and routing are explicit.
- **Stale references:** Current sanitized reference contexts omit tool results; conditional multimodal references may need a richer but still safe summarized context.
- **Config complexity:** A flexible portfolio system should not make the common GPT+GLM case harder.

## Possible milestone shape

- Phase A: ModelRef resolver and backwards-compatible portfolio builder. **Implemented.**
- Phase B: Conditional reference predicates plus diagnostics/tracing. **Implemented for deterministic keyword/capability matching, disabled/parked specialists, and diagnostics.**
- Phase C: Gemini image/transcript reference preset and docs. **Initial CLIProxyAPI/Antigravity Gemini 3.5 Flash specialist implemented; Claude Sonnet 4.6 is parked as disabled for A/B testing. Image-capable references receive sanitized text plus provided image blocks.**
- Phase D: Spike true video/YouTube handling if needed. **Not implemented; current Gemini specialist does not acquire or forward direct video/YouTube media parts yet.**

## Related evaluation notes

See [`EVALUATION.md`](EVALUATION.md), [`TERMINAL-BENCH.md`](TERMINAL-BENCH.md), and [`TERMINAL-BENCH-RESULTS.md`](TERMINAL-BENCH-RESULTS.md) for the current Terminal-Bench evidence snapshot. Those results motivate keeping Gemini and other specialists conditional: MoA helped on constraint-heavy/distributed reasoning tasks, while current-info leaderboard tasks still need direct tool-grounded verification by the final actor.

