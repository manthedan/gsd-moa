import type { AssistantMessage, Context } from "./pi-compat.js";
import { detectFailureSignals } from "./context.js";

export interface SessionStateSummary {
  filesModified: boolean;
  modifiedFiles: string[];
  confirmedModifiedFiles?: string[];
  commandsRun: number;
  verifierRan: boolean;
  lastVerifierPassed?: boolean;
  lastVerifierEvidence?: string;
  /** Exact standalone verifier command for typed diagnosis; compound commands are omitted conservatively. */
  lastVerifierCommand?: string;
  lastVerifierCommandClass?: string;
  lastVerifierFailureSignals?: string[];
  lastVerifierHadPrecedingMutation?: boolean;
  verifierEvidence: string[];
}

const FILE_MOD_TOOL_RE = /^(edit|write|apply[-_]?patch|create[-_]?file|str[-_]?replace)/i;
const BASH_LIKE_TOOL_RE = /^(bash|shell|exec|run|terminal)$/i;
const CODE_LIKE_TOOL_RE = /^(eval|python|node)$/i;
const COMMAND_LIKE_TOOL_RE = /^(bash|shell|exec|run|terminal|eval|python|node)$/i;
const SHELL_STATE_EXECUTABLE = String.raw`(?:tee|cp|mv|rm|chmod|truncate|ln|sed\s+-i|apply[_-]?patch|patch|install|mkdir|touch|git\s+(?:apply|checkout|rm)|npm\s+(?:install|i|ci|ic|clean-install|uninstall|remove|update)|pnpm\s+(?:install|i|add|remove|update)|yarn\s+(?:install|add|remove|up)|pip3?\s+(?:install|uninstall)|python3?\s+-m\s+pip\s+(?:install|uninstall)|bun\s+(?:install|add|remove|update)|composer\s+(?:install|update|remove|require)|bundle\s+(?:install|update)|gem\s+(?:install|uninstall))`;
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
  const mutationsByCallId = new Map<string, { files: string[]; writeTargets: string[]; failed: boolean; confirmed: boolean; commandLike: boolean; command?: string }>();
  let commandsRun = 0;
  let verifierRan = false;
  let lastVerifierPassed: boolean | undefined;
  let lastVerifierEvidence: string | undefined;
  let lastVerifierCommand: string | undefined;
  let lastVerifierCommandClass: string | undefined;
  let lastVerifierFailureSignals: string[] | undefined;
  let lastVerifierHadPrecedingMutation: boolean | undefined;

  const latestUserIndex = context.messages.reduce((latest, message, index) => message.role === "user" ? index : latest, -1);
  const currentTurnMessages = context.messages.slice(latestUserIndex + 1);

  for (const message of currentTurnMessages) {
    if (message.role === "assistant") {
      // OMP may execute sibling non-PTY tool calls concurrently. Only mutations
      // from earlier assistant batches, or from this exact compound call, can be
      // considered causally before a verifier.
      const priorBatchMutationIds = [...mutationsByCallId.keys()];
      for (const toolCall of assistantToolCalls(message)) {
        const name = toolCall.name;
        const args = toolCall.arguments ?? {};
        const command = commandString(args);
        const invocation = invocationText(name, args, command);
        if (COMMAND_LIKE_TOOL_RE.test(name)) commandsRun += 1;

        if (FILE_MOD_TOOL_RE.test(name) || (command && ((BASH_LIKE_TOOL_RE.test(name) && (hasPersistentShellStateChange(command) || hasShellCodeStateChange(command))) || (CODE_LIKE_TOOL_RE.test(name) && CODE_STATE_CHANGE_RE.test(command))))) {
          const writeTargets = command ? writeTargetsFromCommand(command) : explicitMutationPaths(args);
          const files = FILE_MOD_TOOL_RE.test(name) ? explicitMutationPaths(args) : writeTargets;
          if (toolCall.id) mutationsByCallId.set(toolCall.id, {
            files,
            writeTargets,
            failed: false,
            confirmed: false,
            commandLike: Boolean(command && COMMAND_LIKE_TOOL_RE.test(name)),
            ...(command ? { command } : {}),
          });
        }

        verifierCandidates.push({
          ...(toolCall.id ? { id: toolCall.id } : {}),
          name,
          ...(command ? { command } : {}),
          invocation,
          precedingMutationIds: [
            ...priorBatchMutationIds,
            ...(toolCall.id && mutationsByCallId.has(toolCall.id) ? [toolCall.id] : []),
          ],
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
      mutation.confirmed = !mutation.failed && mutationWasConfirmed(mutation, raw, Boolean(message.isError));
      if (!message.isError && hasPositiveStateChange(raw)) addFiles(mutation.files, filesFromText(raw));
    }
  }

  const successfulOrPendingMutations = [...mutationsByCallId.values()].filter((mutation) => !mutation.failed);
  const modifiedFiles: string[] = [];
  for (const mutation of successfulOrPendingMutations) addFiles(modifiedFiles, mutation.files);
  const confirmedModifiedFiles: string[] = [];
  for (const mutation of successfulOrPendingMutations) {
    if (mutation.confirmed) addFiles(confirmedModifiedFiles, mutation.files);
  }

  const successfulMutationIds = [...mutationsByCallId.entries()]
    .filter(([, mutation]) => !mutation.failed)
    .map(([id]) => id);
  for (const candidate of verifierCandidates) {
    // A verifier cannot validate mutations that occur after it.
    if (successfulMutationIds.some((id) => !candidate.precedingMutationIds.includes(id))) continue;
    const precedingModifiedFiles: string[] = [];
    for (const mutationId of candidate.precedingMutationIds) {
      const mutation = mutationsByCallId.get(mutationId);
      if (!mutation || mutation.failed) continue;
      // A compound command can run a verifier before a later `&&` write. That
      // write is not evidence that the failed verifier checked a mutation.
      if (mutationId === candidate.id && candidate.command && !mutationAppearsBeforeVerifier(candidate.command)) continue;
      addFiles(precedingModifiedFiles, mutation.files);
    }
    // Background jobs make the aggregate result unrelated to a unique verifier.
    if (candidate.command && hasBackgroundSeparator(candidate.command)) continue;
    // If this same compound command mutates again after its verifier, that
    // verifier is stale by the time the command completes. Do not let it satisfy
    // the done gate or trigger typed failure advice from an aggregate exit code.
    if (candidate.id && candidate.command && mutationsByCallId.has(candidate.id) && mutationAppearsAfterVerifier(candidate.command)) continue;
    const evidence = verifierEvidenceFor(candidate.name, candidate.command, candidate.invocation, precedingModifiedFiles);
    if (!evidence) continue;
    verifierRan = true;
    addCapped(verifierEvidence, evidence, 10);
    const result = candidate.id ? toolResultsByCallId.get(candidate.id) : undefined;
    if (result) {
      lastVerifierFailureSignals = detectFailureSignals(result.raw, result.isError);
      lastVerifierPassed = !result.isError && lastVerifierFailureSignals.length === 0;
      lastVerifierEvidence = evidence;
      lastVerifierCommandClass = candidate.command ? standaloneVerifierClass(candidate.name, candidate.command) : undefined;
      lastVerifierCommand = lastVerifierCommandClass ? candidate.command : undefined;
      lastVerifierHadPrecedingMutation = candidate.precedingMutationIds.some((id) => {
        const mutation = mutationsByCallId.get(id);
        if (!mutation?.confirmed) return false;
        return id !== candidate.id || !candidate.command || mutationAppearsBeforeVerifier(candidate.command);
      });
    }
  }

  return {
    filesModified: successfulOrPendingMutations.length > 0,
    modifiedFiles,
    confirmedModifiedFiles,
    commandsRun,
    verifierRan,
    ...(verifierRan && lastVerifierPassed !== undefined ? { lastVerifierPassed } : {}),
    ...(lastVerifierEvidence ? { lastVerifierEvidence } : {}),
    ...(lastVerifierCommand ? { lastVerifierCommand } : {}),
    ...(lastVerifierCommandClass ? { lastVerifierCommandClass } : {}),
    ...(lastVerifierFailureSignals ? { lastVerifierFailureSignals } : {}),
    ...(lastVerifierHadPrecedingMutation !== undefined ? { lastVerifierHadPrecedingMutation } : {}),
    verifierEvidence,
  };
}

function mutationIndexes(command: string): number[] {
  const shell = normalizeCombinedOutputRedirection(maskQuotedShellMetacharacters(stripDescriptorRedirects(command)));
  const indexes = executableMutationIndexes(shell);
  for (const segment of shellSegments(shell)) {
    const normalized = normalizedShellExecutable(segment.text);
    if (!/^(?:python3?|node|bun|tsx|ts-node)\b/i.test(normalized)) continue;
    for (const match of normalized.matchAll(new RegExp(CODE_STATE_CHANGE_RE.source, "gi"))) {
      if (match.index !== undefined) indexes.push(segment.index + match.index);
    }
  }
  if (interpreterHereDocBodies(command).some((body) => CODE_STATE_CHANGE_RE.test(body))) indexes.push(0);
  for (const redirect of shell.matchAll(/>>?\s*(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/g)) {
    const target = redirect[1] ?? redirect[2] ?? redirect[3] ?? "";
    if (/^\/dev\/(?:null|stdout|stderr)$/.test(target)) continue;
    const prefix = shell.slice(0, redirect.index ?? 0);
    let segmentStart = 0;
    for (const separator of prefix.matchAll(/&&|\|\||[;&|\n]/g)) segmentStart = (separator.index ?? 0) + separator[0].length;
    indexes.push(segmentStart);
  }
  return indexes;
}

function normalizeCombinedOutputRedirection(command: string): string {
  return command
    .replace(/&(?=>{1,2})/g, " ")
    .replace(/>(?=&(?!\d+\b))&/g, "> ")
    .replace(/\|&/g, "| ");
}

function hasBackgroundSeparator(command: string): boolean {
  const shell = maskQuotedShellMetacharacters(stripShellRedirections(stripDescriptorRedirects(command))).replaceAll("&&", "");
  return shell.includes("&");
}

function mutationAppearsBeforeVerifier(command: string): boolean {
  const verifierIndex = verifierSegmentIndex(command);
  if (verifierIndex < 0) return true;
  return mutationIndexes(command).some((index) => index < verifierIndex);
}

function mutationAppearsAfterVerifier(command: string): boolean {
  const verifierIndex = verifierSegmentIndex(command);
  if (verifierIndex < 0) return false;
  return mutationIndexes(command).some((index) => index > verifierIndex);
}

function verifierSegmentIndex(command: string): number {
  let verifierIndex = -1;
  for (const segment of shellSegments(command)) {
    const classified = stripLeadingShellAssignments(stripShellRedirections(stripDescriptorRedirects(segment.text))).trim();
    if (SHELL_VERIFIER_COMMAND_RE.test(classified)) verifierIndex = segment.index;
  }
  return verifierIndex;
}

function standaloneVerifierClass(name: string, command: string): string | undefined {
  if (!BASH_LIKE_TOOL_RE.test(name)) return undefined;
  const classified = stripLeadingShellAssignments(stripShellRedirections(stripDescriptorRedirects(stripHereDocBodies(command)))).trim();
  if (/[;&\n]|&&|\|\||\|/.test(maskQuotedShellMetacharacters(classified))) return undefined;
  return classified.match(/^(?:python3?\s+-m\s+(?:pytest|unittest|py_compile)|npm\s+(?:test|run\s+(?:test|check))|cargo\s+(?:test|check)|go\s+test|make\s+(?:test|check)|mvn\s+test|R\s+CMD\s+check|pytest|tox|jest|vitest|[\w./-]*(?:check(?:er)?|verify|validate)(?:\.(?:py|sh))?)/i)?.[0];
}

function hasShellCodeStateChange(command: string): boolean {
  if (interpreterHereDocBodies(command).some((body) => CODE_STATE_CHANGE_RE.test(body))) return true;
  return shellSegments(command).some((segment) => {
    const normalized = normalizedShellExecutable(segment.text);
    return /^(?:python3?|node|bun|tsx|ts-node)\b/i.test(normalized) && CODE_STATE_CHANGE_RE.test(normalized);
  });
}

function normalizedShellExecutable(segment: string): string {
  return stripLeadingShellAssignments(segment)
    .trimStart()
    .replace(/^sudo\s+/, "")
    .replace(/^\S*\/(?=(?:python3?|node|bun|tsx|ts-node)\b)/i, "");
}

function hasPersistentShellStateChange(command: string): boolean {
  const shell = stripDescriptorRedirects(command);
  if (executableMutationIndexes(shell).length > 0) return true;
  return redirectTargetsFromCommand(maskQuotedShellMetacharacters(shell)).some((target) => !/^\/dev\/(?:null|stdout|stderr)$/.test(target));
}

function executableMutationIndexes(command: string): number[] {
  const indexes: number[] = [];
  for (const segment of shellSegments(command)) {
    const executable = stripLeadingShellAssignments(segment.text).trimStart().replace(/^sudo\s+/, "");
    if (new RegExp(`^${SHELL_STATE_EXECUTABLE}\\b`, "i").test(executable)) indexes.push(segment.index);
  }
  return indexes;
}

function shellSegments(command: string): Array<{ text: string; index: number }> {
  const masked = maskQuotedShellMetacharacters(command);
  const segments: Array<{ text: string; index: number }> = [];
  let start = 0;
  for (const separator of masked.matchAll(/&&|\|\||[;&|\n]/g)) {
    const end = separator.index ?? start;
    segments.push({ text: command.slice(start, end), index: start });
    start = end + separator[0].length;
  }
  segments.push({ text: command.slice(start), index: start });
  return segments;
}

function maskQuotedShellMetacharacters(command: string): string {
  let quote: "'" | '"' | undefined;
  let escaped = false;
  return Array.from(command, (character) => {
    if (escaped) {
      escaped = false;
      return character;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      return character;
    }
    if (quote) {
      if (character === quote) quote = undefined;
      return /[;&|<>]/.test(character) ? " " : character;
    }
    if (character === "'" || character === '"') quote = character;
    return character;
  }).join("");
}

function redirectTargetsFromCommand(command: string): string[] {
  const targets: string[] = [];
  command = normalizeCombinedOutputRedirection(command);
  for (const match of command.matchAll(/(?:^|[^>])(?:(?:\d+|&)?>{1,2})(?!&)\s*(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/gm)) {
    addCapped(targets, match[1] ?? match[2] ?? match[3] ?? "", 20);
  }
  return targets;
}

function stripShellRedirections(command: string): string {
  const normalized = normalizeCombinedOutputRedirection(command);
  return normalized.replace(/(?:(?:\b\d*)|&)?>{1,2}\s*(?:"[^"]*"|'[^']*'|[^\s;&|]+)/g, (match) => " ".repeat(match.length));
}

function stripLeadingShellAssignments(command: string): string {
  let rest = command;
  const envPrefix = /^\s*(?:\/usr\/bin\/)?env\s+/.exec(rest);
  if (envPrefix) {
    rest = rest.slice(envPrefix[0].length);
    while (true) {
      const optionWithOperand = /^(?:-u|-C|--unset|--chdir)\s+(?:"[^"]*"|'[^']*'|\S+)\s*/.exec(rest);
      if (optionWithOperand) {
        rest = rest.slice(optionWithOperand[0].length);
        continue;
      }
      const endOfOptions = /^--\s+/.exec(rest);
      if (endOfOptions) {
        rest = rest.slice(endOfOptions[0].length);
        break;
      }
      const selfContainedOption = /^(?:--(?:unset|chdir)=\S+|-[^-\s]\S*)\s*/.exec(rest);
      if (!selfContainedOption) break;
      rest = rest.slice(selfContainedOption[0].length);
    }
  }
  return rest.replace(/^(?:\s*[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S+)\s+)+/, "");
}

function stripDescriptorRedirects(command: string): string {
  return command.replace(/(?:\b\d+)?[<>]\s*&\s*\d+\b/g, (match) => " ".repeat(match.length));
}

function mutationWasConfirmed(
  mutation: { commandLike: boolean; command?: string },
  resultText: string,
  isError: boolean,
): boolean {
  if (isError) return false;
  if (!mutation.commandLike) return true;
  const shellStructure = mutation.command ? maskQuotedShellMetacharacters(stripHereDocBodies(mutation.command)) : "";
  const compound = /[;&\n]|&&|\|\||\|/.test(shellStructure);
  if (compound && (MUTATION_PREVENTED_RE.test(resultText) || PATCH_PREVENTED_RE.test(resultText) || GIT_MUTATION_PREVENTED_RE.test(resultText))) return false;
  const andOnly = shellStructure.includes("&&") && !/[;&\n|]/.test(shellStructure.replaceAll("&&", ""));
  return !compound || andOnly || hasPositiveStateChange(resultText);
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
  const shellStructure = mutation.command ? maskQuotedShellMetacharacters(stripHereDocBodies(mutation.command)) : "";
  const compound = /[;&\n]|&&|\|\||\|/.test(shellStructure);
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
    />{1,2}&\s*(?!\d+\b)["']?([^\s"';|&]+)/gm,
    /(?:^|[^>])(?:(?:\d+|&)?>{1,2})(?!&)\s*["']?([^\s"';|&]+)/gm,
    /\btee(?:\s+-a)?\s+["']?([^\s"';|&]+)/gm,
    /\b(?:Path\s*\(|Bun\.write\s*\(|writeFile(?:Sync)?\s*\(|open\s*\()\s*["']([^"']+)["']/gm,
    /^\*\*\* (?:Update|Add|Delete) File:\s*(\S+)/gm,
    /\b(?:mkdir|touch)(?:\s+-[^\s]+)*\s+["']?([^\s"';|&]+)/gm,
    /\b(?:rm|git\s+rm)(?:\s+-[^\s]+)*\s+["']?([^\s"';|&]+)/gm,
    /\btruncate(?:\s+-[^\s]+\s+\S+)*\s+["']?([^\s"';|&]+)/gm,
    /\bchmod(?:\s+-[^\s]+)*\s+\S+\s+["']?([^\s"';|&]+)/gm,
    /\bsed\s+-i(?:\S*)?(?:\s+-[^\s]+)*\s+(?:["'][^"']+["']|\S+)\s+["']?([^\s"';|&]+)/gm,
  ];
  for (const pattern of patterns) {
    for (const match of command.matchAll(pattern)) addCapped(targets, match[1] ?? "", 20);
  }
  addFiles(targets, copyMoveTargetsFromCommand(command));
  addFiles(targets, destructiveTargetsFromCommand(command));
  return targets;
}

function copyMoveTargetsFromCommand(command: string): string[] {
  const targets: string[] = [];
  for (const segment of shellSegments(command)) {
    const normalized = stripLeadingShellAssignments(segment.text).trimStart().replace(/^sudo\s+/, "");
    const match = /^(?:cp|mv|ln)\b([\s\S]*)/m.exec(normalized);
    if (!match) continue;
    const operands = (match[1] ?? "").match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
    let targetDirectory: string | undefined;
    const positional: string[] = [];
    for (let index = 0; index < operands.length; index += 1) {
      const operand = operands[index] ?? "";
      if (operand === "-t" || operand === "--target-directory") {
        targetDirectory = operands[index + 1]?.replace(/^["']|["']$/g, "");
        index += 1;
      } else if (operand.startsWith("--target-directory=")) {
        targetDirectory = operand.slice(operand.indexOf("=") + 1).replace(/^["']|["']$/g, "");
      } else if (!operand.startsWith("-")) {
        positional.push(operand.replace(/^["']|["']$/g, ""));
      }
    }
    const destination = targetDirectory ?? positional.at(-1);
    if (destination) addCapped(targets, destination, 20);
  }
  return targets;
}

function destructiveTargetsFromCommand(command: string): string[] {
  const targets: string[] = [];
  for (const segment of shellSegments(command)) {
    const normalized = stripLeadingShellAssignments(segment.text).trimStart().replace(/^sudo\s+/, "");
    const match = /^(?:git\s+)?rm\b([\s\S]*)/m.exec(normalized);
    if (!match) continue;
    const operands = (match[1] ?? "").match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
    for (const operand of operands) {
      if (operand.startsWith("-")) continue;
      addCapped(targets, operand.replace(/^["']|["']$/g, ""), 20);
    }
  }
  return targets;
}

function explicitMutationPaths(args: Record<string, unknown>): string[] {
  const paths: string[] = [];
  for (const key of ["path", "file", "filePath", "target", "destination"] as const) {
    if (typeof args[key] === "string") addCapped(paths, args[key], 20);
  }
  for (const key of ["patch", "diff"] as const) {
    if (typeof args[key] === "string") addFiles(paths, writeTargetsFromCommand(args[key]));
  }
  return paths;
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
  const shellText = stripLeadingShellAssignments(stripRedirectionTargets(stripHereDocBodies(command)))
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
