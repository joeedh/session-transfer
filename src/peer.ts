import { readFileSync } from "node:fs";
import type { OS, PeerConfig } from "./types.js";

/** A command ready to hand to child_process.spawn (no extra shell wrapping). */
export interface SpawnSpec {
  file: string;
  args: string[];
}

/** Detect whether we're running inside WSL. */
export function isWsl(): boolean {
  if (process.platform !== "linux") return false;
  if (process.env.WSL_DISTRO_NAME) return true;
  try {
    return /microsoft/i.test(readFileSync("/proc/version", "utf8"));
  } catch {
    return false;
  }
}

export function localOS(): OS {
  return process.platform === "win32" ? "windows" : "linux";
}

export function defaultClaudePath(peer: PeerConfig): string {
  // `claude` is expected on PATH in the peer's login shell unless overridden.
  return peer.claudePath ?? "claude";
}

/** Single-quote for a POSIX `bash -lc` context. */
function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Double-quote for a cmd.exe context (paths only; we control the rest). */
function cmdq(s: string): string {
  return `"${s}"`;
}

/**
 * Build a spawn spec that runs an arbitrary `command` string in the peer's
 * shell, with the working directory set to the peer's repoRoot. Binary stdout
 * (e.g. `git bundle create -`) passes through unmodified. The prompt/stdin of
 * the resulting child is inherited by whatever the command runs.
 *
 *   wsl     -> wsl.exe [-d <distro>] -- bash -lc 'cd <root> && <command>'
 *   ssh     -> ssh <target> 'cd <root> && <command>'
 *   windows -> cmd.exe /d /s /c "cd /d "<root>" && <command>"
 *   docker  -> docker exec -i <container> bash -lc 'cd <root> && <command>'
 *
 * The `/s /c "..."` form is the robust cmd quoting: cmd strips only the outer
 * quotes node/WSL-interop adds, leaving inner quoted paths intact.
 */
export function buildShellSpec(peer: PeerConfig, command: string): SpawnSpec {
  switch (peer.kind) {
    case "wsl": {
      const inner = `cd ${shq(peer.repoRoot)} && ${command}`;
      const base = peer.distro ? ["-d", peer.distro] : [];
      return { file: "wsl.exe", args: [...base, "--", "bash", "-lc", inner] };
    }
    case "ssh": {
      const inner = `cd ${shq(peer.repoRoot)} && ${command}`;
      return { file: "ssh", args: [peer.sshTarget!, inner] };
    }
    case "docker": {
      const inner = `cd ${shq(peer.repoRoot)} && ${command}`;
      // `-i` keeps stdin open so briefs / handoff content pipe through and binary
      // stdout (git bundle) passes back unmodified; no `-t` (a TTY would corrupt it).
      return { file: "docker", args: ["exec", "-i", peer.container!, "bash", "-lc", inner] };
    }
    case "windows": {
      const inner = `cd /d ${cmdq(peer.repoRoot)} && ${command}`;
      return { file: "cmd.exe", args: ["/d", "/s", "/c", inner] };
    }
    default: {
      const _exhaustive: never = peer.kind;
      throw new Error(`unsupported peer kind: ${_exhaustive}`);
    }
  }
}

/** Quote a single argv token for the peer's shell (handles spaces, parens, *). */
export function quoteArg(os: OS, s: string): string {
  if (os === "windows") {
    // cmd: double quotes make spaces and metacharacters ( ) & | < > * literal.
    return /[\s"&|()<>^*]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }
  // bash: single-quote anything outside a safe set.
  return /^[\w@%+=:,./-]+$/.test(s) ? s : shq(s);
}

/** Compose an argv (e.g. the claude command + flags) into one shell-safe string. */
export function composeArgv(peer: PeerConfig, argv: string[]): string {
  return argv.map((a) => quoteArg(peer.os, a)).join(" ");
}

/** The claude binary token for the peer (raw; quote via composeArgv). */
export function claudeBin(peer: PeerConfig): string {
  return defaultClaudePath(peer);
}

/** Quote the claude binary path appropriately for the peer's shell. */
export function quoteClaude(peer: PeerConfig): string {
  return quoteArg(peer.os, defaultClaudePath(peer));
}
