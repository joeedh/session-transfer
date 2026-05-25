# claude-relay

Delegate Claude Code tasks across an OS boundary — e.g. a **WSL** session that needs the
**Windows** host GPU — and hand off whole sessions between terminals. Built for the case
where the two sides are **separate git checkouts** (no shared filesystem, no `/mnt` bridge
assumed) and may later include a **remote Linux box over SSH**.

It ships two things:
- a CLI (`claude-relay`)
- an stdio **MCP server** so a running session (and its subagents) can call delegation as
  first-class tools.

## How it works

- **Delegation (`delegate_to_os` / `claude-relay delegate`)** — the caller stays put and
  launches a fresh headless `claude -p` on the peer over the process boundary
  (`wsl.exe` / `cmd.exe` / `ssh`), feeding it a brief over **stdin** (no shared files). The
  peer agent works in its own checkout, commits, and the new commits come back as a **git
  bundle** the caller can apply. A structured summary (and cost) is returned.
- **Handoff (`prepare_handoff` / `claude-relay handoff`)** — translates the current session
  transcript's paths to the peer's checkout, delivers it over the transport, and prints the
  `claude --resume <id>` command to continue on the other side.

No filesystem bridge is used: control data crosses via stdin/stdout, code crosses via git.

## Billing safety

Headless `claude -p` is billed against your Claude **subscription** — *unless* an API-key
env var leaks into the spawned process, which silently switches it to metered pay-as-you-go
API (a documented cause of large surprise bills). claude-relay therefore:

- **strips `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_BASE_URL`** from the
  spawned peer environment by default (opt back in only with `--allow-api-key`);
- never forwards your key across the transport;
- **caps every job**: cheaper default model, `--max-turns`, optional `--max-budget-usd`, no
  silent retries;
- reports the route used (`billing=subscription|api`) and token cost back to you;
- `claude-relay doctor` checks both sides for stray API keys.

> Note: from **2026-06-15**, subscription `claude -p` / Agent-SDK usage draws from a separate
> monthly Agent-SDK credit pool, distinct from your interactive limits.

## Permissions

A delegated agent is headless, so it can't answer prompts. The default is the **least**
powerful mode that still works: `--permission-mode acceptEdits` plus a narrow
`--allowed-tools` set (edits + `git add/commit/status/diff`). For tasks that must run
arbitrary build/run tools (e.g. GPU builds), widen `--allowed-tools` or — only if you
intend a fully autonomous agent — pass `--permission-mode bypassPermissions`. The tool
**never** defaults to bypass.

## Setup

```bash
pnpm install
pnpm build
cp relay.config.example.json relay.config.json   # then edit, or use relay.config.local.json
claude-relay doctor
```

Config (`relay.config.json`, or per-machine `relay.config.local.json`, or
`$CLAUDE_RELAY_CONFIG`) declares this checkout's root and the reachable peers:

```jsonc
{
  "repoRoot": "C:\\dev\\foo",
  "peers": [
    { "name": "windows", "kind": "windows", "os": "windows",
      "repoRoot": "C:\\dev\\foo", "claudePath": "C:\\Users\\me\\.local\\bin\\claude.exe" },
    { "name": "wsl", "kind": "wsl", "os": "linux", "distro": "Ubuntu",
      "repoRoot": "/home/me/dev/foo" },
    { "name": "gpubox", "kind": "ssh", "os": "linux",
      "sshTarget": "gpubox", "repoRoot": "/home/me/dev/foo" }
  ]
}
```

Register the MCP server (already in `.mcp.json` for this repo):

```json
{ "mcpServers": { "claude-relay": { "command": "node", "args": ["dist/mcp-server.js"] } } }
```

## Usage

```bash
# Delegate a task to the Windows peer; apply the result locally afterward.
claude-relay delegate --to windows \
  --task "Build the CUDA kernel and run the benchmark; commit results to bench/out.json" \
  --model claude-haiku-4-5 --max-turns 12 --max-budget-usd 1.00

# Hand the current conversation off to WSL.
claude-relay handoff --to wsl --deliver
# then on WSL:  claude --resume <printed-id>

claude-relay doctor      # reachability + billing-safety checks
claude-relay config      # show resolved config
```

## Limitations

- The carry-back bundle is incremental (`base..HEAD`); applying it requires your checkout to
  contain the commit the peer started from. Keep the checkouts roughly in sync, or use a
  shared remote.
- Handoff path translation rewrites the `cwd` and structured tool paths under the repo root;
  free-form paths inside prose are left as-is.
- `ssh` peer kind is scaffolded but not yet exercised end-to-end.

## Develop

```bash
pnpm test     # unit tests (path mapping, billing guardrails, command composition)
```
