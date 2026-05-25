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
| `kind` | `wsl` \| `windows` \| `ssh` — selects the transport. |
| `os` | `windows` \| `linux` — path style + default claude binary. |
| `repoRoot` | Absolute checkout path **on the peer**. |
| `claudePath?` | `claude` binary on the peer (defaults to `claude` on PATH). |
| `distro?` | wsl only: `wsl.exe -d <distro>`. |
| `sshTarget?` | ssh only: `user@host` or an ssh config alias. |

`loadConfig` validates: `repoRoot` absolute, non-empty `peers`, each peer's `kind`/`os`
valid, ssh peers have a `sshTarget`.

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
