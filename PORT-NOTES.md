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

## Verification

Command run:

```sh
npm run check
```

Result: passed.

- TypeScript: `tsc --noEmit` passed.
- Tests: `node --import tsx --test tests/**/*.test.ts` passed, 71/71 tests.

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

## Registry architecture

Alias/model/preset knowledge is centralized in `src/registry.ts` as `ALIAS_PRESETS`. `src/config.ts` derives `DEFAULT_CONFIG.aliases` from that registry, `src/models.ts` derives built-in `ProviderModelConfig` cards by applying each preset to `DEFAULT_CONFIG` and reading the effective primary route, and `src/presets.ts` dispatches by exact alias id. User-defined aliases loaded from `.pi/gsd-moa.json` are appended during provider registration with cards derived from the loaded primary route; invalid config falls back to built-in registration and reports the error on first stream call.

Full-MoA synthesis failures are no longer silent: successful proposals are still injected, and stream diagnostics include `synthesisFailedReason` with the redacted failure message.
