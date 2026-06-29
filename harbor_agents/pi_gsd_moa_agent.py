"""Harbor custom installed agent for Pi + gsd-moa experiments.

This adapter intentionally mirrors the plain-Pi Harbor adapter shape from
`badlogic/pi-terminal-bench`, while keeping the extra pieces needed for this
repo:

- install Node 24 and the @earendil-works Pi package;
- copy the mounted gsd-moa repo into the task container and load it with `-e`;
- source secrets from PI_GSD_MOA_ENV_FILE instead of passing API keys in argv;
- write Pi JSONL/session logs under /logs/agent so Harbor keeps them naturally;
- convert Pi JSONL to /logs/agent/trajectory.json (ATIF-v1.7);
- populate Harbor token/cost context from Pi's structured JSON output.

Usage:
  harbor run -d terminal-bench/terminal-bench-2 \
    --agent harbor_agents.pi_gsd_moa_agent:PiGsdMoaAgent

Configure with environment variables passed to Harbor/the task container:
  PI_GSD_MOA_MODEL=gsd-moa/gpt55-glm52-single   # or gsd-moa/gpt55-glm52-full / auto
  PI_GSD_MOA_REPO=/workspace/gsd-moa              # mounted repo copied to /tmp/gsd-moa-ext
  PI_GSD_MOA_EXTENSION=/tmp/gsd-moa-ext/src/index.ts
  PI_GSD_MOA_ENV_FILE=/workspace/gsd-moa/.proof/gsd-moa.env  # preferred for secrets
  PI_GSD_MOA_THINKING_LEVEL=high
  GSD_MOA_PRIMARY_BASE_URL=http://host.docker.internal:8317/v1
  GSD_MOA_GEMINI_BASE_URL=http://host.docker.internal:8318/v1
  GSD_MOA_CODEX_BASE_URL=http://host.docker.internal:8318/v1

Legacy quick-run fallback, only when PI_GSD_MOA_ENV_FILE is not set:
  FACTORY_GPT_API_KEY=...  # may appear in Harbor/docker exec argv
  ZAI_API_KEY=...          # may appear in Harbor/docker exec argv

The agent writes:
  /logs/agent/trajectory.json             # Harbor ATIF-v1.7 trajectory
  /logs/agent/pi-gsd-moa/pi-output.jsonl  # canonical Pi JSON stream
  /logs/agent/pi-gsd-moa/events.jsonl     # backwards-compatible copy
  /logs/agent/pi-gsd-moa/session.jsonl    # Pi session log
  /logs/agent/pi-gsd-moa/stderr.txt
  /logs/agent/pi-gsd-moa/traces/*.json    # provider-level MoA traces when enabled
"""

from __future__ import annotations

import json
import os
import shlex
from pathlib import Path
from typing import Any, Iterator

from harbor.agents.installed.base import BaseInstalledAgent, with_prompt_template
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext


DEFAULT_OUT_DIR = "/logs/agent/pi-gsd-moa"
PI_OUTPUT_NAME = "pi-output.jsonl"
EVENTS_NAME = "events.jsonl"
SESSION_NAME = "session.jsonl"
STDERR_NAME = "stderr.txt"

NON_SECRET_ENV_KEYS = [
    "GSD_MOA_TRACE",
    "GSD_MOA_TRACE_DIR",
    "GSD_MOA_PRIMARY_BASE_URL",
    "GSD_MOA_REFERENCE_BASE_URL",
    "GSD_MOA_GEMINI_BASE_URL",
    "GSD_MOA_CODEX_BASE_URL",
    "GSD_MOA_GEMINI_MODEL",
    "GSD_MOA_CODEX_MODEL",
    "PI_GSD_MOA_THINKING_LEVEL",
]

# Keep this intentionally narrow. Passing env vars through Harbor can expose them
# in host-side docker compose exec argv on some setups. Real benchmark runs should
# use PI_GSD_MOA_ENV_FILE instead.
LEGACY_SECRET_ENV_KEYS = ["FACTORY_GPT_API_KEY", "ZAI_API_KEY", "CLIPROXY_API_KEY"]


def _nvm_prefix() -> str:
    return (
        'export NVM_DIR="$HOME/.nvm"; '
        '[ -s "$NVM_DIR/nvm.sh" ] || '
        'curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.2/install.sh | bash; '
        '. "$NVM_DIR/nvm.sh"; '
        'nvm install 24; '
        'nvm use 24; '
    )


class PiGsdMoaAgent(BaseInstalledAgent):
    @staticmethod
    def name() -> str:
        return "pi-gsd-moa"

    async def install(self, environment: BaseEnvironment) -> None:
        await self.exec_as_root(
            environment,
            command="apt-get update && apt-get install -y ca-certificates curl git python3",
        )
        nvm_prefix = _nvm_prefix()
        await self.exec_as_agent(
            environment,
            command=(
                nvm_prefix
                + "npm install -g @earendil-works/pi-coding-agent && pi --version"
            ),
        )
        await self._copy_extension_repo(environment, nvm_prefix)

    async def _copy_extension_repo(self, environment: BaseEnvironment, nvm_prefix: str) -> None:
        repo = os.environ.get("PI_GSD_MOA_REPO", "/workspace/gsd-moa")
        workdir = os.environ.get("PI_GSD_MOA_WORKDIR", "/tmp/gsd-moa-ext")
        await self.exec_as_agent(
            environment,
            command=" ".join(
                [
                    "if [ -d",
                    shlex.quote(repo),
                    "]; then",
                    "rm -rf",
                    shlex.quote(workdir),
                    "&&",
                    "mkdir -p",
                    shlex.quote(workdir),
                    "&&",
                    "tar --exclude='./.proof' --exclude='./node_modules' --exclude='./.pi/gsd-moa-cache' --exclude='./.git' -cf - -C",
                    shlex.quote(repo),
                    ". | tar -xf - -C",
                    shlex.quote(workdir),
                    "&&",
                    "cd",
                    shlex.quote(workdir),
                    "&&",
                    nvm_prefix,
                    "(npm ci || npm install);",
                    "else echo 'PI_GSD_MOA_REPO not mounted; using PI_GSD_MOA_EXTENSION as-is'; fi",
                ]
            ),
        )

    @with_prompt_template
    async def run(self, instruction: str, environment: BaseEnvironment, context: AgentContext) -> None:
        out_dir = os.environ.get("PI_GSD_MOA_OUT", DEFAULT_OUT_DIR)
        secret_env_file = os.environ.get("PI_GSD_MOA_ENV_FILE")
        env = self._run_env(secret_env_file, out_dir)
        source_env = await self._prepare_secret_env(environment, secret_env_file) if secret_env_file else ""
        command = self._run_command(instruction, out_dir, source_env)
        await self.exec_as_agent(environment, command=command, env=env)

    def _run_env(self, secret_env_file: str | None, out_dir: str) -> dict[str, str]:
        env_keys = list(NON_SECRET_ENV_KEYS)
        if not secret_env_file:
            env_keys.extend(LEGACY_SECRET_ENV_KEYS)
        env = {key: value for key in env_keys if (value := os.environ.get(key))}
        env.setdefault("GSD_MOA_TRACE", "1")
        env.setdefault("GSD_MOA_TRACE_DIR", f"{out_dir}/traces")
        env.setdefault("GSD_MOA_PRIMARY_BASE_URL", "http://host.docker.internal:8317/v1")
        env.setdefault("GSD_MOA_GEMINI_BASE_URL", "http://host.docker.internal:8318/v1")
        env.setdefault("GSD_MOA_CODEX_BASE_URL", "http://host.docker.internal:8318/v1")
        return env

    async def _prepare_secret_env(self, environment: BaseEnvironment, secret_env_file: str) -> str:
        quoted_env_file = shlex.quote(secret_env_file)
        container_env_dir = "/tmp/gsd-moa-secrets"
        container_env_file = f"{container_env_dir}/env"
        quoted_container_env_dir = shlex.quote(container_env_dir)
        quoted_container_env_file = shlex.quote(container_env_file)

        await self.exec_as_agent(
            environment,
            command="id -u > /tmp/gsd-moa-agent.uid && id -g > /tmp/gsd-moa-agent.gid",
        )
        # Copy as root first so a host-side 0600 secret file remains usable even
        # when the container agent UID differs from the host UID. Put the copy
        # under a root-owned non-writable directory to avoid predictable /tmp
        # symlink attacks, then make only the agent user able to read it.
        await self.exec_as_root(
            environment,
            command=" ".join(
                [
                    "test -f",
                    quoted_env_file,
                    "|| { echo 'PI_GSD_MOA_ENV_FILE not found:'",
                    quoted_env_file,
                    ">&2; exit 2; };",
                    "agent_uid=$(cat /tmp/gsd-moa-agent.uid) &&",
                    "agent_gid=$(cat /tmp/gsd-moa-agent.gid) &&",
                    "rm -rf",
                    quoted_container_env_dir,
                    "&&",
                    "install -d -m 0711 -o root -g root",
                    quoted_container_env_dir,
                    "&&",
                    "install -m 0400 -o \"$agent_uid\" -g \"$agent_gid\"",
                    quoted_env_file,
                    quoted_container_env_file,
                ]
            ),
        )
        return " ".join(["set -a; .", quoted_container_env_file, "; set +a;"])

    def _resolve_model_name(self) -> str:
        env_model = os.environ.get("PI_GSD_MOA_MODEL")
        if env_model:
            return env_model
        harbor_model = getattr(self, "model_name", None)
        if harbor_model:
            return str(harbor_model)
        return "gsd-moa/gpt55-glm52-single"

    def _thinking_args(self) -> list[str]:
        level = os.environ.get("PI_GSD_MOA_THINKING_LEVEL")
        if not level:
            return []
        allowed = {"off", "minimal", "low", "medium", "high", "xhigh"}
        if level not in allowed:
            raise ValueError(f"invalid PI_GSD_MOA_THINKING_LEVEL={level!r}; expected one of {sorted(allowed)}")
        return ["--thinking", level]

    def _run_command(self, instruction: str, out_dir: str, source_env: str) -> str:
        model = self._resolve_model_name()
        extension = os.environ.get("PI_GSD_MOA_EXTENSION", "/tmp/gsd-moa-ext/src/index.ts")
        workdir = os.environ.get("PI_GSD_MOA_WORKDIR", "/tmp/gsd-moa-ext")
        converter = os.environ.get("PI_GSD_MOA_ATIF_CONVERTER", f"{workdir}/harbor_agents/atif_converter.py")
        trajectory_file = os.environ.get("PI_GSD_MOA_TRAJECTORY", "/logs/agent/trajectory.json")
        output_file = f"{out_dir}/{PI_OUTPUT_NAME}"
        events_file = f"{out_dir}/{EVENTS_NAME}"
        session_file = f"{out_dir}/{SESSION_NAME}"
        stderr_file = f"{out_dir}/{STDERR_NAME}"
        thinking_args = self._thinking_args()
        return " ".join(
            [
                "set -e;",
                "mkdir -p",
                shlex.quote(out_dir),
                "&&",
                source_env,
                'export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use 24 >/dev/null;',
                "set +e;",
                "pi -a",
                "-e",
                shlex.quote(extension),
                "--model",
                shlex.quote(model),
                "--mode json --session",
                shlex.quote(session_file),
                *[shlex.quote(arg) for arg in thinking_args],
                "-p",
                shlex.quote(instruction),
                ">",
                shlex.quote(output_file),
                "2>",
                shlex.quote(stderr_file),
                "; status=$?; set -e;",
                "cp",
                shlex.quote(output_file),
                shlex.quote(events_file),
                "2>/dev/null || true;",
                "if [ -f",
                shlex.quote(converter),
                "]; then python3",
                shlex.quote(converter),
                "--input",
                shlex.quote(output_file),
                "--output",
                shlex.quote(trajectory_file),
                "--agent-name pi-gsd-moa --agent-version",
                shlex.quote(self._agent_version()),
                "--model-name",
                shlex.quote(model),
                "--session",
                shlex.quote(session_file),
                "--trace-dir",
                shlex.quote(f"{out_dir}/traces"),
                ">>/dev/null 2>>",
                shlex.quote(stderr_file),
                "|| echo 'warning: failed to write ATIF trajectory' >>",
                shlex.quote(stderr_file),
                "; else echo 'warning: ATIF converter not found:'",
                shlex.quote(converter),
                ">>",
                shlex.quote(stderr_file),
                "; fi;",
                "exit $status",
            ]
        )

    def _agent_version(self) -> str:
        version_attr = getattr(self, "version", None)
        if callable(version_attr):
            version = version_attr()
        else:
            version = version_attr
        return str(version or "unknown")

    def populate_context_post_run(self, context: AgentContext) -> None:
        """Populate Harbor's token/cost summary from Pi JSON output.

        This mirrors badlogic/pi-terminal-bench's context population, with a few
        extra candidate paths for backwards-compatible `/tmp/pi-gsd-moa` runs.
        The final assistant usage already includes gsd-moa inner reference usage.
        """
        output_file = self._find_json_output_file()
        if output_file is None:
            print("pi-gsd-moa output file not found; context token/cost metrics unavailable")
            return

        totals = _usage_totals(output_file)
        context.n_input_tokens = int(totals["input"])
        context.n_output_tokens = int(totals["output"])
        context.n_cache_tokens = int(totals["cache_read"] + totals["cache_write"])
        context.cost_usd = totals["cost"] if totals["cost"] > 0 else None

    def _find_json_output_file(self) -> Path | None:
        candidates = [
            self.logs_dir / "pi-gsd-moa" / PI_OUTPUT_NAME,
            self.logs_dir / "pi-gsd-moa" / EVENTS_NAME,
            self.logs_dir / PI_OUTPUT_NAME,
            self.logs_dir / EVENTS_NAME,
            self.logs_dir / "artifacts" / "tmp" / "pi-gsd-moa" / PI_OUTPUT_NAME,
            self.logs_dir / "artifacts" / "tmp" / "pi-gsd-moa" / EVENTS_NAME,
            self.logs_dir / "artifacts" / "logs" / "agent" / "pi-gsd-moa" / PI_OUTPUT_NAME,
            self.logs_dir / "artifacts" / "logs" / "agent" / "pi-gsd-moa" / EVENTS_NAME,
        ]
        for path in candidates:
            if path.exists():
                return path
        return None


def _usage_totals(path: Path) -> dict[str, float]:
    totals = {
        "input": 0,
        "output": 0,
        "cache_read": 0,
        "cache_write": 0,
        "cost": 0.0,
    }
    for event in _jsonl_events(path):
        if event.get("type") != "message_end":
            continue
        message = event.get("message", {})
        if not isinstance(message, dict) or message.get("role") != "assistant":
            continue
        usage = message.get("usage", {})
        if not isinstance(usage, dict):
            continue
        totals["input"] += _number(usage.get("input"))
        totals["output"] += _number(usage.get("output"))
        totals["cache_read"] += _number(usage.get("cacheRead"))
        totals["cache_write"] += _number(usage.get("cacheWrite"))
        cost = usage.get("cost", {})
        if isinstance(cost, dict):
            totals["cost"] += _number(cost.get("total"))
    return totals


def _jsonl_events(path: Path) -> Iterator[dict[str, Any]]:
    with path.open() as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(event, dict):
                yield event


def _number(value: Any) -> float:
    if isinstance(value, bool) or value is None:
        return 0.0
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        try:
            return float(value)
        except ValueError:
            return 0.0
    return 0.0
