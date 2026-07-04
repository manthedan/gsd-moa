"""Harbor custom installed agent for Pi + gsd-moa experiments.

This adapter intentionally mirrors the plain-Pi Harbor adapter shape from
`badlogic/pi-terminal-bench`, while keeping the extra pieces needed for this
repo:

- install Node 24 plus Bun for the local oh-my-pi CLI, or Node 24 only for upstream pi;
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
  PI_GSD_MOA_CLI=omp                     # omp (default) or pi
  PI_GSD_MOA_RUNTIME_TAR=/workspace/gsd-moa/.proof/omp-runtime.tar  # optional prebuilt OMP bundle
  PI_GSD_MOA_PI_RUNTIME_TAR=/workspace/gsd-moa/.proof/pi-runtime.tar  # optional prebuilt pi bundle
  PI_GSD_MOA_THINKING_LEVEL=high        # default; set inherit to omit --thinking
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
    "GSD_MOA_DEADLINE_EPOCH_MS",
    "GSD_MOA_BUDGET_MS",
    "GSD_MOA_PRIMARY_BASE_URL",
    "GSD_MOA_REFERENCE_BASE_URL",
    "GSD_MOA_GEMINI_BASE_URL",
    "GSD_MOA_CODEX_BASE_URL",
    "GSD_MOA_GEMINI_MODEL",
    "GSD_MOA_CODEX_MODEL",
    "GSD_MOA_EFFORT",
    "GSD_MOA_CHECKPOINT_SCOPES",
    "GSD_MOA_REFERENCE_MAX_TOKENS",
    "GSD_MOA_BENCH_INTEGRITY",
    "PI_GSD_MOA_THINKING_LEVEL",
]

# Keep this intentionally narrow. Passing env vars through Harbor can expose them
# in host-side docker compose exec argv on some setups. Real benchmark runs should
# use PI_GSD_MOA_ENV_FILE instead.
LEGACY_SECRET_ENV_KEYS = ["FACTORY_GPT_API_KEY", "ZAI_API_KEY", "CLIPROXY_API_KEY"]


def _node_runtime_prefix() -> str:
    return (
        'export NVM_DIR="$HOME/.nvm"; '
        '[ -s "$NVM_DIR/nvm.sh" ] || '
        'curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.2/install.sh | bash; '
        '. "$NVM_DIR/nvm.sh"; '
        'nvm install 24; '
        'nvm use 24; '
    )


def _runtime_prefix() -> str:
    return (
        _node_runtime_prefix()
        + 'export BUN_INSTALL="$HOME/.bun"; '
        'export PATH="$BUN_INSTALL/bin:$PATH"; '
        '[ -x "$BUN_INSTALL/bin/bun" ] || curl -fsSL https://bun.sh/install | bash; '
    )


class PiGsdMoaAgent(BaseInstalledAgent):
    @staticmethod
    def name() -> str:
        return "pi-gsd-moa"

    def _cli_mode(self) -> str:
        mode = self._env_value("PI_GSD_MOA_CLI", "omp") or "omp"
        if mode not in {"omp", "pi"}:
            raise ValueError(f"invalid PI_GSD_MOA_CLI={mode!r}; expected 'omp' or 'pi'")
        return mode

    async def install(self, environment: BaseEnvironment) -> None:
        cli_mode = self._cli_mode()
        runtime_tar_key = "PI_GSD_MOA_PI_RUNTIME_TAR" if cli_mode == "pi" else "PI_GSD_MOA_RUNTIME_TAR"
        runtime_tar_default = "/workspace/gsd-moa/.proof/pi-runtime.tar" if cli_mode == "pi" else "/workspace/gsd-moa/.proof/omp-runtime.tar"
        runtime_tar = self._env_value(runtime_tar_key, runtime_tar_default)

        if cli_mode == "pi":
            await self.exec_as_root(
                environment,
                command=(
                    "set -e; "
                    "if command -v apt-get >/dev/null 2>&1; then "
                    "  apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y ca-certificates curl git python3 unzip; "
                    "elif command -v apk >/dev/null 2>&1; then apk add --no-cache ca-certificates curl git python3 unzip; "
                    "elif command -v dnf >/dev/null 2>&1; then dnf install -y ca-certificates curl git python3 unzip; "
                    "elif command -v yum >/dev/null 2>&1; then yum install -y ca-certificates curl git python3 unzip; "
                    "fi"
                ),
            )
            runtime_prefix = _node_runtime_prefix()
            await self.exec_as_agent(environment, command=runtime_prefix + "node --version")
            if runtime_tar:
                installed = await self._install_prebuilt_runtime(environment, runtime_tar, cli_mode)
                if installed:
                    await self._copy_extension_repo(environment, runtime_prefix="", install_deps=False, preserve_runtime=True)
                    return
            await self._copy_extension_repo(environment, runtime_prefix)
            return

        if runtime_tar:
            installed = await self._install_prebuilt_runtime(environment, runtime_tar, cli_mode)
            if installed:
                await self._copy_extension_repo(environment, runtime_prefix="", install_deps=False, preserve_runtime=True)
                return

        apk_branch = (
            "  apk add --no-cache ca-certificates curl git python3 unzip; "
            if cli_mode == "pi"
            else "  echo 'ERROR: Alpine/musl base image; @oh-my-pi/pi-natives ships no musl prebuilt' >&2; exit 3; "
        )
        await self.exec_as_root(
            environment,
            command=(
                "set -e; "
                "if command -v apt-get >/dev/null 2>&1; then "
                "  apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y ca-certificates curl git python3 unzip; "
                "elif command -v apk >/dev/null 2>&1; then "
                + apk_branch +
                "elif command -v dnf >/dev/null 2>&1; then dnf install -y ca-certificates curl git python3 unzip; "
                "elif command -v yum >/dev/null 2>&1; then yum install -y ca-certificates curl git python3 unzip; "
                "fi"
            ),
        )
        runtime_prefix = _node_runtime_prefix() if cli_mode == "pi" else _runtime_prefix()
        await self.exec_as_agent(
            environment,
            command=runtime_prefix + ("node --version" if cli_mode == "pi" else "node --version && bun --version"),
        )
        await self._copy_extension_repo(environment, runtime_prefix)

    async def _install_prebuilt_runtime(self, environment: BaseEnvironment, runtime_tar: str, cli_mode: str) -> bool:
        workdir = self._env_value("PI_GSD_MOA_WORKDIR", "/tmp/gsd-moa-ext")
        quoted_runtime_tar = shlex.quote(runtime_tar)
        quoted_workdir = shlex.quote(workdir or "/tmp/gsd-moa-ext")
        if cli_mode == "pi":
            command_parts = [
                "if [ ! -f",
                quoted_runtime_tar,
                "]; then echo '__GSD_MOA_PREBUILT_MISSING__'; exit 0; fi;",
                "(",
                "rm -rf",
                quoted_workdir,
                "&& mkdir -p",
                quoted_workdir,
                "&& tar -xf",
                quoted_runtime_tar,
                "-C",
                quoted_workdir,
                "&& cd",
                quoted_workdir,
                "&& node --version && ./node_modules/.bin/pi --version",
                "&& echo '__GSD_MOA_PREBUILT_READY__'",
                ") || { echo '__GSD_MOA_PREBUILT_FAILED__'; exit 0; }",
            ]
        else:
            command_parts = [
                "if [ ! -f",
                quoted_runtime_tar,
                "]; then echo '__GSD_MOA_PREBUILT_MISSING__'; exit 0; fi;",
                "if ls /lib/ld-musl-* >/dev/null 2>&1; then echo '__GSD_MOA_PREBUILT_MUSL_UNSUPPORTED__'; exit 0; fi;",
                "(",
                "rm -rf",
                quoted_workdir,
                "&& mkdir -p",
                quoted_workdir,
                "&& tar -xf",
                quoted_runtime_tar,
                "-C",
                quoted_workdir,
                "&& arch=$(uname -m) && case \"$arch\" in",
                "aarch64|arm64) bun_src=.bun/bin/bun-linux-aarch64 ;;",
                "x86_64|amd64) bun_src=.bun/bin/bun-linux-x64-baseline ;;",
                "*) echo \"unsupported arch $arch\" >&2; exit 4 ;; esac &&",
                "cd",
                quoted_workdir,
                "&& if [ -f \"$bun_src\" ]; then cp \"$bun_src\" .bun/bin/bun; fi &&",
                "chmod +x .bun/bin/bun &&",
                f"export BUN_INSTALL={quoted_workdir}/.bun;",
                'export PATH="$BUN_INSTALL/bin:$PATH";',
                "export PI_NATIVE_VARIANT=${PI_NATIVE_VARIANT:-baseline};",
                "bun --version && ./node_modules/.bin/omp --version",
                "&& echo '__GSD_MOA_PREBUILT_READY__'",
                ") || { echo '__GSD_MOA_PREBUILT_FAILED__'; exit 0; }",
            ]
        result = await self.exec_as_agent(
            environment,
            command=(_node_runtime_prefix() if cli_mode == "pi" else "") + " ".join(command_parts),
        )
        return "__GSD_MOA_PREBUILT_READY__" in (result.stdout or "")

    def _env_value(self, key: str, default: str | None = None) -> str | None:
        return self.extra_env.get(key) or os.environ.get(key) or default

    async def _copy_extension_repo(
        self,
        environment: BaseEnvironment,
        runtime_prefix: str,
        *,
        install_deps: bool = True,
        preserve_runtime: bool = False,
    ) -> None:
        repo = self._env_value("PI_GSD_MOA_REPO", "/workspace/gsd-moa")
        workdir = self._env_value("PI_GSD_MOA_WORKDIR", "/tmp/gsd-moa-ext")
        quoted_workdir = shlex.quote(workdir)
        prepare_workdir = (
            "mkdir -p "
            + quoted_workdir
            + " && for path in "
            + quoted_workdir
            + "/* "
            + quoted_workdir
            + "/.[!.]* "
            + quoted_workdir
            + "/..?*; do [ -e \"$path\" ] || continue; base=$(basename \"$path\"); "
            + "case \"$base\" in node_modules|.bun) continue ;; esac; rm -rf \"$path\"; done"
            if preserve_runtime
            else "rm -rf " + quoted_workdir + " && mkdir -p " + quoted_workdir
        )
        install_command = "true"
        if install_deps:
            if self._cli_mode() == "pi":
                install_command = " ".join([runtime_prefix, "(npm ci || npm install)"])
            else:
                install_command = " ".join(
                    [
                        runtime_prefix,
                        "(npm ci || npm install) &&",
                        'arch=$(uname -m) && case "$arch" in aarch64|arm64) na=arm64 ;; x86_64|amd64) na=x64 ;; *) echo "unsupported arch $arch" >&2; exit 4 ;; esac &&',
                        "ver=$(node -p \"require('./node_modules/@oh-my-pi/pi-natives/package.json').version\") &&",
                        'if [ ! -d "node_modules/@oh-my-pi/pi-natives-linux-$na" ]; then npm install --no-save "@oh-my-pi/pi-natives-linux-$na@$ver"; fi;',
                    ]
                )
        await self.exec_as_agent(
            environment,
            command=" ".join(
                [
                    "if [ -d",
                    shlex.quote(repo),
                    "]; then",
                    prepare_workdir,
                    "&&",
                    "tar --exclude='./.proof' --exclude='./node_modules' --exclude='./.pi/gsd-moa-cache' --exclude='./.git' -cf - -C",
                    shlex.quote(repo),
                    ". | tar -xf - -C",
                    quoted_workdir,
                    "&&",
                    "cd",
                    quoted_workdir,
                    "&&",
                    install_command,
                    "else echo 'PI_GSD_MOA_REPO not mounted; using PI_GSD_MOA_EXTENSION as-is'; fi",
                ]
            ),
        )

    @with_prompt_template
    async def run(self, instruction: str, environment: BaseEnvironment, context: AgentContext) -> None:
        out_dir = self._env_value("PI_GSD_MOA_OUT", DEFAULT_OUT_DIR) or DEFAULT_OUT_DIR
        secret_env_file = self._env_value("PI_GSD_MOA_ENV_FILE")
        env = self._run_env(secret_env_file, out_dir)
        source_env = await self._prepare_secret_env(environment, secret_env_file) if secret_env_file else ""
        command = self._run_command(instruction, out_dir, source_env)
        await self.exec_as_agent(environment, command=command, env=env)

    def _run_env(self, secret_env_file: str | None, out_dir: str) -> dict[str, str]:
        env_keys = list(NON_SECRET_ENV_KEYS)
        if not secret_env_file:
            env_keys.extend(LEGACY_SECRET_ENV_KEYS)
        env = {key: value for key in env_keys if (value := self._env_value(key))}
        env.setdefault("GSD_MOA_TRACE", "1")
        env.setdefault("GSD_MOA_TRACE_DIR", f"{out_dir}/traces")
        env.setdefault("GSD_MOA_PRIMARY_BASE_URL", "http://host.docker.internal:8317/v1")
        env.setdefault("GSD_MOA_GEMINI_BASE_URL", "http://host.docker.internal:8318/v1")
        env.setdefault("GSD_MOA_CODEX_BASE_URL", "http://host.docker.internal:8318/v1")
        cli_mode = self._cli_mode()
        if cli_mode == "pi":
            env["GSD_MOA_RUNTIME"] = "pi"
            pi_runtime_tar = self._env_value("PI_GSD_MOA_PI_RUNTIME_TAR")
            if pi_runtime_tar:
                env["PI_GSD_MOA_PI_RUNTIME_TAR"] = pi_runtime_tar
        else:
            env.setdefault("PI_NATIVE_VARIANT", "baseline")
            runtime_tar = self._env_value("PI_GSD_MOA_RUNTIME_TAR")
            if runtime_tar:
                env["PI_GSD_MOA_RUNTIME_TAR"] = runtime_tar
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
        env_model = self._env_value("PI_GSD_MOA_MODEL")
        if env_model:
            return env_model
        harbor_model = getattr(self, "model_name", None)
        if harbor_model:
            return str(harbor_model)
        return "gsd-moa/gpt55-glm52-single"

    def _thinking_args(self) -> list[str]:
        level = self._env_value("PI_GSD_MOA_THINKING_LEVEL", "high") or "high"
        if level == "inherit":
            return []
        allowed = {"off", "minimal", "low", "medium", "high", "xhigh"}
        if level not in allowed:
            raise ValueError(f"invalid PI_GSD_MOA_THINKING_LEVEL={level!r}; expected one of {sorted(allowed | {'inherit'})}")
        return ["--thinking", level]

    def _run_command(self, instruction: str, out_dir: str, source_env: str) -> str:
        model = self._resolve_model_name()
        extension = self._env_value("PI_GSD_MOA_EXTENSION", "/tmp/gsd-moa-ext/src/index.ts") or "/tmp/gsd-moa-ext/src/index.ts"
        workdir = self._env_value("PI_GSD_MOA_WORKDIR", "/tmp/gsd-moa-ext") or "/tmp/gsd-moa-ext"
        converter = self._env_value("PI_GSD_MOA_ATIF_CONVERTER", f"{workdir}/harbor_agents/atif_converter.py") or f"{workdir}/harbor_agents/atif_converter.py"
        trajectory_file = self._env_value("PI_GSD_MOA_TRAJECTORY", "/logs/agent/trajectory.json") or "/logs/agent/trajectory.json"
        output_file = f"{out_dir}/{PI_OUTPUT_NAME}"
        events_file = f"{out_dir}/{EVENTS_NAME}"
        session_file = f"{out_dir}/{SESSION_NAME}"
        stderr_file = f"{out_dir}/{STDERR_NAME}"
        thinking_args = self._thinking_args()
        if self._cli_mode() == "pi":
            return " ".join(
                [
                    "set -e;",
                    "mkdir -p",
                    shlex.quote(out_dir),
                    "&&",
                    source_env,
                    'task_cwd="$PWD";',
                    'export NVM_DIR="$HOME/.nvm"; if [ -s "$NVM_DIR/nvm.sh" ]; then . "$NVM_DIR/nvm.sh"; nvm use 24 >/dev/null || true; fi;',
                    'export GSD_MOA_RUNTIME=pi;',
                    'case "$GSD_MOA_BUDGET_MS" in ""|*[!0-9]*) export GSD_MOA_BUDGET_MS=900000 ;; esac;',
                    'now_ms=$(( $(date +%s) * 1000 ));',
                    'case "$GSD_MOA_DEADLINE_EPOCH_MS" in ""|*[!0-9]*) export GSD_MOA_DEADLINE_EPOCH_MS=$((now_ms + GSD_MOA_BUDGET_MS)) ;; esac;',
                    "cd \"$task_cwd\"",
                    "&&",
                    "set +e;",
                    shlex.quote(f"{workdir}/node_modules/.bin/pi"),
                    "--approve --no-session",
                    "-e",
                    shlex.quote(extension),
                    "--model",
                    shlex.quote(model),
                    "--mode json",
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
                    "echo 'pi exit status:' $status >>",
                    shlex.quote(stderr_file),
                    "; if [ \"$status\" -ne 0 ]; then if [ \"$status\" -eq 137 ] && grep -q '\"type\":\"turn_end\"'",
                    shlex.quote(output_file),
                    "; then exit 0; fi; exit $status; fi; exit 0",
                ]
            )
        return " ".join(
            [
                "set -e;",
                "mkdir -p",
                shlex.quote(out_dir),
                "&&",
                source_env,
                'task_cwd="$PWD";',
                'export NVM_DIR="$HOME/.nvm"; if [ -s "$NVM_DIR/nvm.sh" ]; then . "$NVM_DIR/nvm.sh"; nvm use 24 >/dev/null || true; fi;',
                f"export BUN_INSTALL={shlex.quote(f'{workdir}/.bun')};",
                'export PATH="$BUN_INSTALL/bin:$HOME/.bun/bin:$PATH";',
                'case "$GSD_MOA_BUDGET_MS" in ""|*[!0-9]*) export GSD_MOA_BUDGET_MS=900000 ;; esac;',
                'now_ms=$(( $(date +%s) * 1000 ));',
                'case "$GSD_MOA_DEADLINE_EPOCH_MS" in ""|*[!0-9]*) export GSD_MOA_DEADLINE_EPOCH_MS=$((now_ms + GSD_MOA_BUDGET_MS)) ;; esac;',
                "cd",
                shlex.quote(workdir),
                "&&",
                "set +e;",
                "./node_modules/.bin/omp",
                "--auto-approve --approval-mode yolo --no-session --cwd \"$task_cwd\"",
                "-e",
                shlex.quote(extension),
                "--model",
                shlex.quote(model),
                "--mode json",
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
                "echo 'omp exit status:' $status >>",
                shlex.quote(stderr_file),
                "; if [ \"$status\" -ne 0 ]; then if [ \"$status\" -eq 137 ] && grep -q '\"type\":\"turn_end\"'",
                shlex.quote(output_file),
                "; then exit 0; fi; exit $status; fi; exit 0",
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
