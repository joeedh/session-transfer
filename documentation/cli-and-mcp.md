# CLI & MCP reference

Both surfaces are thin wrappers over `src/` (the library). The CLI is `src/cli.ts`; the
MCP server is `src/mcp-server.ts`.

## CLI

```
claude-relay delegate --to <peer> --task "<text>" [options]
claude-relay handoff  --to <peer> [--session <id>] [--fork] [--deliver] [--install-claude]
claude-relay doctor
claude-relay config
```

`<peer>` is a name from the config, or `docker` (or a container name) for a devcontainer
auto-discovered for this repo — see `configuration.md`.

### `delegate`

| Flag | Meaning |
| --- | --- |
| `--to <peer>` | Peer name from the config (required). |
| `--task "<text>"` | The task for the peer agent (required). |
| `--files a,b,c` | Repo-relative files to highlight in the brief. |
| `--model <name>` | Model for the job (default: a cheaper model). |
| `--max-turns <n>` | Cap agentic turns. |
| `--max-budget-usd <n>` | Hard spend ceiling for the job. |
| `--allow-api-key` | DANGER: keep API-key env vars (may bill metered API). |
| `--permission-mode <m>` | Peer permission mode (default `acceptEdits`). |
| `--allowed-tools "<s>"` | Tools the peer may run without prompting. |
| `--apply` | Apply the returned bundle into the local checkout. |

On success it prints the job id, `ok`, the commit list, the cost line
(`$… in=… out=… turns=… billing=subscription|api`), and the result summary. If the peer
made commits it writes `relay-<jobId>.bundle` and prints the apply command.

### `handoff`

Prints the session id, source transcript path, the resolved peer (kind + container), peer
destination path, and the `claude --resume` command. Defaults to a **dry run**; `--deliver`
writes the translated transcript onto the peer. `--fork` resumes as a forked session. It
also probes `claude` on the peer; `--install-claude` installs it there if missing (required
before `--resume` will work) — without the flag it just reports the missing binary and the
install command.

### `doctor` / `config`

`doctor` prints a `✓`/`✗` line per check (local env, local billing route, each peer's
claude reachability + billing route) and the Agent-SDK credit note; exits non-zero if any
check fails. It checks **explicit config peers plus auto-discovered docker peers**, reports
unresolved peers, and — for a peer missing `claude` — prints the `--install-claude` hint.
`config` prints the config JSON followed by the resolved peer list (including discovered
docker peers).

### Flag parsing note

`parseFlags` treats `--flag` followed by a non-`--` token as `flag=value`, otherwise as a
boolean `true`. Comma-split lists (`--files`) are trimmed and emptied-filtered.

## MCP server

Registered for this repo in `.mcp.json`:

```json
{ "mcpServers": { "claude-relay": { "command": "node", "args": ["dist/mcp-server.js"] } } }
```

Build first (`pnpm build`) so `dist/mcp-server.js` exists. Tools (zod input schemas):

| Tool | Inputs | Returns |
| --- | --- | --- |
| `delegate_to_os` | `to`, `task`, `files?`, `model?`, `maxTurns?`, `maxBudgetUsd?`, `allowApiKey?` | The full `DelegateResult` as JSON; `isError` when `!ok`. |
| `prepare_handoff` | `to`, `session?`, `fork?`, `deliver?`, `installClaude?` | `{ sessionId, peer, peerDestPath, resumeCommand, delivered, claude }`. |
| `relay_doctor` | (none) | The full `DoctorReport`; `isError` when not ok. |

Because the MCP server is registered in the repo, a running session **and any subagent it
spawns** can call these as first-class tools — which is the original motivating use case
(a WSL session delegating GPU work to the Windows host).
