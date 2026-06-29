# Evaluation rubric and evidence snapshot

This project evaluates `gsd-moa` by asking one practical question: when does the extra advisor/full-MoA latency produce better coding-agent outcomes than plain single-model GPT-5.5?

Raw Harbor and Pi traces live under the gitignored `.proof/` directory. Do not commit raw traces; summarize sanitized outcomes here or in milestone notes.

## Modes under comparison

- `single`: one GPT-5.5 primary call path with normal Pi tools.
- `advisor`: one tool-less GLM-5.2 reference call, then one GPT-5.5 primary tool-capable call.
- `full_moa`: tool-less GLM-5.2 and GPT-5.5 reference calls, optional tool-less GPT-5.5 synthesis/execution memo, then one GPT-5.5 primary tool-capable call.

Safety invariant: reference and synthesis layers must remain tool-less; only the final primary call may receive or invoke tools.

## Human review rubric

For each proof case, record:

| Field | Question |
| --- | --- |
| Outcome | Did the task pass, fail, error, or timeout? |
| Delta vs single | Did advisor/full-MoA improve the final result, degrade it, or make no material difference? |
| Mechanism | Did references identify a useful strategy, catch a bug, reduce turns, or add misleading/noisy guidance? |
| Tool behavior | Did the final model use tools when task success required acting in the environment? |
| Safety | Do traces show reference/synthesis calls received no tools, tool calls, tool results, or Pi system prompt? |
| Cost/latency | Was the extra wall-clock time and token usage justified by the result difference? |
| Routing implication | Should `auto` choose `single`, `advisor`, or `full_moa` for this task shape? |

Suggested rating labels:

- `helped`: advisor/full-MoA passed where single failed, or produced a materially better verified result.
- `neutral`: same task outcome, with no clear quality improvement.
- `hurt`: worse outcome, no tool action when needed, misleading guidance, or unacceptable latency/cost.
- `implementation-bug`: evidence points to provider wiring, prompt framing, cache policy, or tracing issues rather than model capability.

## Current Terminal-Bench evidence snapshot

Snapshot date: 2026-06-28. Source artifacts are local under `.proof/harbor-jobs/` and may still be growing while benchmark runs continue.

| Task | single | full_moa | Current read |
| --- | --- | --- | --- |
| `fix-git` | pass | pass | Neutral: full-MoA was slower and used more tokens on an easy task. |
| `fix-code-vulnerability` | pass | pass | Mostly neutral: full-MoA solved in fewer turns but paid reference-layer overhead. |
| `configure-git-webserver` | pass | initially failed; Hermes-aligned variants passed | Prompt/tool-salience bug found and fixed/tuned; public execution note helped final actor use tools. |
| `torch-tensor-parallelism` | fail | pass | Helped: current full-MoA passed all verifier tests where single missed row-parallel cases. |
| `caffe-cifar-10` | fail/error | running at snapshot time | Pending; do not draw conclusions until the active Harbor run finishes. |

Useful local summaries:

- `.proof/harbor-jobs/fix-git-comparison.md`
- `.proof/harbor-jobs/difficult-task-comparison.md`
- `.proof/harbor-jobs/torch-tensor-parallelism-comparison.md`

## Early routing conclusions

- Keep `auto.defaultMode = single`.
- Prefer `single` for easy or routine tool-loop tasks; full-MoA can add latency without improving pass rate.
- Consider `advisor` or `full_moa` for high-leverage debugging, architecture critique, security review, and tasks where alternate implementation strategies are likely to matter.
- Full-MoA needs strong final-actor framing for hands-on terminal tasks: reference guidance is private advice, but the final actor must still act with tools when the user asks for environment changes.
- Cache hits after tool calls are expected today because sanitized reference contexts omit tool results. This is good for cost control but can make guidance stale; revisit if traces show references should incorporate summarized tool state.

## Operational notes

- The Factory GPT-5.5 primary route normally goes through the local proxy at `http://127.0.0.1:8317/v1` or Docker's `http://host.docker.internal:8317/v1`; its key may be a dummy value when the proxy does not authenticate.
- The GLM-5.2 reference route uses the Z.ai API directly by default and requires a real `ZAI_API_KEY` unless redirected to another proxy.
- Avoid exposing real API keys in long-running benchmark process arguments. For Harbor, prefer `PI_GSD_MOA_ENV_FILE=/workspace/gsd-moa/.proof/gsd-moa.env`; the custom agent sources that file inside the task container and does not pass `FACTORY_GPT_API_KEY` / `ZAI_API_KEY` through Harbor's env-value path.
