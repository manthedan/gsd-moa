import type { GsdMoaConfig } from "./types.js";

const HEADER = "[Reasoning-language policy from provider — applies to your natural-language reasoning]";
const TRAILER = "Exempt from this policy: code, shell commands, file paths, identifiers, JSON, error messages, and quoted tool output — keep those exactly as the task requires. Task deliverables (files, final answers, commit messages) stay in whatever language the task itself requires.";
const ZH_TRAILER = "以下内容不受此规定限制：代码、shell 命令、文件路径、标识符、JSON、错误信息以及引用的工具输出——保持任务本身要求的形式。任务交付物（文件、最终答案、提交信息）使用任务本身要求的语言。";

export function buildLanguagePolicyNote(config: Pick<GsdMoaConfig, "langPolicy">): string | undefined {
  const { policy, yokeSchedule } = config.langPolicy;
  if (policy === "off") return undefined;

  let body: string;
  switch (policy) {
    case "en":
      body = "Conduct all of your reasoning, planning, explanations, and commentary in English only. Do not use Chinese for any natural-language reasoning.";
      break;
    case "zh":
      body = "请仅使用中文进行所有推理、规划、解释与说明。任何自然语言思考都不要使用英文。";
      break;
    case "free":
      body = "Work through the problem using English or 中文, whichever is more precise or useful at each moment. Switch languages only when it helps you retrieve a term, formulate a subgoal, recover from an error, or verify an inference. Do not translate completed work merely for presentation.";
      break;
    case "mixed":
      body = "Structure your reasoning in three tagged phases for each subgoal: [ZH-FRAME] state the constraints, ambiguities, and required result in Chinese; [EN-DERIVE] derive, implement, and test the solution in English; [ZH-VERIFY] independently check the assumptions, edge cases, and conclusion in Chinese. Write the tags literally.";
      break;
    case "yoked": {
      const schedule = yokeSchedule || "alternate between English and Chinese at each new subgoal";
      body = `Alternate the language of your natural-language reasoning on a fixed schedule, regardless of content: ${schedule}. Follow the schedule exactly; do not switch languages at any other point.`;
      break;
    }
  }

  return [HEADER, body, policy === "zh" ? ZH_TRAILER : TRAILER].join("\n");
}
