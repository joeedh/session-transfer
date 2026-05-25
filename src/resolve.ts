import type { OS, PeerConfig, PeerKind, RawPeerConfig, RelayConfig } from "./types.js";
import type { SpawnSpec } from "./peer.js";
import { buildShellSpec, quoteClaude } from "./peer.js";
import type { RunOptions, RunResult } from "./run.js";
import { run } from "./run.js";

/**
 * Peer discovery + resolution.
 *
 * Config holds {@link RawPeerConfig} (os/repoRoot may be absent). Before a peer
 * can be used we must produce a fully-populated {@link PeerConfig}. For `docker`
 * peers that means *discovering* the container (by the `devcontainer.local_folder`
 * label that VS Code stamps on a devcontainer) and *probing* the in-container
 * repo root — so a peer can be used with little or no config at all.
 *
 * Every docker CLI call goes through an injectable {@link Runner} so tests can
 * feed canned output without a live daemon.
 */
export type Runner = (spec: SpawnSpec, opts?: RunOptions) => Promise<RunResult>;

/** The label VS Code / the devcontainer CLI stamps with the host workspace folder. */
const DEVCONTAINER_LABEL = "devcontainer.local_folder";

/** Normalize a path for slash- and case-insensitive comparison. */
function normFolder(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/** Last path segment, separator-agnostic (`C:\dev\foo` -> `foo`). */
function baseName(p: string): string {
  return p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? p;
}

/** Normalize a git remote URL for comparison (drop scheme noise/.git/trailing slash). */
function normUrl(u: string): string {
  return u.trim().toLowerCase().replace(/\.git$/, "").replace(/\/+$/, "");
}

/** The local checkout's `origin` URL (normalized), or undefined if it has none. */
async function gitOriginUrl(repoRoot: string, runner: Runner): Promise<string | undefined> {
  try {
    const res = await runner({ file: "git", args: ["-C", repoRoot, "remote", "get-url", "origin"] }, {});
    const u = res.stdout.trim();
    return res.code === 0 && u ? normUrl(u) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Locate a checkout of *this* repo inside a container. Repo-volume devcontainers
 * (cloned from GitHub) carry no local-folder label, so we look under /workspaces
 * for a checkout whose `origin` matches ours — falling back to a same-basename
 * match only when the local checkout has no remote to compare against.
 */
async function findRepoInContainer(
  container: string,
  localUrl: string | undefined,
  localBase: string,
  runner: Runner,
): Promise<string | undefined> {
  const script =
    'for d in /workspaces/*/; do u=$(git -C "$d" remote get-url origin 2>/dev/null); ' +
    '[ -n "$u" ] && echo "$d::$u"; done';
  const res = await runner(dockerExec(container, script), {});
  if (res.code !== 0) return undefined;
  let basenameMatch: string | undefined;
  for (const line of res.stdout.split(/\r?\n/)) {
    const i = line.indexOf("::");
    if (i < 0) continue;
    const path = line.slice(0, i).replace(/\/+$/, "");
    const url = normUrl(line.slice(i + 2));
    if (localUrl && url === localUrl) return path; // strong match: same remote
    if (baseName(path) === localBase) basenameMatch = path; // weak fallback
  }
  return localUrl ? undefined : basenameMatch;
}

function defaultOS(kind: PeerKind): OS {
  return kind === "windows" ? "windows" : "linux";
}

/** A bare `docker exec -i` (no `cd`) — used to probe before repoRoot is known. */
function dockerExec(container: string, command: string): SpawnSpec {
  return { file: "docker", args: ["exec", "-i", container, "bash", "-lc", command] };
}

/** The in-container absolute repo root, via git (falling back to the WORKDIR). */
async function probeRepoRoot(container: string, runner: Runner): Promise<string | undefined> {
  const res = await runner(
    dockerExec(container, "git rev-parse --show-toplevel 2>/dev/null || pwd"),
    {},
  );
  const out = res.stdout.trim().split(/\r?\n/).filter(Boolean).pop();
  return res.code === 0 && out ? out : undefined;
}

/**
 * Find running containers that hold *this* repo and synthesize a resolved docker
 * peer for each. A container matches if either:
 *   - its `devcontainer.local_folder` label equals the local repo root
 *     (local-folder devcontainers), or
 *   - it has a checkout of the same `origin` remote under /workspaces
 *     (repo-volume devcontainers, which carry no local-folder label).
 * Returns `[]` (never throws) if docker is unavailable — discovery is best-effort.
 */
export async function discoverDockerPeers(
  localRepoRoot: string,
  runner: Runner = run,
): Promise<PeerConfig[]> {
  let res: RunResult;
  try {
    res = await runner(
      {
        file: "docker",
        args: ["ps", "--no-trunc", "--format", `{{.ID}}\t{{.Names}}\t{{.Label "${DEVCONTAINER_LABEL}"}}`],
      },
      {},
    );
  } catch {
    return []; // docker CLI not installed / not on PATH — non-fatal
  }
  if (res.code !== 0) return [];

  const want = normFolder(localRepoRoot);
  const localUrl = await gitOriginUrl(localRepoRoot, runner);
  const localBase = baseName(localRepoRoot);
  const peers: PeerConfig[] = [];
  for (const line of res.stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const [id, names, folder] = line.split("\t");
    const container = (names && names.trim()) || (id && id.trim());
    if (!container) continue;
    const repoRoot =
      folder && normFolder(folder) === want
        ? await probeRepoRoot(container, runner) // label match: repo is the WORKDIR
        : await findRepoInContainer(container, localUrl, localBase, runner);
    if (!repoRoot) continue;
    peers.push({ name: container, kind: "docker", os: "linux", repoRoot, container });
  }
  return peers;
}

/** Fill in os/container/repoRoot for a raw peer, discovering/probing for docker. */
export async function resolvePeer(
  config: RelayConfig,
  raw: RawPeerConfig,
  runner: Runner = run,
): Promise<PeerConfig> {
  const os = raw.os ?? defaultOS(raw.kind);

  if (raw.kind === "docker") {
    let container = raw.container;
    let repoRoot = raw.repoRoot;
    if (!container) {
      const found = await discoverDockerPeers(config.repoRoot, runner);
      if (found.length === 0) {
        throw new Error(
          `docker peer "${raw.name}": no running container has a ${DEVCONTAINER_LABEL} ` +
            `label matching ${config.repoRoot}. Start the devcontainer or set "container".`,
        );
      }
      if (found.length > 1) {
        throw new Error(
          `docker peer "${raw.name}": multiple containers match ` +
            `(${found.map((f) => f.container).join(", ")}). Set "container" explicitly.`,
        );
      }
      container = found[0]!.container!;
      repoRoot = repoRoot ?? found[0]!.repoRoot;
    }
    if (!repoRoot) {
      repoRoot = await probeRepoRoot(container, runner);
      if (!repoRoot) {
        throw new Error(
          `docker peer "${raw.name}": could not determine the repo root in container ` +
            `"${container}" (is the repo checked out and git installed there?).`,
        );
      }
    }
    return { ...raw, os, container, repoRoot };
  }

  if (!raw.repoRoot) throw new Error(`peer "${raw.name}" is missing "repoRoot"`);
  return { ...raw, os, repoRoot: raw.repoRoot };
}

/**
 * Resolve a peer by name. Explicit config peers win; otherwise fall back to
 * implicit docker discovery (match by container name, or the `"docker"` alias
 * when exactly one container matches this repo).
 */
export async function resolvePeerByName(
  config: RelayConfig,
  name: string,
  runner: Runner = run,
): Promise<PeerConfig> {
  const explicit = config.peers.find((p) => p.name === name);
  if (explicit) return resolvePeer(config, explicit, runner);

  const discovered = await discoverDockerPeers(config.repoRoot, runner);
  const byName = discovered.find((p) => p.name === name);
  if (byName) return byName;
  if (name === "docker" && discovered.length === 1) return discovered[0]!;

  const names = [
    ...config.peers.map((p) => p.name),
    ...discovered.map((p) => p.name),
    ...(discovered.length === 1 ? ['"docker" (alias)'] : []),
  ];
  throw new Error(`No peer named "${name}". Available peers: ${names.join(", ") || "(none)"}.`);
}

/**
 * Every usable peer: explicit config peers (resolved) plus implicitly discovered
 * docker peers, deduped by container (explicit wins). Resolution errors are
 * collected per-peer rather than thrown, so `doctor` can report them.
 */
export async function listAllPeers(
  config: RelayConfig,
  runner: Runner = run,
): Promise<{ resolved: PeerConfig[]; errors: { name: string; error: string }[] }> {
  const resolved: PeerConfig[] = [];
  const errors: { name: string; error: string }[] = [];
  const seen = new Set<string>();

  for (const raw of config.peers) {
    try {
      const p = await resolvePeer(config, raw, runner);
      resolved.push(p);
      if (p.container) seen.add(p.container);
    } catch (e) {
      errors.push({ name: raw.name, error: (e as Error).message });
    }
  }
  for (const d of await discoverDockerPeers(config.repoRoot, runner)) {
    if (d.container && seen.has(d.container)) continue; // explicit entry already covers it
    resolved.push(d);
  }
  return { resolved, errors };
}

export interface EnsureClaudeResult {
  /** True if claude is runnable on the peer (possibly after installing). */
  installed: boolean;
  action: "present" | "installed" | "missing" | "failed";
  detail: string;
}

/** Install command tried inside the peer: npm global, falling back to the official script. */
const CLAUDE_INSTALL_CMD =
  "command -v npm >/dev/null 2>&1 && npm i -g @anthropic-ai/claude-code " +
  "|| curl -fsSL https://claude.ai/install.sh | bash";

/**
 * Ensure `claude` is runnable on the peer. Detects it; if missing and
 * `install` is set, installs it inside the peer and re-probes. Never mutates
 * the peer unless `install` is explicitly requested.
 */
export async function ensureClaude(
  peer: PeerConfig,
  opts: { install: boolean },
  runner: Runner = run,
): Promise<EnsureClaudeResult> {
  const probe = `${quoteClaude(peer)} --version`;
  const first = await runner(buildShellSpec(peer, probe), {});
  if (first.code === 0 && first.stdout.trim()) {
    return { installed: true, action: "present", detail: `claude ${first.stdout.trim().split(/\r?\n/)[0]}` };
  }

  if (!opts.install) {
    return {
      installed: false,
      action: "missing",
      detail:
        `claude is not installed on peer "${peer.name}". Re-run with --install-claude, ` +
        `or run inside it:\n  ${CLAUDE_INSTALL_CMD}`,
    };
  }

  const inst = await runner(buildShellSpec(peer, CLAUDE_INSTALL_CMD), {});
  const verify = await runner(buildShellSpec(peer, probe), {});
  if (verify.code === 0 && verify.stdout.trim()) {
    return { installed: true, action: "installed", detail: `installed claude ${verify.stdout.trim().split(/\r?\n/)[0]}` };
  }
  return {
    installed: false,
    action: "failed",
    detail: `claude install failed on "${peer.name}": ${(inst.stderr || inst.stdout).trim().slice(-400)}`,
  };
}
