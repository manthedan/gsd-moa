import type { AssistantMessage, Context } from "./pi-compat.js";
import { detectFailureSignals } from "./context.js";

export interface SessionStateSummary {
  filesModified: boolean;
  modifiedFiles: string[];
  commandsRun: number;
  verifierRan: boolean;
  lastVerifierPassed?: boolean;
  verifierEvidence: string[];
}

const FILE_MOD_TOOL_RE = /^(edit|write|apply[-_]?patch|create[-_]?file|str[-_]?replace)/i;
const BASH_LIKE_TOOL_RE = /^(bash|shell|exec|run|terminal)$/i;
const CODE_LIKE_TOOL_RE = /^(eval|python|node)$/i;
const COMMAND_LIKE_TOOL_RE = /^(bash|shell|exec|run|terminal|eval|python|node)$/i;
const STATE_CHANGE_COMMAND_RE = /(>>?|\btee\b|\bcp\b|\bmv\b|\bsed\s+-i\b|\bapply[_-]?patch\b|\bpatch\b|\binstall\b|\bmkdir\b|\btouch\b|\bgit\s+(apply|checkout)\b)/i;
const CODE_STATE_CHANGE_RE = /(?:\bBun\.write\b|\bwriteFile(?:Sync)?\b|\.write_text\b|\bopen\s*\([^)]*[,)]\s*["']?[wa]["']?|\bmkdir\b|\brename\b|\bunlink\b)/i;
const STATE_CHANGE_RESULT_RE = /\b(wrote|created|updated|modified|deleted|patched|generated|saved|replaced)\b/i;
const MUTATION_PREVENTED_RE = /\b(permission denied|operation not permitted|access denied|read-only file system|no such file or directory)\b/i;
const PATCH_PREVENTED_RE = /\b(invalid context|patch failed|failed to apply|does not apply|no valid patches|hunk\s+#?\d+\s+failed|failed to find expected lines?)\b/i;
const GIT_MUTATION_PREVENTED_RE = /(?:pathspec ['"].*['"] did not match|not a git repository|unknown revision|invalid reference|did not match any files? known to git)/i;
const VERIFIER_NAME_RE = /(?:pytest|py_compile|unittest|npm\s+(?:test|run\s+(?:test|check))|cargo\s+(?:test|check)|go\s+test|make\s+(?:test|check)|mvn\s+test|R\s+CMD\s+check|tox|jest|vitest|check(?:er)?\.(?:py|sh)|verify|validate)/i;
const SHELL_VERIFIER_COMMAND_RE = /(?:^|[;&|]\s*)(?:\.?\/?[\w./-]*pytest\b|python3?\s+-m\s+(?:pytest|unittest|py_compile)\b|npm\s+(?:test|run\s+(?:test|check))\b|cargo\s+(?:test|check)\b|go\s+test\b|make\s+(?:test|check)\b|mvn\s+test\b|R\s+CMD\s+check\b|tox\b|jest\b|vitest\b|(?:python3?\s+)?\.?\/?[\w./-]*check(?:er)?\.(?:py|sh)\b|(?:python3?\s+)?\.?\/?[\w./-]*(?:verify|validate)(?:\.(?:py|sh))?\b)/im;
const CODE_VERIFIER_CALL_RE = new RegExp(String.raw`\b(subprocess\.(run|check_call|check_output)|os\.system|(?:child_process\.)?(exec|execFile|spawn)(Sync)?)\s*\([\s\S]{0,600}\b${VERIFIER_NAME_RE.source}\b`, "i");
const CODE_DIRECT_VERIFIER_RE = /\b(pytest\.main|unittest\.main|py_compile\.compile)\b/i;
const RUN_ARTIFACT_RE = /\b(python3?|node|tsx|ts-node|ruby|Rscript|bash|sh)\b|\bgo\s+run\b/i;
const FILE_RE = /[A-Za-z0-9_./-]+\.[A-Za-z0-9_/-]+/g;

export function buildSessionStateSummary(context: Context): SessionStateSummary {
  const verifierEvidence: string[] = [];
  const verifierCandidates: Array<{ id?: string; name: string; command?: string; invocation: string; precedingMutationIds: string[] }> = [];
  const toolResultsByCallId = new Map<string, { raw: string; isError: boolean }>();
  const mutationsByCallId = new Map<string, { files: string[]; writeTargets: string[]; failed: boolean; commandLike: boolean; command?: string }>();
  let commandsRun = 0;
  let verifierRan = false;
  let lastVerifierPassed: boolean | undefined;

  const latestUserIndex = context.messages.reduce((latest, message, index) => message.role === "user" ? index : latest, -1);
  const currentTurnMessages = context.messages.slice(latestUserIndex + 1);

  for (const message of currentTurnMessages) {
    if (message.role === "assistant") {
      for (const toolCall of assistantToolCalls(message)) {
        const name = toolCall.name;
        const args = toolCall.arguments ?? {};
        const command = commandString(args);
        const invocation = invocationText(name, args, command);
        if (COMMAND_LIKE_TOOL_RE.test(name)) commandsRun += 1;

        if (FILE_MOD_TOOL_RE.test(name) || (command && ((BASH_LIKE_TOOL_RE.test(name) && (STATE_CHANGE_COMMAND_RE.test(command) || CODE_STATE_CHANGE_RE.test(command))) || (CODE_LIKE_TOOL_RE.test(name) && CODE_STATE_CHANGE_RE.test(command))))) {
          const files = filesFromText(invocation);
          if (toolCall.id) mutationsByCallId.set(toolCall.id, {
            files,
            writeTargets: command ? writeTargetsFromCommand(command) : files,
            failed: false,
            commandLike: Boolean(command && COMMAND_LIKE_TOOL_RE.test(name)),
            ...(command ? { command } : {}),
          });
        }

        verifierCandidates.push({
          ...(toolCall.id ? { id: toolCall.id } : {}),
          name,
          ...(command ? { command } : {}),
          invocation,
          precedingMutationIds: [...mutationsByCallId.keys()],
        });
      }
      continue;
    }

    if (message.role !== "toolResult") continue;
    const raw = message.content.map((item) => item.type === "text" ? item.text : "[image]").join("\n");
    toolResultsByCallId.set(message.toolCallId, { raw, isError: Boolean(message.isError) });
    const mutation = mutationsByCallId.get(message.toolCallId);
    if (mutation) {
      // Command tools can mutate before a later subcommand fails, so ambiguous
      // errors remain potentially mutating. Clear them only when the output is
      // tied to the write/patch itself. Dedicated edit/write tools fail as a unit.
      mutation.failed = mutationWasPrevented(mutation, raw, Boolean(message.isError));
      if (!message.isError && hasPositiveStateChange(raw)) addFiles(mutation.files, filesFromText(raw));
    }
  }

  const successfulOrPendingMutations = [...mutationsByCallId.values()].filter((mutation) => !mutation.failed);
  const confirmedModifiedFiles: string[] = [];
  for (const mutation of successfulOrPendingMutations) addFiles(confirmedModifiedFiles, mutation.files);

  const successfulMutationIds = [...mutationsByCallId.entries()]
    .filter(([, mutation]) => !mutation.failed)
    .map(([id]) => id);
  for (const candidate of verifierCandidates) {
    // A verifier cannot validate mutations that occur after it.
    if (successfulMutationIds.some((id) => !candidate.precedingMutationIds.includes(id))) continue;
    const precedingModifiedFiles: string[] = [];
    for (const mutationId of candidate.precedingMutationIds) {
      const mutation = mutationsByCallId.get(mutationId);
      if (mutation && !mutation.failed) addFiles(precedingModifiedFiles, mutation.files);
    }
    const evidence = verifierEvidenceFor(candidate.name, candidate.command, candidate.invocation, precedingModifiedFiles);
    if (!evidence) continue;
    verifierRan = true;
    addCapped(verifierEvidence, evidence, 10);
    const result = candidate.id ? toolResultsByCallId.get(candidate.id) : undefined;
    if (result) lastVerifierPassed = !result.isError && detectFailureSignals(result.raw, result.isError).length === 0;
  }

  return {
    filesModified: successfulOrPendingMutations.length > 0,
    modifiedFiles: confirmedModifiedFiles,
    commandsRun,
    verifierRan,
    ...(verifierRan && lastVerifierPassed !== undefined ? { lastVerifierPassed } : {}),
    verifierEvidence,
  };
}

function mutationWasPrevented(
  mutation: { files: string[]; writeTargets: string[]; commandLike: boolean; command?: string },
  resultText: string,
  isError: boolean,
): boolean {
  if (!isError) return false;
  // Dedicated edit/write tools often use state words in conflict explanations.
  // Only explicit success wording can override their aggregate error flag.
  if (!mutation.commandLike) return !hasExplicitMutationSuccess(resultText);
  // Shell commands can mutate before a later command fails, so broader positive
  // evidence remains useful for command-like tools.
  if (hasPositiveStateChange(resultText)) return false;
  if (mutation.command && /apply[_-]?patch|\bgit\s+apply\b/i.test(mutation.command) && PATCH_PREVENTED_RE.test(resultText)) return true;
  if (mutation.command && /\bgit\s+(?:checkout|apply)\b/i.test(mutation.command) && GIT_MUTATION_PREVENTED_RE.test(resultText)) return true;
  if (mutation.command && /(?:^|[;&|]\s*)patch\b/im.test(mutation.command) && /0\s+out\s+of\s+\d+\s+hunks?\s+(?:failed|applied)/i.test(resultText)) return true;
  const shellStructure = mutation.command ? stripHereDocBodies(mutation.command) : "";
  const compound = /[;\n]|&&|\|\||\|/.test(shellStructure);
  const andSegments = mutation.command?.split("&&") ?? [];
  if (andSegments.length > 1 && MUTATION_PREVENTED_RE.test(resultText)) {
    const firstCommand = andSegments[0] ?? "";
    const firstExecutable = shellExecutable(firstCommand);
    const failureNamesFirstExecutable = Boolean(
      firstExecutable && new RegExp(`(?:^|\\n)\\s*${escapeRegExp(firstExecutable)}(?:\\s|:)`, "i").test(resultText),
    );
    const firstWriteTargets = writeTargetsFromCommand(firstCommand);
    const shellReportsFailedRedirection = /(?:^|\n)\s*(?:ba|z|da)?sh:/i.test(resultText)
      && firstWriteTargets.some((file) => resultText.includes(file));
    const firstCommandPaths = [...filesFromText(firstCommand), ...firstWriteTargets];
    if ((failureNamesFirstExecutable || shellReportsFailedRedirection) && firstCommandPaths.some((file) => resultText.includes(file))) return true;
  }
  const ambiguousMultiTarget = mutation.writeTargets.length > 1 || Boolean(
    mutation.command && /(?:^|[;&|]\s*)(?:touch|mkdir)(?:\s+-\S+)*\s+(?!&&|\|\||[;|])\S+\s+(?!&&|\|\||[;|])\S+/m.test(mutation.command),
  );
  if (!compound && !ambiguousMultiTarget && MUTATION_PREVENTED_RE.test(resultText)) return true;
  return false;
}

function shellExecutable(command: string): string | undefined {
  const token = command.trim().match(/^([A-Za-z0-9_./-]+)/)?.[1];
  return token?.split("/").at(-1);
}

function hasExplicitMutationSuccess(text: string): boolean {
  return /\b(?:successfully|success|done)\b[^\n]{0,100}\b(?:wrote|created|updated|modified|deleted|patched|generated|saved|replaced)\b/i.test(text)
    || /^\s*(?:wrote|created|updated|modified|deleted|patched|generated|saved|replaced)\b/im.test(text)
    || /^\s*resolved\b[^\n]{0,120}\bacross\b/im.test(text);
}

function hasPositiveStateChange(text: string): boolean {
  for (const match of text.matchAll(new RegExp(STATE_CHANGE_RESULT_RE.source, "gi"))) {
    const prefix = text.slice(Math.max(0, (match.index ?? 0) - 48), match.index).toLowerCase();
    const clause = prefix.slice(Math.max(prefix.lastIndexOf("."), prefix.lastIndexOf(";"), prefix.lastIndexOf("\n")) + 1);
    if (/\b(?:not|never|cannot|can't|could\s+not|couldn't|failed\s+to|unable\s+to)\s+(?:be\s+)?$/.test(clause)) continue;
    if (/\b(?:no|nothing|zero)\b[^.!?;\n]{0,30}$/.test(clause)) continue;
    if (/\b0(?:\s+files?)?\b[^.!?;\n]{0,30}$/.test(clause)) continue;
    return true;
  }
  return false;
}

function writeTargetsFromCommand(command: string): string[] {
  const targets: string[] = [];
  const patterns = [
    /(?:^|\s)>{1,2}\s*["']?([^\s"';|&]+)/gm,
    /\btee(?:\s+-a)?\s+["']?([^\s"';|&]+)/gm,
    /\b(?:Path\s*\(|Bun\.write\s*\(|writeFile(?:Sync)?\s*\(|open\s*\()\s*["']([^"']+)["']/gm,
    /^\*\*\* (?:Update|Add|Delete) File:\s*(\S+)/gm,
    /\b(?:mkdir|touch)(?:\s+-[^\s]+)*\s+["']?([^\s"';|&]+)/gm,
    /\b(?:cp|mv)(?:\s+-[^\s]+)*\s+(?:["'][^"']+["']|\S+)\s+["']?([^\s"';|&]+)/gm,
    /\bsed\s+-i(?:\S*)?(?:\s+-[^\s]+)*\s+(?:["'][^"']+["']|\S+)\s+["']?([^\s"';|&]+)/gm,
  ];
  for (const pattern of patterns) {
    for (const match of command.matchAll(pattern)) addCapped(targets, match[1] ?? "", 20);
  }
  return targets;
}

export function assistantRequestsVerifier(message: AssistantMessage, modifiedFiles: string[] = []): boolean {
  return assistantToolCalls(message).some((toolCall) => {
    const args = toolCall.arguments ?? {};
    const command = commandString(args);
    return Boolean(verifierEvidenceFor(toolCall.name, command, invocationText(toolCall.name, args, command), modifiedFiles));
  });
}

function assistantToolCalls(message: AssistantMessage): Array<{ type: string; id?: string; name: string; arguments?: Record<string, unknown> }> {
  const calls: Array<{ type: string; id?: string; name: string; arguments?: Record<string, unknown> }> = [];
  for (const item of message.content) {
    const typed = item as { type?: unknown; id?: unknown; name?: unknown; arguments?: unknown };
    if ((typed.type === "toolCall" || typed.type === "tool-call") && typeof typed.name === "string") {
      calls.push({
        type: typed.type,
        ...(typeof typed.id === "string" ? { id: typed.id } : {}),
        name: typed.name,
        ...(isRecord(typed.arguments) ? { arguments: typed.arguments } : {}),
      });
    }
  }
  return calls;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function commandString(args: Record<string, unknown>): string | undefined {
  for (const key of ["command", "cmd", "script", "code", "input"] as const) {
    if (typeof args[key] === "string") return args[key];
  }
  return undefined;
}

function invocationText(name: string, args: Record<string, unknown>, command: string | undefined): string {
  if (command) return `${name} ${command}`;
  try {
    return `${name} ${JSON.stringify(args)}`;
  } catch {
    return name;
  }
}

function verifierEvidenceFor(name: string, command: string | undefined, invocation: string, modifiedFiles: string[]): string | undefined {
  if (!COMMAND_LIKE_TOOL_RE.test(name)) return undefined;
  const verifierText = verifierSearchText(name, command, invocation);
  if (isVerifierInvocation(name, command, verifierText)) return trimEvidence(command ?? invocation);
  if (command && BASH_LIKE_TOOL_RE.test(name) && RUN_ARTIFACT_RE.test(verifierText) && commandReferencesModifiedFile(verifierText, modifiedFiles)) {
    return trimEvidence(command);
  }
  return undefined;
}

function verifierSearchText(name: string, command: string | undefined, invocation: string): string {
  if (!command) return invocation;
  if (BASH_LIKE_TOOL_RE.test(name)) return verifierSearchTextForShell(command);
  if (CODE_LIKE_TOOL_RE.test(name)) return verifierSearchTextForCode(command);
  return invocation;
}

function isVerifierInvocation(name: string, command: string | undefined, verifierText: string): boolean {
  if (command && BASH_LIKE_TOOL_RE.test(name)) return SHELL_VERIFIER_COMMAND_RE.test(verifierText) || CODE_VERIFIER_CALL_RE.test(verifierText) || CODE_DIRECT_VERIFIER_RE.test(verifierText);
  if (command && CODE_LIKE_TOOL_RE.test(name)) return verifierText.length > 0;
  return SHELL_VERIFIER_COMMAND_RE.test(verifierText);
}

function verifierSearchTextForShell(command: string): string {
  const shellText = stripRedirectionTargets(stripHereDocBodies(command))
    .split("\n")
    .filter((line) => !isPureShellWriteLine(line))
    .join("\n");
  const inlineVerifierCode = interpreterHereDocVerifierCode(command);
  return inlineVerifierCode ? `${shellText}\n${inlineVerifierCode}` : shellText;
}

function interpreterHereDocVerifierCode(command: string): string {
  const bodies = interpreterHereDocBodies(command);
  return bodies.filter((body) => CODE_VERIFIER_CALL_RE.test(body) || CODE_DIRECT_VERIFIER_RE.test(body)).join("\n");
}

function interpreterHereDocBodies(command: string): string[] {
  const lines = command.split("\n");
  const bodies: string[] = [];
  let delimiter: string | undefined;
  let activeInterpreter = false;
  let activeBody: string[] = [];

  for (const line of lines) {
    if (delimiter) {
      if (line.trim() === delimiter) {
        if (activeInterpreter) bodies.push(activeBody.join("\n"));
        delimiter = undefined;
        activeInterpreter = false;
        activeBody = [];
      } else if (activeInterpreter) {
        activeBody.push(line);
      }
      continue;
    }

    const match = /<<-?\s*['"]?([A-Za-z0-9_-]+)['"]?/.exec(line);
    if (!match) continue;
    delimiter = match[1];
    activeInterpreter = /(?:^|[;&|]\s*)(?:python3?|node|tsx|ts-node|bun)\b/i.test(line);
    activeBody = [];
  }

  return bodies;
}

function stripHereDocBodies(command: string): string {
  const lines = command.split("\n");
  const kept: string[] = [];
  let delimiter: string | undefined;

  for (const line of lines) {
    if (delimiter) {
      if (line.trim() === delimiter) delimiter = undefined;
      continue;
    }

    kept.push(line);
    const match = /<<-?\s*['"]?([A-Za-z0-9_-]+)['"]?/.exec(line);
    if (match) delimiter = match[1];
  }

  return kept.join("\n");
}

function stripRedirectionTargets(command: string): string {
  return command.replace(/\s(?:[<>]{1,2}|\d?[<>]{1,2})\s*(?:"[^"]*"|'[^']*'|\S+)/g, " ");
}

function isPureShellWriteLine(line: string): boolean {
  const trimmed = line.trim();
  if (/[;&]|\|\|/.test(trimmed)) return false;
  return /^(cat|echo|printf)\b/i.test(trimmed) || /^tee\b/i.test(trimmed);
}

function verifierSearchTextForCode(command: string): string {
  if (CODE_VERIFIER_CALL_RE.test(command) || CODE_DIRECT_VERIFIER_RE.test(command)) return command;
  return "";
}

function commandReferencesModifiedFile(command: string, modifiedFiles: string[]): boolean {
  return modifiedFiles.some((file) => new RegExp(`(^|[\\s"'\`])${escapeRegExp(file)}($|[\\s"'\`])`).test(command));
}

function filesFromText(text: string): string[] {
  return Array.from(text.matchAll(FILE_RE)).map((match) => match[0]);
}

function addFiles(target: string[], files: string[]): void {
  for (const file of files) addCapped(target, file, 20);
}

function addCapped(target: string[], value: string, cap: number): void {
  if (!value || target.includes(value) || target.length >= cap) return;
  target.push(value);
}

function trimEvidence(text: string): string {
  return text.length > 160 ? `${text.slice(0, 157)}...` : text;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
