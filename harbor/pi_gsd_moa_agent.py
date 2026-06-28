"""Harbor custom installed agent for Pi + gsd-moa experiments.

Usage:
  harbor run -d terminal-bench/terminal-bench-2 --agent harbor.pi_gsd_moa_agent:PiGsdMoaAgent

Configure with environment variables passed to Harbor/the task container:
  PI_GSD_MOA_MODEL=gsd-moa/gpt55-glm52-single   # or gsd-moa/gpt55-glm52-full / auto
  PI_GSD_MOA_EXTENSION=/workspace/gsd-moa/src/index.ts
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
    async def install(self, environment: BaseEnvironment) -> None:
        await self.exec_as_root(
            environment,
            command="apt-get update && apt-get install -y ca-certificates curl git nodejs npm",
        )
        await self.exec_as_agent(
            environment,
            command="npm install -g @earendil-works/pi-coding-agent",
        )

    @with_prompt_template
    async def run(self, instruction: str, environment: BaseEnvironment, context: AgentContext) -> None:
        model = os.environ.get("PI_GSD_MOA_MODEL", "gsd-moa/gpt55-glm52-single")
        extension = os.environ.get("PI_GSD_MOA_EXTENSION", "./src/index.ts")
        out_dir = os.environ.get("PI_GSD_MOA_OUT", "/tmp/pi-gsd-moa")
        trace = os.environ.get("GSD_MOA_TRACE", "1")
        trace_dir = os.environ.get("GSD_MOA_TRACE_DIR", f"{out_dir}/traces")
        command = " ".join(
            [
                "mkdir -p", shlex.quote(out_dir), "&&",
                "GSD_MOA_TRACE=" + shlex.quote(trace),
                "GSD_MOA_TRACE_DIR=" + shlex.quote(trace_dir),
                "pi -a",
                "-e", shlex.quote(extension),
                "--model", shlex.quote(model),
                "--mode json --no-session -p",
                shlex.quote(instruction),
                ">", shlex.quote(f"{out_dir}/events.jsonl"),
                "2>", shlex.quote(f"{out_dir}/stderr.txt"),
            ]
        )
        await self.exec_as_agent(environment, command=command)

    def populate_context_post_run(self, context: AgentContext) -> None:
        # Harbor still scores via task tests. The JSON trajectory files are persisted
        # by the environment logs/artifacts; provider-level traces are linked from
        # `gsd-moa.details.tracePath` inside events.jsonl.
        return None
