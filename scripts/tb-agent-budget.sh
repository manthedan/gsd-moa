#!/bin/bash
# Resolve a Terminal-Bench task's real agent time budget (ms) from harbor's
# local task cache, for export as GSD_MOA_BUDGET_MS so the provider's
# time-aware note reflects the actual ceiling instead of the 900000ms default.
#
# Usage:  GSD_MOA_BUDGET_MS=$(scripts/tb-agent-budget.sh <task-name> [package])
#         (package defaults to terminal-bench)
# Prints the budget in ms; falls back to 900000 when the task has never been
# downloaded (harbor populates ~/.cache/harbor/tasks on first run) or the
# [agent] timeout_sec cannot be parsed.
set -u
task="${1:?usage: tb-agent-budget.sh <task-name> [package]}"
package="${2:-terminal-bench}"
default_ms=900000

toml=$(ls -t "$HOME/.cache/harbor/tasks/packages/$package/$task"/*/task.toml 2>/dev/null | head -1)
if [ -z "$toml" ]; then
  echo "$default_ms"
  exit 0
fi

# Section-aware parse: take timeout_sec from the [agent] table only.
sec=$(awk '
  /^\[/{ in_agent = ($0 == "[agent]") }
  in_agent && /^[[:space:]]*timeout_sec[[:space:]]*=/ {
    gsub(/[^0-9.]/, "", $NF); print $NF; exit
  }
' "$toml")

case "$sec" in
  ''|*[!0-9.]*) echo "$default_ms" ;;
  *) awk -v s="$sec" 'BEGIN { printf "%d\n", s * 1000 }' </dev/null ;;
esac
