"""Harbor custom installed agent for Pi + gsd-moa experiments.

Usage:
  harbor run -d terminal-bench/terminal-bench-2 --agent harbor_agents.pi_gsd_moa_agent:PiGsdMoaAgent

Configure with environment variables passed to Harbor/the task container:
  PI_GSD_MOA_MODEL=gsd-moa/gpt55-glm52-single   # or gsd-moa/gpt55-glm52-full / auto
  PI_GSD_MOA_REPO=/workspace/gsd-moa              # mounted repo copied to /tmp/gsd-moa-ext
  PI_GSD_MOA_EXTENSION=/tmp/gsd-moa-ext/src/index.ts
  GSD_MOA_PRIMARY_BASE_URL=http://host.docker.internal:8317/v1
  FACTORY_GPT_API_KEY=...
  ZAI_API_KEY=...

The agent writes Pi JSON events to /tmp/pi-gsd-moa/events.jsonl. Provider-level
MoA traces are written by the extension to .proof/traces when the extension config
enables tracing.
"""

from __future__ import annotations

import os
import shlex

from harbor.agents.installed.base import BaseInstalledAgent, with_prompt_template
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext


class PiGsdMoaAgent(BaseInstalledAgent):
    @staticmethod
    def name() -> str:
        return "pi-gsd-moa"

    async def install(self, environment: BaseEnvironment) -> None:
        await self.exec_as_root(
            environment,
            command="apt-get update && apt-get install -y ca-certificates curl git",
        )
        nvm_prefix = "export NVM_DIR=\"$HOME/.nvm\"; [ -s \"$NVM_DIR/nvm.sh\" ] || curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.2/install.sh | bash; . \"$NVM_DIR/nvm.sh\"; nvm install 24; nvm use 24; "
        await self.exec_as_agent(
            environment,
            command=nvm_prefix + "npm install -g @earendil-works/pi-coding-agent && pi --version",
        )
        repo = os.environ.get("PI_GSD_MOA_REPO", "/workspace/gsd-moa")
        workdir = os.environ.get("PI_GSD_MOA_WORKDIR", "/tmp/gsd-moa-ext")
        await self.exec_as_agent(
            environment,
            command=" ".join([
                "if [ -d", shlex.quote(repo), "]; then",
                "rm -rf", shlex.quote(workdir), "&&",
                "cp -R", shlex.quote(repo), shlex.quote(workdir), "&&",
                "cd", shlex.quote(workdir), "&&",
                nvm_prefix,
                "(npm ci || npm install);",
                "else echo 'PI_GSD_MOA_REPO not mounted; using PI_GSD_MOA_EXTENSION as-is'; fi",
            ]),
        )

    @with_prompt_template
    async def run(self, instruction: str, environment: BaseEnvironment, context: AgentContext) -> None:
        model = os.environ.get("PI_GSD_MOA_MODEL", "gsd-moa/gpt55-glm52-single")
        extension = os.environ.get("PI_GSD_MOA_EXTENSION", "/tmp/gsd-moa-ext/src/index.ts")
        out_dir = os.environ.get("PI_GSD_MOA_OUT", "/tmp/pi-gsd-moa")
        env = {key: value for key in [
            "FACTORY_GPT_API_KEY",
            "ZAI_API_KEY",
            "GSD_MOA_TRACE",
            "GSD_MOA_TRACE_DIR",
            "GSD_MOA_PRIMARY_BASE_URL",
            "GSD_MOA_REFERENCE_BASE_URL",
        ] if (value := os.environ.get(key))}
        env.setdefault("GSD_MOA_TRACE", "1")
        env.setdefault("GSD_MOA_TRACE_DIR", f"{out_dir}/traces")
        env.setdefault("GSD_MOA_PRIMARY_BASE_URL", "http://host.docker.internal:8317/v1")
        command = " ".join(
            [
                "mkdir -p", shlex.quote(out_dir), "&&",
                "export NVM_DIR=\"$HOME/.nvm\"; . \"$NVM_DIR/nvm.sh\"; nvm use 24 >/dev/null; pi -a",
                "-e", shlex.quote(extension),
                "--model", shlex.quote(model),
                "--mode json --no-session -p",
                shlex.quote(instruction),
                ">", shlex.quote(f"{out_dir}/events.jsonl"),
                "2>", shlex.quote(f"{out_dir}/stderr.txt"),
            ]
        )
        await self.exec_as_agent(environment, command=command, env=env)

    def populate_context_post_run(self, context: AgentContext) -> None:
        # Harbor still scores via task tests. The JSON trajectory files are persisted
        # by the environment logs/artifacts; provider-level traces are linked from
        # `gsd-moa.details.tracePath` inside events.jsonl.
        return None
