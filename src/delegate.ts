import { randomUUID } from "node:crypto";
import type { BillingOptions, DelegateResult, JobCost, PeerConfig } from "./types.js";
import { buildShellSpec, claudeBin, composeArgv } from "./peer.js";
import { run } from "./run.js";
import {
  billingFlags,
  billingRouteUsed,
  parseCostFromResult,
  resolveBillingOptions,
  sanitizeEnv,
} from "./billing.js";

/**
 * A delegated agent runs headless (no human to answer prompts), so it needs
 * enough standing permission to do its job. We deliberately default to the
 * *least* powerful mode that still lets it edit files (`acceptEdits`) and let
 * the caller grant specific commands via `allowedTools` (e.g. git). Full
 * autonomy (`bypassPermissions`) is available but must be chosen explicitly by
 * the user — never defaulted — because it creates an unrestricted agent.
 */
export const DEFAULT_PERMISSION_MODE = "acceptEdits";

/** Tools a delegated job may run without prompting, unless overridden. */
export const DEFAULT_ALLOWED_TOOLS = "Edit Write Read Bash(git add:*) Bash(git commit:*) Bash(git status:*) Bash(git diff:*)";

export interface DelegateOptions extends Partial<BillingOptions> {
  /** The task for the peer agent, in natural language. */
  task: string;
  /** Optional list of repo-relative files worth pointing the agent at. */
  relevantFiles?: string[];
  /** Branch the peer should work on (informational; default: leave as-is). */
  branch?: string;
  /** Claude permission mode for the peer (default: acceptEdits). */
  permissionMode?: string;
  /**
   * Space-separated allowed tools granted without prompting (default: edits +
   * common git commands). Set to "" to disable, or widen for build/run tasks.
   */
  allowedTools?: string;
  /** Stream progress lines (assistant text / tool activity) to this callback. */
  onProgress?: (text: string) => void;
}

/** Compose the brief handed to the peer agent as its `-p` prompt (via stdin). */
export function buildBrief(jobId: string, peer: PeerConfig, opts: DelegateOptions): string {
  const files = opts.relevantFiles?.length
    ? `\nRelevant files (repo-relative):\n${opts.relevantFiles.map((f) => `  - ${f}`).join("\n")}\n`
    : "";
  return [
    `You are a delegated Claude Code agent (job ${jobId}).`,
    `You are running on the "${peer.name}" peer (${peer.os}); the calling session is on a different machine/checkout.`,
    `Your working directory is this checkout's root: ${peer.repoRoot}`,
    ``,
    `## Task`,
    opts.task,
    files,
    `## Rules`,
    `- Do the work in this checkout. Make focused commits with clear messages.`,
    `- Do NOT push, force-push, or touch unrelated files. Stay on the current branch unless told otherwise.`,
    `- When done, end your final message with a section:`,
    `  "### RELAY RESULT" followed by a concise summary of what you did, what the caller`,
    `  should know, and any output the caller asked for (e.g. command results).`,
    `- If you could not complete the task, say so explicitly under that heading.`,
  ].join("\n");
}

/** Build the claude argv (flags only; prompt goes over stdin). */
function claudeFlags(billing: BillingOptions, permissionMode: string, allowedTools: string): string[] {
  const flags = [
    "--print",
    "--input-format",
    "text",
    "--output-format",
    "stream-json",
    "--verbose",
    "--permission-mode",
    permissionMode,
  ];
  if (allowedTools.trim() && permissionMode !== "bypassPermissions") {
    flags.push("--allowedTools", allowedTools.trim());
  }
  return [...flags, ...billingFlags(billing)];
}

/** Run `git` on the peer and return trimmed stdout (empty string on failure). */
async function peerGit(peer: PeerConfig, args: string, env: NodeJS.ProcessEnv): Promise<string> {
  const res = await run(buildShellSpec(peer, `git ${args}`), { env });
  return res.code === 0 ? res.stdout.trim() : "";
}

export async function delegate(peer: PeerConfig, opts: DelegateOptions): Promise<DelegateResult> {
  const jobId = randomUUID().slice(0, 8);
  const billing = resolveBillingOptions(opts);
  const { env } = sanitizeEnv(process.env, billing);
  const route = billingRouteUsed(billing, process.env);
  const permissionMode = opts.permissionMode ?? DEFAULT_PERMISSION_MODE;
  const allowedTools = opts.allowedTools ?? DEFAULT_ALLOWED_TOOLS;

  // 1. Capture the peer's HEAD so we can bundle exactly the new commits later.
  const baseHead = await peerGit(peer, "rev-parse HEAD", env);

  // 2. Run the delegated claude job, feeding the brief on stdin.
  const brief = buildBrief(jobId, peer, opts);
  const claudeArgv = [claudeBin(peer), ...claudeFlags(billing, permissionMode, allowedTools)];
  const claudeCmd = composeArgv(peer, claudeArgv);
  const spec = buildShellSpec(peer, claudeCmd);

  let summary = "";
  let ok = false;
  let cost: JobCost = { billing: "unknown" };
  let errorText: string | undefined;

  const res = await run(spec, {
    env,
    stdin: brief,
    onLine: (line) => handleStreamLine(line, opts.onProgress, (s) => (summary = s), (r) => {
      ok = r.ok;
      cost = r.cost;
      if (r.error) errorText = r.error;
    }),
  });

  if (res.code !== 0 && !errorText) {
    errorText = res.stderr.trim() || `peer claude exited with code ${res.code}`;
  }
  cost.billing = route; // derived from whether an API key was actually used

  // 3. Bundle any new commits the peer created (base..HEAD) to carry back.
  let bundleBase64: string | undefined;
  let commits: string[] = [];
  const newHead = await peerGit(peer, "rev-parse HEAD", env);
  if (baseHead && newHead && baseHead !== newHead) {
    const log = await peerGit(peer, `log --oneline ${baseHead}..${newHead}`, env);
    commits = log.split("\n").filter(Boolean);
    const bundle = await run(
      buildShellSpec(peer, `git bundle create - ${baseHead}..HEAD`),
      { env, binaryStdout: true },
    );
    if (bundle.code === 0 && bundle.stdout.length) bundleBase64 = bundle.stdout;
  }

  return { jobId, peer: peer.name, summary, ok, cost, bundleBase64, commits, error: errorText };
}

interface ResultUpdate {
  ok: boolean;
  cost: JobCost;
  error?: string;
}

/** Parse one stream-json NDJSON line and route progress/result. */
function handleStreamLine(
  line: string,
  onProgress: ((t: string) => void) | undefined,
  setSummary: (s: string) => void,
  setResult: (r: ResultUpdate) => void,
): void {
  let evt: Record<string, unknown>;
  try {
    evt = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return; // ignore non-JSON noise
  }
  const type = evt.type;

  if (type === "assistant") {
    const text = extractText(evt);
    if (text && onProgress) onProgress(text);
  } else if (type === "result") {
    const resultText = typeof evt.result === "string" ? evt.result : "";
    if (resultText) setSummary(extractRelayResult(resultText));
    const subtype = evt.subtype;
    setResult({
      ok: subtype === "success" || evt.is_error === false,
      cost: parseCostFromResult(evt),
      error: evt.is_error ? resultText || "peer reported an error" : undefined,
    });
  }
}

function extractText(evt: Record<string, unknown>): string {
  const msg = evt.message as { content?: Array<{ type: string; text?: string }> } | undefined;
  if (!msg?.content) return "";
  return msg.content
    .filter((b) => b.type === "text" && b.text)
    .map((b) => b.text)
    .join("");
}

/** Prefer the "### RELAY RESULT" section if the agent emitted one. */
export function extractRelayResult(text: string): string {
  const m = text.match(/###\s*RELAY RESULT\s*\n([\s\S]*)$/i);
  return (m?.[1] ?? text).trim();
}
