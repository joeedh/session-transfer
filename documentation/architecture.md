# Architecture

claude-relay is a single Node/TypeScript package (ESM) shipping two surfaces over one
shared library: a CLI (`claude-relay`) and an stdio MCP server. Both are thin wrappers
around `src/`.

## The hard constraints that shaped everything

1. **Two separate checkouts on separate filesystems.** The Windows and WSL sides are
   independent git clones of the same repo. They do *not* share bytes on disk.
2. **No filesystem bridge may be assumed.** `/mnt/c`, `\\wsl$`, and `wslpath` may be slow
   or entirely absent. The tool crosses only the **process boundary** (`wsl.exe` /
   `cmd.exe` / `ssh`) and moves control data over **stdin/stdout**; code moves only via
   **git** (a bundle piped back over stdout).
3. **A remote Linux box should drop in later over SSH.** Transport is therefore a
   pluggable "peer" abstraction from day one (`wsl` / `windows` / `ssh` / `docker`).

These are recorded in memory as `project_two_checkouts` and
`reference-claude-session-storage`.

## Module map

| Module | Responsibility |
| --- | --- |
| `src/types.ts` | Shared types: `OS`, `PeerKind`, `PeerConfig`, `RelayConfig`, `BillingOptions`, `JobCost`, `DelegateResult`. |
| `src/config.ts` | Config resolution/validation; **repo-root-relative** path translation (`translatePath`, `pathOS`). No `wslpath`. |
| `src/peer.ts` | The pluggable peer abstraction. `buildShellSpec` turns a command string into a `spawn` spec per peer kind (`wsl`/`windows`/`ssh`/`docker`). Per-token shell quoting (`quoteArg`, `composeArgv`). |
| `src/resolve.ts` | Peer resolution: fill `os`/`repoRoot`, auto-discover `docker` peers from the `devcontainer.local_folder` label and probe their in-container repo root. `resolvePeerByName`, `listAllPeers`, `ensureClaude` (detect/install claude on a peer). |
| `src/run.ts` | `run(spec, opts)` — spawns the child, feeds stdin, collects stdout (utf8 or base64), streams NDJSON lines. Owns the `windowsVerbatimArguments` fix. |
| `src/billing.ts` | The billing-safety subsystem. Env stripping, cost/flag helpers, route detection. Every spawn passes through it. |
| `src/delegate.ts` | Core feature: build a brief, run headless `claude -p` on the peer, parse the stream, bundle new commits back. |
| `src/handoff.ts` | Secondary feature: translate a session transcript to the peer's checkout and deliver it over the transport. |
| `src/doctor.ts` | Reachability + billing-safety checks for the local side and each peer. |
| `src/cli.ts` | Argument parsing + the `delegate`/`handoff`/`doctor`/`config` commands. |
| `src/mcp-server.ts` | Registers `delegate_to_os`, `prepare_handoff`, `relay_doctor` as MCP tools. |
| `src/index.ts` | Re-exports the library. |

## Data flow: a delegate call

```
caller (CLI / MCP tool / a running session's subagent)
  └─ delegate(peer, opts)                              src/delegate.ts
       ├─ resolveBillingOptions + sanitizeEnv          src/billing.ts   (strip API keys)
       ├─ peerGit "rev-parse HEAD"  ── buildShellSpec ─┐
       ├─ buildBrief(...)            (the -p prompt)   │
       ├─ composeArgv([claude, ...claudeFlags])        │ src/peer.ts
       │                                               │
       └─ run(spec, {stdin: brief, onLine})  ──────────┴─ spawn wsl.exe/cmd.exe/ssh
            │                                              └─ headless `claude -p`
            │                                                   on the peer checkout
            ├─ stream-json NDJSON  → handleStreamLine → progress + result + cost
            └─ peerGit "bundle create - base..HEAD" (binaryStdout) → bundleBase64
       ⇒ DelegateResult { summary, ok, cost, commits, bundleBase64 }
```

The caller writes `bundleBase64` to `relay-<jobId>.bundle` and applies it with
`git fetch <bundle> HEAD && git merge FETCH_HEAD`.

## Why these mechanics

- **Brief over stdin, not a shared file** — there is no shared filesystem to write to.
- **Git bundle over stdout, not a shared remote** — works with no remote and no bridge.
  A shared remote is an optional optimization, not a requirement.
- **Repo-root-relative path translation, not `wslpath`** — the bridge may not exist, and
  the two roots differ (`C:\dev\foo` vs `/home/u/dev/foo`). See `configuration.md`.
- **Peers are resolved, not just read** — config holds a `RawPeerConfig` (os/repoRoot may
  be omitted). Each entry point resolves a peer by name (`resolvePeerByName`, `src/resolve.ts`)
  just before use. For `docker` this discovers the container via the devcontainer label and
  probes its repo root over the transport, so a devcontainer needs **no** config and its
  path can't rot. All execution code still receives a fully-populated `PeerConfig`, so the
  transport layer (`buildShellSpec` → `run`) is unchanged.

See `delegation.md`, `handoff.md`, `billing-safety.md`, `configuration.md`, `cli.md`, and
`mcp.md` for the per-area detail.
