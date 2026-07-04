"""Harbor custom installed agent for Factory Droid as a bare-harness control.

This adapter runs Factory's ``droid`` CLI directly against the same CLIProxy
OpenAI-compatible endpoint used by the gsd-moa benchmark harness. Droid bypasses
this repo's Pi/OMP provider and therefore measures Factory's agent loop + the
plain backend model, not gsd-moa's orchestration.

Verified against Factory documentation on 2026-07-03; pending live verification
on the yukon Harbor runner because this workstation cannot run Harbor or Droid:

- Factory documents the official macOS/Linux installer as
  ``curl -fsSL https://app.factory.ai/cli | sh`` and non-interactive auth via
  ``FACTORY_API_KEY`` in the environment:
  https://docs.factory.ai/reference/cli-reference
- ``droid exec`` is the headless one-shot mode. Its current flags include
  ``-f/--file``, ``-m/--model``, ``--auto low|medium|high``,
  ``--cwd``, ``-o/--output-format`` with ``json``/``stream-json``, and
  ``-r/--reasoning-effort``:
  https://docs.factory.ai/cli/droid-exec/overview
- Current BYOK custom-model config is ``~/.factory/settings.json`` with a
  ``customModels`` array using camelCase fields. The legacy
  ``~/.factory/config.json``/snake_case format is still supported, but
  ``settings.json`` takes priority and supports ``apiKey`` environment-variable
  references. Provider values are ``anthropic``, ``openai``, and
  ``generic-chat-completion-api``. Reasoning effort is not a custom-model schema
  field; Factory's docs state reasoning effort is not yet supported for custom
  models. This arm therefore does not pass ``-r`` for the custom model and
  measures Droid at backend/default effort, comparable to the
  ``GSD_MOA_EFFORT=none`` control arm.

The agent writes:
  /logs/agent/droid/output.txt            # droid stdout (stream-json when supported)
  /logs/agent/droid/stderr.txt            # droid stderr + wrapper diagnostics
  /logs/agent/droid/output.stream-jsonl   # copy of stdout for integrity scans
  /logs/agent/droid/install.log           # install/config/version log
  /logs/agent/droid/prompt.txt            # exact prompt passed with -f
  /logs/agent/droid/settings.json         # redacted copy of Droid custom-model config
"""

from __future__ import annotations

import base64
import json
import os
import shlex
from pathlib import Path
from typing import Any, Iterator

from harbor.agents.installed.base import BaseInstalledAgent, with_prompt_template
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext


DEFAULT_OUT_DIR = "/logs/agent/droid"
OUTPUT_NAME = "output.txt"
STREAM_OUTPUT_NAME = "output.stream-jsonl"
STDERR_NAME = "stderr.txt"
INSTALL_LOG_NAME = "install.log"
PROMPT_NAME = "prompt.txt"
SETTINGS_COPY_NAME = "settings.json"

CUSTOM_DISPLAY_NAME = "GSD MOA Droid Control"
CUSTOM_MODEL_SELECTOR = "custom:GSD-MOA-Droid-Control-0"
DEFAULT_BASE_URL = "http://172.17.0.1:8318/v1"
DEFAULT_MODEL = "gpt-5.5"

NON_SECRET_ENV_KEYS = [
    "DROID_MODEL",
    "DROID_REASONING_EFFORT",
    "DROID_AUTONOMY",
    "GSD_MOA_CODEX_BASE_URL",
    "PI_GSD_MOA_ENV_FILE",
]


class DroidAgent(BaseInstalledAgent):
    @staticmethod
    def name() -> str:
        return "droid-control"

    async def install(self, environment: BaseEnvironment) -> None:
        await self.exec_as_root(
            environment,
            command=(
                "set -e; "
                "if command -v apt-get >/dev/null 2>&1; then "
                "  apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y ca-certificates curl git python3 bash unzip; "
                "elif command -v apk >/dev/null 2>&1; then apk add --no-cache ca-certificates curl git python3 bash unzip; "
                "elif command -v dnf >/dev/null 2>&1; then dnf install -y ca-certificates curl git python3 bash unzip; "
                "elif command -v yum >/dev/null 2>&1; then yum install -y ca-certificates curl git python3 bash unzip; "
                "fi"
            ),
        )
        await self.exec_as_agent(environment, command=self._install_command(), env=self._run_env())

    @with_prompt_template
    async def run(self, instruction: str, environment: BaseEnvironment, context: AgentContext) -> None:
        out_dir = DEFAULT_OUT_DIR
        secret_env_file = self._env_value("PI_GSD_MOA_ENV_FILE")
        source_env = await self._prepare_secret_env(environment, secret_env_file) if secret_env_file else self._missing_env_file_warning(out_dir)
        await self.exec_as_agent(
            environment,
            command=self._run_command(instruction, out_dir, source_env),
            env=self._run_env(),
        )

    def _env_value(self, key: str, default: str | None = None) -> str | None:
        return self.extra_env.get(key) or os.environ.get(key) or default

    def _run_env(self) -> dict[str, str]:
        env = {key: value for key in NON_SECRET_ENV_KEYS if (value := self._env_value(key))}
        env.setdefault("DROID_MODEL", DEFAULT_MODEL)
        env.setdefault("DROID_REASONING_EFFORT", "high")
        env.setdefault("DROID_AUTONOMY", "high")
        env.setdefault("GSD_MOA_CODEX_BASE_URL", DEFAULT_BASE_URL)
        return env

    def _install_command(self) -> str:
        out_dir = DEFAULT_OUT_DIR
        install_log = f"{out_dir}/{INSTALL_LOG_NAME}"
        return " ".join(
            [
                "set -e;",
                self._droid_path_exports(),
                "mkdir -p",
                shlex.quote(out_dir),
                "; {",
                "echo 'installing Factory Droid CLI via https://app.factory.ai/cli';",
                "curl -fsSL https://app.factory.ai/cli | sh;",
                self._droid_path_exports(),
                "echo 'droid binary:' $(command -v droid || true);",
                "droid --version || droid -v || true;",
                self._write_settings_shell(),
                "python3 - <<'PY'\n"
                "import json, pathlib\n"
                "src = pathlib.Path.home() / '.factory' / 'settings.json'\n"
                f"dst = pathlib.Path({out_dir!r}) / {SETTINGS_COPY_NAME!r}\n"
                "data = json.loads(src.read_text())\n"
                "for model in data.get('customModels', []):\n"
                "    model['apiKey'] = '${CLIPROXY_API_KEY}'\n"
                "dst.write_text(json.dumps(data, indent=2, sort_keys=True) + '\\n')\n"
                "PY\n",
                "} >",
                shlex.quote(install_log),
                "2>&1;",
                "cat",
                shlex.quote(install_log),
            ]
        )

    def _run_command(self, instruction: str, out_dir: str, source_env: str) -> str:
        output_file = f"{out_dir}/{OUTPUT_NAME}"
        stream_output_file = f"{out_dir}/{STREAM_OUTPUT_NAME}"
        stderr_file = f"{out_dir}/{STDERR_NAME}"
        prompt_file = f"{out_dir}/{PROMPT_NAME}"
        settings_copy = f"{out_dir}/{SETTINGS_COPY_NAME}"
        prompt_b64 = base64.b64encode(instruction.encode()).decode("ascii")
        autonomy = self._autonomy_level()

        return " ".join(
            [
                "set -e;",
                self._droid_path_exports(),
                "mkdir -p",
                shlex.quote(out_dir),
                "&&",
                source_env,
                'task_cwd="$PWD";',
                # Session auth: copy the auth.v2 pair from the mounted proof dir
                # (a working droid login copied from the dev machine). Preferred
                # over FACTORY_API_KEY, which stays supported via the env file.
                'auth_dir="${DROID_AUTH_DIR:-/workspace/gsd-moa/.proof/droid-auth}";',
                'if [ -f "$auth_dir/auth.v2.file" ] && [ -f "$auth_dir/auth.v2.key" ]; then',
                'mkdir -p "$HOME/.factory" && cp "$auth_dir"/auth.v2.file "$auth_dir"/auth.v2.key "$HOME/.factory/" && chmod 600 "$HOME/.factory"/auth.v2.*;',
                'fi;',
                "python3 - <<'PY'\n"
                "import base64, pathlib\n"
                f"path = pathlib.Path({prompt_file!r})\n"
                f"path.write_bytes(base64.b64decode({prompt_b64!r}))\n"
                "PY\n",
                self._write_settings_shell(),
                "python3 - <<'PY'\n"
                "import json, pathlib\n"
                "src = pathlib.Path.home() / '.factory' / 'settings.json'\n"
                f"dst = pathlib.Path({settings_copy!r})\n"
                "data = json.loads(src.read_text())\n"
                "for model in data.get('customModels', []):\n"
                "    model['apiKey'] = '${CLIPROXY_API_KEY}'\n"
                "dst.write_text(json.dumps(data, indent=2, sort_keys=True) + '\\n')\n"
                "PY\n",
                "{ echo 'droid run started:' $(date -Is);",
                "  echo 'cwd:' \"$task_cwd\";",
                "  echo 'model selector:'",
                shlex.quote(CUSTOM_MODEL_SELECTOR),
                "; echo 'backend model:' \"${DROID_MODEL:-" + DEFAULT_MODEL + "}\";",
                "  echo 'autonomy:'",
                shlex.quote(autonomy),
                "; echo 'reasoning effort requested but not passed for custom models:' \"${DROID_REASONING_EFFORT:-high}\";",
                "} >",
                shlex.quote(stderr_file),
                "; set +e;",
                "droid exec",
                "--cwd \"$task_cwd\"",
                "--auto",
                shlex.quote(autonomy),
                "-m",
                shlex.quote(CUSTOM_MODEL_SELECTOR),
                "--output-format stream-json",
                "-f",
                shlex.quote(prompt_file),
                ">",
                shlex.quote(output_file),
                "2>>",
                shlex.quote(stderr_file),
                "; status=$?; set -e;",
                "cp",
                shlex.quote(output_file),
                shlex.quote(stream_output_file),
                "2>/dev/null || true;",
                "echo 'droid exit status:' $status >>",
                shlex.quote(stderr_file),
                "; exit $status",
            ]
        )

    def _write_settings_shell(self) -> str:
        # Writes current Factory settings format. The API key is intentionally an
        # environment reference, not the secret value; PI_GSD_MOA_ENV_FILE is
        # sourced immediately before droid runs so Droid can expand it locally.
        return (
            "python3 - <<'PY'\n"
            "import json, os, pathlib\n"
            "factory = pathlib.Path.home() / '.factory'\n"
            "factory.mkdir(parents=True, exist_ok=True)\n"
            "settings = factory / 'settings.json'\n"
            "data = {}\n"
            "if settings.exists():\n"
            "    try:\n"
            "        data = json.loads(settings.read_text() or '{}')\n"
            "    except json.JSONDecodeError:\n"
            "        backup = settings.with_suffix('.json.invalid')\n"
            "        backup.write_text(settings.read_text())\n"
            "        data = {}\n"
            f"entry = {{'model': os.environ.get('DROID_MODEL', {DEFAULT_MODEL!r}), "
            f"'displayName': {CUSTOM_DISPLAY_NAME!r}, "
            f"'id': {CUSTOM_MODEL_SELECTOR!r}, "
            "'index': 0, "
            "'baseUrl': os.environ.get('GSD_MOA_CODEX_BASE_URL', "
            f"{DEFAULT_BASE_URL!r}), "
            "'apiKey': '${CLIPROXY_API_KEY}', "
            # provider 'openai' matches the dev machine's proven CLIProxy custom
            # model config (droid 0.147.0); the generic provider also works but
            # the openai path is the one verified against this endpoint.
            "'provider': 'openai', "
            "'noImageSupport': False, "
            "'maxOutputTokens': 65536}\n"
            f"custom = [m for m in data.get('customModels', []) if m.get('displayName') != {CUSTOM_DISPLAY_NAME!r}]\n"
            "data['customModels'] = [entry] + custom\n"
            "settings.write_text(json.dumps(data, indent=2, sort_keys=True) + '\\n')\n"
            "PY\n"
        )

    def _droid_path_exports(self) -> str:
        return 'export PATH="$HOME/.factory/bin:$HOME/.local/bin:$HOME/bin:/usr/local/bin:$PATH";'

    def _autonomy_level(self) -> str:
        level = self._env_value("DROID_AUTONOMY", "high") or "high"
        allowed = {"low", "medium", "high"}
        if level not in allowed:
            raise ValueError(f"invalid DROID_AUTONOMY={level!r}; expected one of {sorted(allowed)}")
        return level

    def _missing_env_file_warning(self, out_dir: str) -> str:
        return " ".join(
            [
                "mkdir -p",
                shlex.quote(out_dir),
                "&& echo 'warning: PI_GSD_MOA_ENV_FILE not set; FACTORY_API_KEY and CLIPROXY_API_KEY were not injected by DroidAgent' >>",
                shlex.quote(f"{out_dir}/{STDERR_NAME}"),
                ";",
            ]
        )

    async def _prepare_secret_env(self, environment: BaseEnvironment, secret_env_file: str) -> str:
        quoted_env_file = shlex.quote(secret_env_file)
        container_env_dir = "/tmp/droid-agent-secrets"
        container_env_file = f"{container_env_dir}/env"
        quoted_container_env_dir = shlex.quote(container_env_dir)
        quoted_container_env_file = shlex.quote(container_env_file)

        await self.exec_as_agent(
            environment,
            command="id -u > /tmp/droid-agent.uid && id -g > /tmp/droid-agent.gid",
        )
        await self.exec_as_root(
            environment,
            command=" ".join(
                [
                    "test -f",
                    quoted_env_file,
                    "|| { echo 'PI_GSD_MOA_ENV_FILE not found:'",
                    quoted_env_file,
                    ">&2; exit 2; };",
                    "agent_uid=$(cat /tmp/droid-agent.uid) &&",
                    "agent_gid=$(cat /tmp/droid-agent.gid) &&",
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

    def populate_context_post_run(self, context: AgentContext) -> None:
        output_file = self._find_output_file()
        if output_file is None:
            print("droid output file not found; context token/cost metrics unavailable")
            return

        totals = _usage_totals(output_file)
        if not totals["reported"]:
            print("droid output did not report usage; context token/cost metrics unavailable")
            return

        context.n_input_tokens = int(totals["input"])
        context.n_output_tokens = int(totals["output"])
        context.n_cache_tokens = int(totals["cache_read"] + totals["cache_write"])
        context.cost_usd = totals["cost"] if totals["cost"] > 0 else None

    def _find_output_file(self) -> Path | None:
        candidates = [
            self.logs_dir / "droid" / OUTPUT_NAME,
            self.logs_dir / "droid" / STREAM_OUTPUT_NAME,
            self.logs_dir / OUTPUT_NAME,
            self.logs_dir / STREAM_OUTPUT_NAME,
            self.logs_dir / "artifacts" / "logs" / "agent" / "droid" / OUTPUT_NAME,
            self.logs_dir / "artifacts" / "logs" / "agent" / "droid" / STREAM_OUTPUT_NAME,
        ]
        for path in candidates:
            if path.exists():
                return path
        return None


def _usage_totals(path: Path) -> dict[str, float | bool]:
    totals: dict[str, float | bool] = {
        "input": 0.0,
        "output": 0.0,
        "cache_read": 0.0,
        "cache_write": 0.0,
        "cost": 0.0,
        "reported": False,
    }
    for event in _json_events(path):
        for usage in _usage_dicts(event):
            totals["reported"] = True
            totals["input"] = float(totals["input"]) + _first_number(
                usage,
                "input_tokens",
                "inputTokens",
                "prompt_tokens",
                "promptTokens",
                "input",
            )
            totals["output"] = float(totals["output"]) + _first_number(
                usage,
                "output_tokens",
                "outputTokens",
                "completion_tokens",
                "completionTokens",
                "output",
            )
            totals["cache_read"] = float(totals["cache_read"]) + _first_number(
                usage,
                "cache_read_tokens",
                "cacheReadTokens",
                "cache_read",
                "cacheRead",
            )
            totals["cache_write"] = float(totals["cache_write"]) + _first_number(
                usage,
                "cache_write_tokens",
                "cacheWriteTokens",
                "cache_write",
                "cacheWrite",
            )
            cost = usage.get("cost")
            if isinstance(cost, dict):
                totals["cost"] = float(totals["cost"]) + _first_number(cost, "total", "usd", "cost_usd", "costUsd")
            else:
                totals["cost"] = float(totals["cost"]) + _number(usage.get("cost_usd", usage.get("costUsd")))
    return totals


def _json_events(path: Path) -> Iterator[dict[str, Any]]:
    text = path.read_text(errors="replace").strip()
    if not text:
        return
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError:
        parsed = None
    if isinstance(parsed, dict):
        yield parsed
        return
    if isinstance(parsed, list):
        for item in parsed:
            if isinstance(item, dict):
                yield item
        return
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(event, dict):
            yield event


def _usage_dicts(value: Any) -> Iterator[dict[str, Any]]:
    if isinstance(value, dict):
        for key in ("usage", "token_usage", "tokenUsage"):
            usage = value.get(key)
            if isinstance(usage, dict):
                yield usage
        for child in value.values():
            yield from _usage_dicts(child)
    elif isinstance(value, list):
        for child in value:
            yield from _usage_dicts(child)


def _first_number(values: dict[str, Any], *keys: str) -> float:
    for key in keys:
        number = _number(values.get(key))
        if number:
            return number
    return 0.0


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
