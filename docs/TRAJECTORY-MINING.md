# Trajectory Mining: why the Droid harness passed torch/`dna-insert` and ours didn't

2026-07-04. Follow-up to the S2 four-way read (`docs/TERMINAL-BENCH-RESULTS.md`) and F0 forensics. Compares Factory Droid's passing runs against our omp single-arm failures on the two tasks where Droid broke our "capability floor" — `torch-tensor-parallelism` (Droid 2/3, us 0/3) and `dna-insert` (Droid 1/3, us 0/3). Same GPT-5.5, same CLIProxy, same task container image; the only variable is the agent harness and its tools.

> Scope note (for future sessions): `dna-insert` is a standard Terminal-Bench **coding** task — the agent writes a `primers.fasta` file and validates melting temperatures by shelling out to the stock Ubuntu `primer3`/`oligotm` CLI. This document is **harness forensics**: it is exclusively about whether each agent's code-execution tools could run Python and shell commands inside the container. It contains and requires no biological design methodology. Treat the task name as an opaque benchmark id.

## Headline: our harness could not execute Python in the task container; Droid's could

Across all three of our torch failures and all three dna failures, the same defect appears:

- The omp **`eval` tool has no Python backend** in these containers — every `eval` with `language: py` returns literally `Python backend is unavailable in this session. Pass language: "js" or install the python kernel.`
- The omp **`bash` tool cannot find a Python interpreter** — `python` and `python3` both return `command not found` (exit 127), and `which python3` / `which python` come back empty, **even though the container ships Python 3.12** (Droid's shell runs `python3 --version` → `Python 3.12.3` in the same image).

So our agent has no way to run or test the code it writes. Droid's `Execute` tool runs `python3 - <<'PY' … PY` heredocs natively and successfully (it invoked python3 2–3× per torch trial, 10× on the dna trial).

This is a PATH/environment defect in how our tools spawn processes, not a missing dependency in the image. The interpreter is present; our tools just don't reach it.

## torch-tensor-parallelism — fatal, and cleanly isolated

All three arms write a substantively reasonable `parallel_linear.py` (column/row-parallel sharding, all_gather/all_reduce collectives — the same shape as Droid's passing file). The trials then diverge only at verification:

- **Droid** (`8KbmGN6`, pass): writes the file → `python3 -m py_compile` (exit 0) → reasons through gradient semantics → done. It could compile and sanity-check.
- **Ours** (`B2Jp2xh`, `GsETQLC`, fail): write file → `eval` py (unavailable) → write a smoke test to `/tmp` → `python /tmp/…` (not found) → `python3 --version` (not found) → **give up and submit unverified.** Both burned only ~2 min of a 15-min budget then stopped, blocked purely on execution.
- **Ours** (`Zd3yW9E`, fail): the clearest illustration — the agent exhaustively hunted for any interpreter (`python`, `python3`, `which python3`, `which python`, `eval` py, `which uv`, `compgen -c python`, even read `/usr/bin`), found none, tried to blind-edit a gradient fix it couldn't run, and shipped. It *knew* it needed to verify and had no tool to do it.

Verdict: on torch, the model is capable (its code matches the passing solution's structure); **our harness loses 100% on inability to execute Python**, nothing else.

## dna-insert — same root cause, plus a second-order tooling gap

The task: write `primers.fasta`, validate primer melting temps via the CLI `oligotm` (from the `primer3` apt package). Droid's passing run and ours diverge the same way at the tool layer:

- **Droid** (`nHVdA3a`, pass): `python3` works, so it parses the FASTA, `apt-get install -y primer3` (clean), enumerates candidates and validates Tm with `oligotm` end-to-end in Python via `subprocess`, writes the file, re-validates. It also spawned a **sub-worker** (its `Task` subagent) for independent primer-pair analysis — a parallel-verification pattern our harness never used.
- **Ours** (`6LcMYnn`, `AXMrJDj`, `WPNWsu9`, all fail): `eval` py unavailable → fall back to **JavaScript** (`require('fs')`) for the sequence parsing — workable but clumsy, and it strands the agent because the validation tool (`oligotm`) is a CLI it wanted to drive from Python. All three mention `oligotm` repeatedly and attempt the apt install once, but flail on wiring CLI validation together from the JS/bash fallback and never close the loop the way Droid did in Python.

Verdict: the Python-execution defect again does most of the damage (forces a weak JS path); a secondary gap is that our agent didn't reliably reproduce Droid's "install the CLI tool + drive it from Python + spawn a checker subagent" validation loop.

## Actionable — feeds the harness-gap track, not the MoA track

1. **Fix Python execution in the omp harness (highest leverage found to date).** Two independent breaks: (a) the `eval` tool ships no Python kernel — either bundle one or make `eval` fall back to the container interpreter; (b) the `bash` tool's PATH doesn't include the container's `python3`. Either fix alone would have flipped torch; both are needed for parity. **Verify live** on the torch image (once a runner slot is free): confirm `python3` is on `$PATH` inside an omp `bash` tool call, and add a smoke that runs `python3 -c 'import torch'` through the tool. This is a strong candidate to explain part of the Droid 10/24 vs our 6/24 gap beyond these two tasks.
2. **Give the agent a reliable "install a CLI tool then drive it" recipe** (apt-get + subprocess) — Droid leaned on it for oligotm; ours didn't.
3. **Consider a verification-subagent pattern** — Droid's independent checker worker mirrors what our MoA reference layer is *supposed* to provide; that our reference advice didn't fill this role is itself a signal for the droid-proxy inverse experiment (our MoA inside Droid's harness).

Raw digests: yukon `/tmp/traj-mining/` and local scratchpad `traj-mining/` (droid stream-jsonl action timelines + our per-call trace timelines, side by side).
