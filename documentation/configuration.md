# Configuration & path translation

## Config file

`src/config.ts` resolves the config in this order (first hit wins):

1. `$CLAUDE_RELAY_CONFIG`
2. `<cwd>/relay.config.local.json` — gitignored, per-machine
3. `<cwd>/relay.config.json` — committed

The config declares **this machine's** repo root and the reachable peers. Each peer's
`repoRoot` is the checkout path **on that peer**, in peer-native form.

```jsonc
{
  "repoRoot": "C:\\dev\\foo",
  "peers": [
    { "name": "windows", "kind": "windows", "os": "windows",
      "repoRoot": "C:\\dev\\foo",
      "claudePath": "C:\\Users\\me\\.local\\bin\\claude.exe" },
    { "name": "wsl", "kind": "wsl", "os": "linux", "distro": "Ubuntu",
      "repoRoot": "/home/me/dev/foo" },
    { "name": "gpubox", "kind": "ssh", "os": "linux",
      "sshTarget": "gpubox", "repoRoot": "/home/me/dev/foo" }
  ]
}
```

`PeerConfig` fields (`src/types.ts`):

| Field | Meaning |
| --- | --- |
| `name` | Name used on the CLI/MCP (`--to <name>`). |
| `kind` | `wsl` \| `windows` \| `ssh` \| `docker` — selects the transport. |
| `os` | `windows` \| `linux` — path style + default claude binary. Optional; defaults to `windows` for `kind: windows`, else `linux`. |
| `repoRoot` | Absolute checkout path **on the peer**. Optional for `docker` (probed in-container). |
| `claudePath?` | `claude` binary on the peer (defaults to `claude` on PATH). |
| `distro?` | wsl only: `wsl.exe -d <distro>`. |
| `sshTarget?` | ssh only: `user@host` or an ssh config alias. |
| `container?` | docker only: container name/id. Auto-discovered from the devcontainer label if omitted. |

`loadConfig` validates: `repoRoot` absolute, non-empty `peers`, each peer's `kind` valid,
`os` valid when present, `ssh` peers have a `sshTarget`, and `repoRoot` present for every
kind **except** `docker` (which probes it). The config holds a `RawPeerConfig`; missing
`os`/`repoRoot`/`container` are filled in by `resolvePeer` (`src/resolve.ts`) before use.

## Docker / devcontainer peers

A `docker` peer is reached with `docker exec -i <container> bash -lc '…'`. It is designed to
need almost no configuration:

- **Discovery.** `discoverDockerPeers` runs `docker ps` and matches a container two ways:
  by its `devcontainer.local_folder` label equal to this machine's `repoRoot` (local-folder
  devcontainers), **or** by a checkout under `/workspaces` whose `origin` remote matches ours
  (repo-volume devcontainers cloned from GitHub, which carry no local-folder label; a
  same-basename match is used only when the local checkout has no remote). A match is
  reachable as `--to docker` with **no config entry at all**; if several match, name them
  explicitly.
- **repoRoot probing.** The in-container path comes from `git rev-parse --show-toplevel`
  (falling back to the container's WORKDIR) — so e.g. `C:\dev\foo` maps to
  `/workspaces/foo` automatically.
- **Overrides.** An explicit `container` and/or `repoRoot` in the config always wins over
  discovery, which also covers plain (non-devcontainer) containers.
- **claude presence.** Resuming a handoff needs `claude` inside the container. `doctor`
  reports if it's missing; `handoff --install-claude` (or the MCP `installClaude` arg)
  installs it on demand (`npm i -g @anthropic-ai/claude-code`, falling back to the official
  install script). Nothing is installed unless you ask.

## Path translation (repo-root-relative)

The two checkouts do **not** share a filesystem and no bridge (`wslpath`/`/mnt`) is
assumed. Translation is purely by repo root: a local absolute path under the local root
maps to the same relative path under the peer root, re-joined with the peer's separator.

- `translatePath(abs, fromRoot, toRoot, toOS)` — returns the peer path, or `undefined` if
  `abs` is **outside** `fromRoot` (untranslatable). Windows roots compare
  case-insensitively; comparison is slash-agnostic.
- `pathOS(p)` — detects `windows` (drive-letter prefix) vs `linux` style.

Example: `C:\dev\foo\src\x.ts` under `C:\dev\foo` → `/home/u/dev/foo/src/x.ts` under
`/home/u/dev/foo` on a linux peer.

Paths outside the repo root can't be translated — which is exactly why handoff path
rewriting is best-effort for free-form prose (see `handoff.md`).
