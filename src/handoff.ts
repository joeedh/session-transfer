import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { OS, PeerConfig, RelayConfig } from "./types.js";
import { translatePath } from "./config.js";
import { buildShellSpec } from "./peer.js";
import { run } from "./run.js";

/** Encode a cwd into Claude Code's projects-dir folder name (`C:\dev\foo` -> `C--dev-foo`). */
export function encodeProjectDir(cwd: string): string {
  return cwd.replace(/[\\/:]/g, "-");
}

/** Local projects dir for a given cwd. */
export function localProjectsDir(cwd: string): string {
  return join(homedir(), ".claude", "projects", encodeProjectDir(cwd));
}

/** Find the transcript jsonl for a session id, or the most-recent one, under cwd. */
export function findTranscript(cwd: string, sessionId?: string): string | undefined {
  const dir = localProjectsDir(cwd);
  if (!existsSync(dir)) return undefined;
  if (sessionId) {
    const p = join(dir, `${sessionId}.jsonl`);
    return existsSync(p) ? p : undefined;
  }
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => ({ f, m: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.m - a.m);
  return files[0] ? join(dir, files[0].f) : undefined;
}

/**
 * Translate a single transcript line for the target checkout: rewrite the `cwd`
 * field and any absolute paths under the local repo root to the peer's root.
 * Best-effort: structured fields (`cwd`, tool_use `file_path`, `cwd` in bash) are
 * handled; free-form paths inside text blocks are left as-is (documented limit).
 */
export function translateTranscriptLine(
  line: string,
  localRoot: string,
  peerRoot: string,
  peerOS: OS,
): string {
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return line;
  }
  const remap = (v: unknown): unknown => {
    if (typeof v === "string") {
      return translatePath(v, localRoot, peerRoot, peerOS) ?? v;
    }
    if (Array.isArray(v)) return v.map(remap);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = remap(val);
      return out;
    }
    return v;
  };
  const translated = remap(obj) as Record<string, unknown>;
  return JSON.stringify(translated);
}

export interface HandoffPlan {
  sessionId: string;
  transcriptPath: string;
  /** Translated jsonl content ready to write on the peer. */
  content: string;
  /** Destination path on the peer (peer-native). */
  peerDestPath: string;
  /** Command to run on the peer to continue the conversation. */
  resumeCommand: string;
}

/** Prepare (but do not deliver) a handoff: read + translate the transcript. */
export function prepareHandoff(
  config: RelayConfig,
  peer: PeerConfig,
  opts: { sessionId?: string; fork?: boolean } = {},
): HandoffPlan {
  const transcriptPath = findTranscript(config.repoRoot, opts.sessionId);
  if (!transcriptPath) {
    throw new Error(
      `No transcript found under ${localProjectsDir(config.repoRoot)}` +
        (opts.sessionId ? ` for session ${opts.sessionId}` : ""),
    );
  }
  const sessionId = transcriptPath.replace(/\.jsonl$/, "").split(/[\\/]/).pop()!;
  const lines = readFileSync(transcriptPath, "utf8").split("\n").filter(Boolean);
  const content =
    lines
      .map((l) => translateTranscriptLine(l, config.repoRoot, peer.repoRoot, peer.os))
      .join("\n") + "\n";

  const sep = peer.os === "windows" ? "\\" : "/";
  const home = peer.os === "windows" ? "%USERPROFILE%" : "$HOME";
  const peerProjects = `${home}${sep}.claude${sep}projects${sep}${encodeProjectDir(peer.repoRoot)}`;
  const peerDestPath = `${peerProjects}${sep}${sessionId}.jsonl`;
  const resumeCommand = `claude --resume ${sessionId}${opts.fork ? " --fork-session" : ""}`;

  return { sessionId, transcriptPath, content, peerDestPath, resumeCommand };
}

/**
 * Deliver a prepared handoff to the peer over the transport (no filesystem
 * bridge): create the peer projects dir and write the translated transcript via
 * the peer's shell, reading content from stdin.
 */
export async function deliverHandoff(peer: PeerConfig, plan: HandoffPlan): Promise<void> {
  const enc = encodeProjectDir(peer.repoRoot);
  const id = plan.sessionId;
  // The peer shell computes its own home dir so we never depend on a bridge or
  // on env expansion inside quotes.
  const mkdirAndWrite =
    peer.os === "windows"
      ? `powershell -NoProfile -Command "$rel = '.claude\\projects\\${enc}'; ` +
        `$dir = Join-Path $env:USERPROFILE $rel; ` +
        `New-Item -ItemType Directory -Force -Path $dir | Out-Null; ` +
        `$dest = Join-Path $dir '${id}.jsonl'; ` +
        `$in = [Console]::In.ReadToEnd(); ` +
        `[IO.File]::WriteAllText($dest, $in)"`
      : `dest="$HOME/.claude/projects/${enc}/${id}.jsonl"; ` +
        `mkdir -p "$(dirname "$dest")" && cat > "$dest"`;

  const res = await run(buildShellSpec(peer, mkdirAndWrite), { stdin: plan.content });
  if (res.code !== 0) {
    throw new Error(`handoff delivery failed (code ${res.code}): ${res.stderr.trim()}`);
  }
}
