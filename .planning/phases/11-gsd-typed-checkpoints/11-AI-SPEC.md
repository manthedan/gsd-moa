# AI-SPEC — Phase 11: GSD-Typed Checkpoints

> Design contract for the M3 prototype. This phase stays inside the existing TypeScript `gsd-moa` provider and OMP/Terminal-Bench harness.

---

## 1. System Classification

**System Type:** Hybrid code-automation middleware / sparse single-writer multi-advisor system

**Description:**

The provider keeps one GPT-5.5 terminal actor as the only tool-capable writer. It derives explicit GSD-style phases from observable session state and intervenes only at typed boundaries. The M3 prototype adds a deterministic strategy contract before work, a tool-less GLM diagnosis after a failed verifier, and reuses the existing mechanical done gate before completion. Good behavior means checkpoint triggers are attributable, sparse, bounded, and followed by useful actor behavior without materially increasing wall time or violating the single-writer boundary.

**Critical Failure Modes:**

1. A checkpoint gives tools to a reference model or creates a second writer.
2. Stale verification or a failed mutation causes an incorrect phase transition.
3. A checkpoint repeats indefinitely, consumes reserve time, or suppresses the primary actor.
4. Advisor output is injected without a matching typed trigger or after its deadline.
5. Telemetry cannot distinguish strategy, verifier-failure, done-gate, rescue, and ordinary calls.

---

## 1b. Domain Context

**Industry Vertical:** Developer tooling / autonomous coding-agent evaluation

**User Population:** Developers operating Pi/OMP agents and researchers comparing coding harnesses on execution-graded tasks.

**Stakes Level:** Medium. Incorrect intervention wastes model budget and can reduce task completion; tool-boundary violations can mutate user environments through the wrong model.

**Output Consequence:** The terminal actor may execute commands and modify files based on private guidance. Benchmark conclusions also influence which architecture receives further investment.

### What Domain Experts Evaluate Against

| Dimension | Good | Bad | Stakes |
|---|---|---|---|
| Trigger attribution | Every intervention has one observable state transition and ledger key | Keyword or historical-state coincidence fires it | High |
| Recovery quality | Actor changes hypothesis or runs a concrete discriminating command | Advisor repeats the task or suggests unavailable tools | High |
| Verification discipline | Final mutation is followed by relevant passing evidence or an explicit blocker | Stale tests or syntax-only checks are treated as semantic proof | High |
| Tool safety | Only the final actor receives tools and raw tool results | Advisor receives tool schemas/calls or becomes a writer | Critical |
| Cost discipline | One bounded call at a failed-verifier boundary; reserve suppression works | Scheduled advice or retries consume the task clock | High |
| Evaluation validity | Same-commit controls, integrity-clean trials, tracked aggregation | Cross-harness/model confounds or per-event metrics presented as per-trial | Critical |

### Known Failure Modes

- Generic scheduled advice has already consumed most of a task clock without pass lift.
- Tool-result guidance does not persist in host context, so context-only caps silently fail.
- Verification state becomes stale after any later successful mutation.
- Diff-only semantic review misses task-contract errors and can hallucinate defects.
- Terminal-Bench task families have heterogeneous verifiers; regex telemetry can miss R and domain-specific checks.
- Trial counts in the available budget cannot detect small aggregate lifts; mechanism metrics must gate continuation.

### Regulatory / Compliance Context

No sector-specific regulation applies. Benchmark-integrity rules prohibit using benchmark registries, checker files, solutions, or task discussion pages. Trace/config artifacts must redact credentials and avoid retaining raw prompts in process-global identity stores.

### Domain Expert Roles for Evaluation

| Role | Responsibility |
|------|---------------|
| Coding-agent maintainer | Trigger/ledger review, tool-boundary verification, failure taxonomy |
| Benchmark operator | Same-commit arm execution, integrity scan, artifact provenance |
| Senior software engineer | Judge whether diagnosis and next command are technically discriminating |

---

## 2. Framework Decision

**Selected Framework:** Existing `gsd-moa` TypeScript provider and OMP extension API

**Version:** `pi-gsd-moa@0.1.0`, OMP packages `16.3.12`, TypeScript `5.9.x`

**Rationale:**

M3 is an intervention-policy experiment, not a new autonomous-agent product. The existing provider already owns route selection, sanitized reference calls, tool boundaries, ledgers, time budgets, diagnostics, traces, and dual-runtime tests. Adding LangGraph, CrewAI, or a provider-native agent SDK would introduce a second state machine and confound the harness comparison. Typed checkpoints should be represented as TypeScript discriminated unions and deterministic transition functions at the current ownership boundary.

**Alternatives Considered:**

| Framework | Ruled Out Because |
|-----------|------------------|
| LangGraph | Duplicates OMP/Pi session state and checkpointing; changes the harness under evaluation |
| CrewAI | Encourages multiple agent roles/writers and lacks the fine-grained deterministic state ownership required here |
| OpenAI Agents SDK | Vendor-specific orchestration is unnecessary; existing upstream adapters already handle model calls |
| External GSD workflow runner | Would move the experiment off the execution-graded Terminal-Bench substrate |

**Vendor Lock-In Accepted:** Partial. The prototype uses current GPT/GLM routes, but checkpoint state and policy remain provider/model agnostic.

---

## 3. Framework Quick Reference

### Installation

```bash
npm ci
npm run check
```

### Core Imports

```ts
import { buildSessionStateSummary } from "./session-state.js";
import { conversationIdentity } from "./context.js";
import { runAdvisor } from "./advisor.js";
import { computeTimeState } from "./time.js";
```

### Entry Point Pattern

```ts
type TypedCheckpoint =
  | { type: "strategy"; mode: "deterministic-note" }
  | { type: "verify_failure"; mode: "advisor"; failedCommand: string }
  | { type: "pre_done"; mode: "done-gate" };

const checkpoint = chooseTypedCheckpoint(config, context, sessionState, ledger, timeState);
if (checkpoint?.type === "verify_failure") {
  // Tool-less, sanitized reference call; one final actor remains the writer.
  const advice = await runAdvisor(/* existing route and accounting path */);
}
```

### Key Abstractions

| Concept | What It Is | When Used |
|---------|------------|-----------|
| `TypedCheckpoint` | Discriminated union describing one attributable boundary | Policy, diagnostics, tests, aggregation |
| Session state | Successful mutations plus verifier ordering/outcome for the current user turn | Verify-failure and pre-done transitions |
| Per-type ledger | In-process cap keyed by alias + conversation identity + checkpoint type | Prevent repeated intervention |
| Observation summary | Redacted compact tool evidence | Advisor prompt; never raw tool results |
| Time state | Remaining budget and reserve phase | Suppress all optional reference calls |

### Common Pitfalls

1. Do not infer a phase from assistant prose; use tool/session evidence.
2. Do not let an earlier passing verifier survive a later successful mutation.
3. Do not combine rescue and verify-failure counters; they answer different mechanism questions.
4. Do not send raw tool results, tool schemas, provider session state, or mutable interaction ancestry to references.
5. Do not add an LLM router; checkpoint selection must remain deterministic.

### Recommended Project Structure

```text
src/
├── typed-checkpoint.ts       # transition function + ledger
├── session-state.ts          # ordered mutation/verifier evidence
├── stream.ts                 # orchestration/injection/accounting
├── advisor.ts                # existing tool-less reference path
└── types.ts                  # config, union, diagnostic contracts
tests/
├── typed-checkpoint.test.ts
├── done-gate-stream.test.ts
└── advisor-stream.test.ts
```

---

## 4. Implementation Guidance

**Model Configuration:**

- Final actor: existing GPT-5.5 CLIProxy route, effort `high`.
- Verify-failure advisor: existing GLM-5.2 Z.ai route, effort `high`, `referenceMaxTokens` cap.
- Temperature remains route-configured; no new generation defaults.
- Strategy and pre-done checkpoints add no reference-model call in the MVP.

**Core Pattern:**

1. Derive session state once near the start of `streamGsdMoa`.
2. Run a pure `chooseTypedCheckpoint()` transition function.
3. Apply time/reserve and per-type ledger suppression.
4. For `strategy`, inject one deterministic private phase contract into the final actor context.
5. For `verify_failure`, call the existing tool-less advisor with a typed prompt and redacted observation summary, then inject its diagnosis into the actor context.
6. For `pre_done`, delegate to the existing mechanical done gate; do not add semantic M4 review.
7. Emit checkpoint type, trigger reason, suppression reason, usage, and post-checkpoint behavior in `gsd-moa.details`.

**Tool Use:** References receive no tools. The final actor keeps the original OMP/Pi tools. The strategy note and advisor guidance are private context messages, not executable commands.

**State Management:** A bounded in-process ledger is keyed by hash(alias, conversation identity, checkpoint type). MVP caps: strategy 1/task, verify-failure 1/task, pre-done existing cap 1/task. Reset helpers must abort/clear associated state in tests and host resets.

**Context Window Strategy:** Reuse sanitized reference context and compact observation summaries. Never inject full historical traces. Checkpoint prompts have explicit version strings so cache identity changes with the contract.

---

## 4b. AI Systems Best Practices

### Structured Outputs

Pydantic is not used because this is a TypeScript provider. The equivalent contract is a TypeScript discriminated union plus runtime validation at config/diagnostic boundaries:

```ts
interface VerifyFailureGuidance {
  checkpoint: "verify_failure";
  diagnosis: string;
  nextCommand: string;
  expectedSignal: string;
  stopCondition: string;
}

function isVerifyFailureGuidance(value: unknown): value is VerifyFailureGuidance {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return v.checkpoint === "verify_failure"
    && ["diagnosis", "nextCommand", "expectedSignal", "stopCondition"]
      .every((key) => typeof v[key] === "string" && v[key].length > 0);
}
```

The MVP wire format is deliberately simpler than JSON: exactly four non-empty lines, in order—`Diagnosis: ...`, `Next command: ...`, `Expected signal: ...`, and `Stop condition: ...`—with no extra prose. Runtime validation requires that complete shape and exactly one command line. Invalid output receives one bounded unstructured-note wrapper, sets `structuredOutputValid: false`, and never triggers a format retry.

### Async-First Design

Reference calls remain abortable promises. Do not float promises unless using the already-bounded async-advisor path. Late results retain billed usage but are never injected after their deadline.

### Prompt Engineering Discipline

The verify-failure prompt requests four fields only: diagnosis, one next command, expected signal, and stop condition. It must state that tools are unavailable, task facts are limited to sanitized context, and unsupported mechanisms should be labeled uncertain.

### Context Window Management

Use latest genuine user request, successful mutation file list, failed verifier command/evidence, and redacted compact observations. Compaction summaries preserve task identity through their recognized host wrappers but are not treated as new user tasks.

### Cost and Latency Budget

- Strategy note: zero model cost.
- Verify-failure: at most one GLM call per task in MVP.
- Pre-done: one primary retry only when mechanical gate arms.
- Optional reference work is suppressed in reserve and must preserve all failed/cancelled usage telemetry.

---

## 5. Evaluation Strategy

### Dimensions

| Dimension | Rubric | Measurement | Priority |
|-----------|--------|-------------|----------|
| Trigger precision | ≥95% sampled fires match the declared typed state; zero unrelated fires | Code + trace audit | Critical |
| Tool-boundary safety | 100% reference calls have no tools/tool results | Code assertion + artifact scan | Critical |
| Verify-failure recovery | Actor runs the advised command or a clearly equivalent discriminating command within 3 tool turns | Trace classifier + human sample | High |
| Pass effect | Same-commit M3 is not worse than control; continuation requires targeted wins or strong recovery evidence | Terminal-Bench reward | High |
| Wall-time parity | Median wall time within 10% of control on non-fired trials; advisor overhead reported separately | Code metric | High |
| Ledger correctness | No checkpoint type exceeds its configured per-task cap | Code metric | Critical |
| Verification freshness | Final pre-done state reflects only verification after the last successful mutation | Unit tests + diagnostics | Critical |
| Guidance quality | Diagnosis is task-relevant and command is executable/available | Human 1–5 rubric | Medium |

### Eval Tooling

**Primary Tool:** Existing JSON traces plus tracked `scripts/aggregate-tb-results.ts`. No external tracing platform is added because that would change the measured harness and duplicate durable trace artifacts.

**Setup:**

```bash
npm run check
npm run tb:report -- --dir jobs/m3-typed --json .proof/reports/m3.json --md .proof/reports/m3.md
```

**CI/CD Integration:**

```bash
npm run check
```

### Reference Dataset

**Size:** Start with 12–20 same-commit trials per arm; accumulate to 50–100 clean trials before broad claims.

**Composition:**

- Passable four for continuity with M1/M2.
- Torch as a semantic-risk canary.
- Trace-mined verifier-failure scenarios: syntax/test failure, unavailable dependency, wrong assertion, stale verifier after mutation, command/quoting failure.
- Negative controls: read-only task, verifier already passing, failed write, near-reserve task.

**Labeling:** Code labels deterministic state. A senior engineer reviews every fire in the first arm and calibrates any automated adoption classifier. No uncalibrated LLM judge determines go/no-go.

### Arm Design

- **Control:** same-commit `gpt55-cliproxycodex-glm52-rescue-donegate`.
- **Treatment:** same primary/rescue/done-gate plus M3 typed strategy and verify-failure checkpoints.
- OMP runtime, effort high, integrity on, real task budgets, identical task seeds/config where Harbor permits.
- First look: passable four + torch, k=3. Continue only on trigger precision and mechanism evidence; do not claim small pass-rate lift.

---

## 6. Guardrails

### Online

| Guardrail | Trigger | Intervention |
|-----------|---------|--------------|
| Single-writer boundary | Reference context contains tools/toolResult/toolCall | Fail reference layer; continue primary-only |
| Per-type cap | Ledger count reached | Suppress checkpoint and emit reason |
| Time reserve | Insufficient reference budget | Suppress optional advisor; retain deterministic/done-gate behavior as configured |
| Stale async result | Settled after deadline or retention window | Account usage; do not inject |
| Invalid structured output | Required fields missing | One bounded markdown fallback; no retry loop |

### Offline

| Metric | Sampling | Action on Degradation |
|--------|----------|----------------------|
| Trigger precision | Every fire in first arm, then all anomalous fires | Fix classifier before more trials |
| Recovery/adoption | Every verify-failure fire | Revise or kill prompt/trigger if mostly ignored |
| Wall-time tax | Every arm | Park advisor if non-fired parity fails |
| Integrity | Every trial | Zero tainted rewards and quarantine trial |

---

## 7. Production Monitoring

**Tracing Tool:** Existing atomic JSON trace recorder and `gsd-moa.details`; external Phoenix/Langfuse intentionally not added for this benchmark phase.

**Key Metrics:** checkpoint trials/fires by type, suppression reason, recovery within N turns, reference duration/usage, done-gate outcome, pass/timeout/integrity rates.

**Alert Thresholds:** any tool-boundary violation; any cap violation; >10% unexplained trigger false positives; >10% non-fired wall-time regression; missing usage on failed/cancelled reference calls.

**Smart Sampling:** Review all first-arm fires, all failures after a checkpoint, all trials with more than one typed intervention, all stale-result/accounting events, and all treatment-only wins/losses.

---

## Prototype Acceptance Checklist

- [x] System type and domain stakes classified
- [x] Existing framework retained with alternatives rejected
- [x] Critical failure modes and guardrails specified
- [x] TypeScript structured-output equivalent documented
- [x] Evaluation dimensions and same-commit arm defined
- [x] Reference dataset composition defined
- [x] Tracing strategy explicitly keeps existing artifacts
- [x] `TypedCheckpoint` config/types and deterministic transition function implemented
- [x] Strategy note and one-shot verify-failure advisor integrated
- [x] Diagnostics and tracked aggregation extended by checkpoint type
- [ ] Unit and dual-runtime validation complete; live smoke and first controlled arm pending
