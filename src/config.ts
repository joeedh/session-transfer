import { readFileSync, existsSync } from "node:fs";
import { join, isAbsolute } from "node:path";
import type { OS, PeerConfig, RelayConfig } from "./types.js";

/**
 * Config resolution order (first hit wins):
 *   1. $CLAUDE_RELAY_CONFIG
 *   2. <cwd>/relay.config.local.json   (gitignored, per-machine)
 *   3. <cwd>/relay.config.json         (committed)
 */
export function findConfigPath(cwd = process.cwd()): string | undefined {
  const env = process.env.CLAUDE_RELAY_CONFIG;
  if (env && existsSync(env)) return env;
  for (const name of ["relay.config.local.json", "relay.config.json"]) {
    const p = join(cwd, name);
    if (existsSync(p)) return p;
  }
  return undefined;
}

export function loadConfig(cwd = process.cwd()): RelayConfig {
  const path = findConfigPath(cwd);
  if (!path) {
    throw new Error(
      `No relay config found. Create relay.config.json in the repo root ` +
        `(see relay.config.example.json) or set $CLAUDE_RELAY_CONFIG.`,
    );
  }
  const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<RelayConfig>;
  if (!raw.repoRoot || !isAbsolute(raw.repoRoot)) {
    throw new Error(`relay config: "repoRoot" must be an absolute path (in ${path})`);
  }
  if (!Array.isArray(raw.peers) || raw.peers.length === 0) {
    throw new Error(`relay config: "peers" must be a non-empty array (in ${path})`);
  }
  for (const p of raw.peers) validatePeer(p, path);
  return raw as RelayConfig;
}

function validatePeer(p: PeerConfig, path: string): void {
  if (!p.name) throw new Error(`relay config: a peer is missing "name" (in ${path})`);
  if (!["wsl", "windows", "ssh"].includes(p.kind))
    throw new Error(`relay config: peer "${p.name}" has invalid kind "${p.kind}"`);
  if (!["windows", "linux"].includes(p.os))
    throw new Error(`relay config: peer "${p.name}" has invalid os "${p.os}"`);
  if (!p.repoRoot) throw new Error(`relay config: peer "${p.name}" is missing "repoRoot"`);
  if (p.kind === "ssh" && !p.sshTarget)
    throw new Error(`relay config: ssh peer "${p.name}" needs "sshTarget"`);
}

export function getPeer(config: RelayConfig, name: string): PeerConfig {
  const peer = config.peers.find((p) => p.name === name);
  if (!peer) {
    const names = config.peers.map((p) => p.name).join(", ");
    throw new Error(`No peer named "${name}". Configured peers: ${names || "(none)"}`);
  }
  return peer;
}

// ---------------------------------------------------------------------------
// Repo-root-relative path translation.
//
// The two checkouts do NOT share a filesystem and no bridge (wslpath/mnt) is
// assumed. We translate purely by repo root: a local absolute path under the
// local root maps to the same relative path under the peer root, re-joined with
// the peer's path separator. Paths outside the repo cannot be translated.
// ---------------------------------------------------------------------------

function sep(os: OS): string {
  return os === "windows" ? "\\" : "/";
}

function normalizeForCompare(p: string): string {
  // Compare case-insensitively for Windows drive paths, slash-agnostically.
  return p.replace(/\\/g, "/").replace(/\/+$/, "");
}

/** Detect the OS style of an absolute path string. */
export function pathOS(p: string): OS {
  return /^[a-zA-Z]:[\\/]/.test(p) ? "windows" : "linux";
}

/**
 * Translate an absolute path under `fromRoot` to the equivalent path under
 * `toRoot` (expressed in `toOS` style). Returns undefined if `abs` is not
 * inside `fromRoot`.
 */
export function translatePath(
  abs: string,
  fromRoot: string,
  toRoot: string,
  toOS: OS,
): string | undefined {
  const a = normalizeForCompare(abs);
  const root = normalizeForCompare(fromRoot);
  const fromIsWin = pathOS(fromRoot) === "windows";
  const inside = fromIsWin
    ? a.toLowerCase() === root.toLowerCase() || a.toLowerCase().startsWith(root.toLowerCase() + "/")
    : a === root || a.startsWith(root + "/");
  if (!inside) return undefined;

  const rel = a.slice(root.length).replace(/^\/+/, ""); // posix-style relative
  const toRootClean = toRoot.replace(/[\\/]+$/, "");
  if (rel === "") return toRootClean;
  const joined = `${toRootClean}${sep(toOS)}${rel.split("/").join(sep(toOS))}`;
  return joined;
}
