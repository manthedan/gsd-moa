# oh-my-pi port notes

## Dependency versions

Installed from npm after the dependency swap:

- `@oh-my-pi/pi-ai@16.3.2`
- `@oh-my-pi/pi-catalog@16.3.2`
- `@oh-my-pi/pi-coding-agent@16.3.2`
- `typescript@5.9.3`, `tsx@4.22.4`, `@types/node@24.13.2`

`package.json` now declares the OMP packages in both `peerDependencies` and `devDependencies`, and keeps the legacy `pi.extensions` manifest while adding `omp.extensions`.

## Compatibility mapping as implemented

| Former `@earendil-works/pi-ai/compat` surface | OMP implementation in `src/pi-compat.ts` |
|---|---|
| `streamSimple`, `completeSimple` | Lazy wrappers around `@oh-my-pi/pi-ai/stream` exports. The lazy import avoids loading Bun-only OMP runtime modules during Node-based unit tests. |
| `createAssistantMessageEventStream()` | Shim returning a local `AssistantMessageEventStream` compatibility class with the same push/end/fail/result async-iterable behavior used by this extension/tests. |
| `AssistantMessageEventStream` | Local compatibility class. OMP's class constructor was verified as zero-arg, but importing it directly pulls in Bun-only runtime dependencies under Node. |
| `getModel(provider, id)` | Uses OMP's `getBundledModel` via `import.meta.require` when available (Bun/OMP runtime). Falls back in Node tests to reading `@oh-my-pi/pi-catalog/models.json` and returning `undefined` on failure/miss. |
| `Api`, `Model`, `Context`, `Message`, `UserMessage`, `AssistantMessage`, `TextContent`, `Usage`, `SimpleStreamOptions`, `AssistantMessageEvent` | Types mapped to `@oh-my-pi/pi-ai/types`, with local compatibility widening for old `Context.systemPrompt: string`, optional `Model.compat` in test literals, `AssistantMessage.diagnostics`, and legacy `Usage.cacheWrite1h`. |

## Other OMP mappings

- `ExtensionAPI` and `ProviderModelConfig` are imported from `@oh-my-pi/pi-coding-agent/extensibility/extensions/types`.
- `registerProvider` was updated for OMP's signature/config shape: the provider config no longer includes a display `name` field.
- The provider still registers custom `api: "gsd-moa-api"`. OMP's `Api` type is open (`KnownApi | string`), and the model registry registers custom `streamSimple` handlers for custom APIs.

## Divergences and dropped fields

- Dropped `thinkingLevelMap` from `UpstreamRoute` and `routeToModel`; OMP removed `ThinkingLevelMap` in favor of model `thinking` metadata. This spike does not remap thinking metadata.
- Dropped obsolete `compat.zaiToolStream` from defaults and `.pi/gsd-moa.json`. OMP's Z.ai handling is represented through current OpenAI-compatible `thinkingFormat`/provider logic; no `zaiToolStream` compat key exists.
- OMP `Context.systemPrompt` is typed as `string[]`; this extension's existing code/tests use a single string. The adapter normalizes strings to one-element arrays for OMP stream calls.
- OMP `Message` includes `developer`. `sanitizeReferenceContext` continues to skip non-user/non-assistant messages for reference calls; `stripMarkersFromContext` passes developer messages through. Cache-key normalization now records developer messages explicitly.
- OMP `Model.compat` is a resolved compat object, while this extension accepts sparse JSON compat overrides. `routeToModel` keeps the existing loose route compat and casts through the adapter type. For direct OMP stream calls, the configured routes include the sparse OpenAI-compatible flags this extension needs.
- Published OMP packages ship `dist/types` but their runtime `exports.import` entries point at `src/*.ts` and assume Bun for some modules. `tsconfig.json` uses `moduleResolution: "bundler"`; `src/pi-compat.ts` avoids top-level OMP runtime imports so `node --import tsx --test` works.

## Dual-runtime adapter

Runtime selection lives in `src/pi-compat.ts`:

- `GSD_MOA_RUNTIME=pi|omp` wins when set.
- Otherwise Bun auto-detection chooses `omp` when `globalThis.Bun` exists, and `pi` under plain Node/jiti.
- Tests can reset the cached selection with `resetRuntimeCache()`.

Adapter behavior is intentionally narrow:

- `streamSimple`, `completeSimple`, and `getModel` dispatch to `@oh-my-pi/*` for `omp` and `@earendil-works/pi-ai/compat` for `pi` without top-level runtime imports from either implementation family.
- `Context.systemPrompt` normalizes to `string[]` for `omp` and to a single string for upstream `pi`.
- `thinkingLevelMap` is restored on `UpstreamRoute` and is passed through in `routeToModel` as `route.thinkingLevelMap ?? builtin?.thinkingLevelMap`.
- Z.ai route defaults include `compat.zaiToolStream: true` only when `getRuntime() === "pi"`; `omp` route/compat defaults stay unchanged.
- Provider registration adds display `name: "GSD MoA"` only for upstream `pi`; `omp` keeps the OMP provider config shape without `name`.
- Both runtimes use the same `SimpleStreamOptions.reasoning` field. Upstream `@earendil-works/pi-ai` types use `reasoning?: ThinkingLevel`; OMP uses the same option name, so `src/pi-compat.ts` does not need a field-name translation.

## Reasoning effort addendum

- gsd-moa resolves effort before every upstream call and writes it to `options.reasoning`; default is `high` unless a route, host option, env override, or `inherit` changes it.
- The custom OpenAI-compatible route presets now include sparse compat flags `supportsReasoningParams: true` and `supportsReasoningEffort: true`; without these flags OMP's OpenAI-completions compat policy can omit `reasoning_effort` for sparse custom routes.
- Z.ai/GLM-5.2 routes use `compat.thinkingFormat: "zai"`, `reasoningDisableMode: "zai-thinking-disabled"`, and `supportsReasoningEffort: true`. In OMP's `openai-completions` serializer this emits `thinking: { type: "enabled" }` plus `reasoning_effort: <effort>` for GLM-5.2 reasoning turns; `high` therefore enables GLM thinking and sends the tier. The route's model cards do not need `thinking.efforts`; `resolveOpenAICompletionsRoutingEffort` passes through unmapped efforts when no metadata is present.
- GPT-5.5 through CLIProxy/Codex also receives the unmapped effort string as `reasoning_effort`; `xhigh` remains configurable and passes through for Codex-compatible backends that accept it.

Upstream pi no-secrets extension-load smoke:

```sh
GSD_MOA_RUNTIME=pi ./node_modules/.bin/pi --no-extensions -e ./src/index.ts --list-models | rg "gsd-moa|GSD MoA"
```

OMP no-secrets extension-load smoke:

```sh
./node_modules/.bin/omp models -e ./src/index.ts | rg "gsd-moa|GSD MoA"
```

## Verification

Command run:

```sh
npm run check
```

Result: passed.

- TypeScript: `tsc --noEmit` passed.
- Tests: `node --import tsx --test tests/**/*.test.ts` passed under both `GSD_MOA_RUNTIME=omp` and `GSD_MOA_RUNTIME=pi`, 91/91 tests in each run.

## Smoke test

Attempted command from the worktree root:

```sh
source /Users/macthedan/projects/gsd-moa/.proof/gsd-moa.env
./node_modules/.bin/omp --no-session -e ./src/index.ts --provider gsd-moa --model gpt55-cliproxycodex-single -p "Reply with exactly: OK"
```

Output:

```text
env: bun: No such file or directory
```

Outcome: blocked before extension load because the installed OMP CLI bin has a `#!/usr/bin/env bun` shebang and Bun is not installed/available in this environment. No live provider request was made.

### Follow-up (after installing Bun 1.3.14)

Verified live on 2026-07-02. Notes:

- `omp models` lists `gsd-moa (18)` when loaded with `-e ./src/index.ts` — provider registration works.
- omp resolves models via the combined `--model "gsd-moa/<alias>"` form; the separate `--provider` flag does not select extension providers.
- The env file must be sourced with `set -a` (its assignments are not `export`ed), otherwise gsd-moa's fail-fast env check correctly rejects the unresolved `$CLIPROXY_API_KEY`.

```sh
set -a; source ../gsd-moa/.proof/gsd-moa.env; set +a
omp --no-session -e ./src/index.ts --model "gsd-moa/gpt55-cliproxycodex-single" -p "Reply with exactly: OK"
# → OK

omp --no-session -e ./src/index.ts --model "gsd-moa/gpt55-cliproxycodex-glm52-nosynth-full" -p "In one short sentence: what is a mixture of agents?"
# → full-MoA path: GLM-5.2 + GPT-5.5 proposers ran, guidance injected, final actor answered.
```

Both single and full-MoA modes work end-to-end under the omp runtime, including the local `AssistantMessageEventStream` compat class being consumed by omp's stream loop.

### Dual-runtime load checks (no secrets)

Verified after adding the dual-runtime adapter:

```sh
GSD_MOA_RUNTIME=pi ./node_modules/.bin/pi --no-extensions -e ./src/index.ts --list-models | rg "gsd-moa|GSD MoA"
# → lists 18 gsd-moa models

./node_modules/.bin/omp models -e ./src/index.ts | rg "gsd-moa|GSD MoA"
# → gsd-moa (18)
```

## Registry architecture

Alias/model/preset knowledge is centralized in `src/registry.ts` as `ALIAS_PRESETS`. `src/config.ts` derives `DEFAULT_CONFIG.aliases` from that registry, `src/models.ts` derives built-in `ProviderModelConfig` cards by applying each preset to `DEFAULT_CONFIG` and reading the effective primary route, and `src/presets.ts` dispatches by exact alias id. User-defined aliases loaded from `.pi/gsd-moa.json` are appended during provider registration with cards derived from the loaded primary route; invalid config falls back to built-in registration and reports the error on first stream call.

Full-MoA synthesis failures are no longer silent: successful proposals are still injected, and stream diagnostics include `synthesisFailedReason` with the redacted failure message.
