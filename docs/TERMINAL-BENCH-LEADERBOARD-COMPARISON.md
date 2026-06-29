# Terminal-Bench Results vs Public Leaderboards

Date: 2026-06-29

This compares our local one-trial `pi-gsd-moa` A/B runs against three public Terminal-Bench 2.0 task-level leaderboard pages:

- Codex CLI / GPT-5.5
- NexAU-AHE / GPT-5.5
- LemonHarness / Gemini 3.1 Pro Preview + GPT-5.3-Codex

The public pages report 5 trials per task, while our runs are currently 1 trial per mode. Use this as a triage map, not a statistical claim.

## Comparison table

| Task | Our single | Our full-MoA | Codex GPT-5.5 | NexAU GPT-5.5 | Lemon mixed top agent | Read |
|---|---:|---:|---:|---:|---:|---|
| `torch-tensor-parallelism` | 0/1 | 1/1 | 0/5 (0%) | 0/5 (0%) | 4/5 (80%) | Public GPT-5.5-hard; newer/mixed agent solves sometimes |
| `caffe-cifar-10` | 0/1 | 0/1 | 0/5 (0%) | 3/5 (60%) | 3/5 (60%) | Our harness/provider underperformed vs leaders |
| `overfull-hbox` | 0/1 | 1/1 | 3/5 (60%) | 3/5 (60%) | 1/5 (20%) | Local MoA win; solvable/high variance |
| `install-windows-3-11` | 0/1 | 0/1 | 0/5 (0%) | 2/5 (40%) | 0/5 (0%) | Hard but not out of reach |
| `make-doom-for-mips` | 0/1 | 0/1 | 1/5 (20%) | 0/5 (0%) | 0/5 (0%) | Very hard / low public success |
| `gcode-to-text` | 0/1 | 0/1 | 2/5 (40%) | 0/5 (0%) | 3/5 (60%) | Our harness/provider underperformed vs leaders |
| `mteb-leaderboard` | 0/1 | 0/1 | 5/5 (100%) | 3/5 (60%) | 4/5 (80%) | Our harness/provider underperformed vs leaders |
| `raman-fitting` | 0/1 | 0/1 | 2/5 (40%) | 0/5 (0%) | 4/5 (80%) | Our harness/provider underperformed vs leaders |
| `extract-elf` | 1/1 | 1/1 | 4/5 (80%) | 0/5 (0%) | 5/5 (100%) | Clearly reachable by current agents |
| `mcmc-sampling-stan` | 0/1 | 0/1 | 2/5 (40%) | 3/5 (60%) | 4/5 (80%) | Our harness/provider underperformed vs leaders |
| `filter-js-from-html` | 0/1 | 0/1 | 0/5 (0%) | 0/5 (0%) | 0/5 (0%) | Frontier-hard among these leaders |
| `dna-insert` | 0/1 | 0/1 | 3/5 (60%) | 3/5 (60%) | 5/5 (100%) | Our harness/provider underperformed vs leaders |

## Triage

### Likely out of reach for the compared top agents right now

- `filter-js-from-html`: our single and full-MoA both failed; all three referenced public leaderboard agents are `0/5`. This is the cleanest “frontier-hard” item in this slice.

### Public GPT-5.5-hard, but not impossible for newer/mixed agents

- `torch-tensor-parallelism`: Codex GPT-5.5 and NexAU GPT-5.5 are both `0/5`, while Lemon mixed is `4/5`. Our full-MoA passed once, making this the strongest evidence that model fusion can lift a GPT-5.5 failure mode.
- `install-windows-3-11`: Codex GPT-5.5 is `0/5`, Lemon mixed is `0/5`, NexAU GPT-5.5 is `2/5`; both of our runs failed. This is still worth treating as very hard, but not strictly impossible.
- `make-doom-for-mips`: public best among these is only Codex GPT-5.5 at `1/5`; our runs both failed and full-MoA timed out. This looks low-yield for short-term tuning.

### Not out of reach; our current harness/provider underperformed

These failed locally but public agents solve them often, so they are better debugging/tuning targets than “impossible” tasks:

- `mteb-leaderboard`: public rates are `5/5`, `3/5`, `4/5`; our single and full-MoA both failed.
- `dna-insert`: public rates are `3/5`, `3/5`, `5/5`; our single and full-MoA both failed.
- `mcmc-sampling-stan`: public rates are `2/5`, `3/5`, `4/5`; our runs both timed out/failed.
- `raman-fitting`: public rates are `2/5`, `0/5`, `4/5`; our full-MoA timed out.
- `caffe-cifar-10`: Codex GPT-5.5 is `0/5`, but NexAU GPT-5.5 and Lemon mixed are both `3/5`; our failures may be harness/time/environment-sensitive.
- `gcode-to-text`: Codex and Lemon solve some trials (`2/5`, `3/5`), though NexAU is `0/5`; our failure is not definitive.

### Solvable / high-variance tasks where MoA already helped

- `overfull-hbox`: public rates vary (`3/5`, `3/5`, `1/5`), but our full-MoA passed while single failed. Good candidate for repeat trials.
- `torch-tensor-parallelism`: because public GPT-5.5 agents are `0/5` but Lemon mixed is `4/5`, this is the best repeat-trial candidate for proving MoA can recover a public GPT-5.5 miss.

## Recommended next eval choices

1. Repeat `torch-tensor-parallelism` and `overfull-hbox` with `k>=3` per mode. These are the current positive signal.
2. Debug `mteb-leaderboard` and `dna-insert` before retesting; public leaders show they should be reachable.
3. Treat `filter-js-from-html` as a frontier-hard stress test, not an immediate tuning target.
4. Deprioritize `make-doom-for-mips` and `install-windows-3-11` unless we specifically want long-runtime/build-system stress.

## Sources

- https://www.tbench.ai/leaderboard/terminal-bench/2.0/codex/0.121.0/gpt-5.5%40openai
- https://www.tbench.ai/leaderboard/terminal-bench/2.0/nexau/unknown/gpt-5.5%40openai
- https://www.tbench.ai/leaderboard/terminal-bench/2.0/Lemoncode-agent/1.0.0/gemini-3.1-pro-preview%40google%2Cgpt-5.3-codex%40openai
