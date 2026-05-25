# CLAUDE.md

Guidance for Claude Code working in this repo (`claude-relay`).

## What this is

A Node/TypeScript tool to **delegate Claude Code tasks across an OS boundary** (WSL ↔
Windows, later SSH) and **hand off whole sessions** between terminals. It ships a CLI
(`claude-relay`) and an stdio MCP server over one shared library in `src/`.

Read `documentation/` for depth — `architecture.md` first.

## Non-negotiable design constraints

These came directly from the user and must be preserved in any change:

1. **Two separate checkouts, separate filesystems.** Never assume the two sides share
   bytes on disk.
2. **No filesystem bridge.** `/mnt/c`, `\\wsl$`, `wslpath` may be absent or slow. Cross
   only the **process boundary**; move control data over **stdin/stdout** and code over
   **git** (bundle piped on stdout). Path translation is **repo-root-relative**, never
   `wslpath`.
3. **Peers are pluggable** (`wsl` / `windows` / `ssh`) so a remote Linux box drops in
   later with no core change.
4. **Billing safety is first-class** — see below.
5. **pnpm** is the package manager.

## Billing safety — do not regress

- **Strip `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_BASE_URL`** from every
  spawned peer env by default (`sanitizeEnv`). Never forward the caller's key over the
  transport. Opt back in only with explicit `--allow-api-key` / `allowApiKey`.
- **Cost ≠ billing route.** A subscription `claude -p` still reports `total_cost_usd`, so
  `parseCostFromResult` returns `billing: "unknown"`. The route is set by
  `billingRouteUsed()` (key present **and** allowed → `"api"`, else `"subscription"`).
  Do not reintroduce cost-based route inference.
- **Cap every job** (model/max-turns/budget); no silent retries.

## Permissions — do not regress

- Delegated jobs default to `acceptEdits` + a narrow `DEFAULT_ALLOWED_TOOLS` (edits +
  `git add/commit/status/diff`).
- **Never default to `bypassPermissions`.** It is user-opt-in only; an agent choosing it
  itself is blocked by the harness auto-mode classifier ("Create Unsafe Agents").

## Conventions

- ESM + TypeScript strict, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`. Imports use
  `.js` extensions. Watch for `m?.[1] ?? fallback` on regex matches.
- The CLI/MCP are thin wrappers; put logic in the library modules and re-export from
  `src/index.ts`.

## Platform gotchas (already solved — keep them)

- **Spawning `cmd.exe` from Node requires `windowsVerbatimArguments: true`** (set in
  `run.ts`), or Node's escaping mangles the `cd /d "..." && cmd` string. The `/d /s /c`
  form lets cmd strip only the outer quotes.
- **Quote each argv token for the target shell** (`quoteArg`/`composeArgv`). Flag values
  with spaces/parens (e.g. `--allowedTools "Bash(git commit:*)"`) otherwise get split and
  parens become shell metacharacters — a real bug that silently dropped the commit grant.

## Build / test

```bash
pnpm install
pnpm build          # tsc -> dist/
pnpm test           # tsc -p tsconfig.test.json && node --test (24 tests)
```

Tests live in `test/` (`pathmap`, `billing`, `delegate`) and cover path mapping, billing
guardrails, and command composition.

## Repo state notes

- `relay.config.local.json` is gitignored, per-machine live config. The committed example
  is `relay.config.example.json`.
- Don't commit unless the user asks. End commit messages with the
  `Co-Authored-By: Claude` trailer.

## Known limitations (documented, not bugs)

- The carry-back bundle is incremental (`base..HEAD`); applying needs the base commit
  present locally.
- Handoff rewrites structured paths only, not free-form prose paths.
- The `ssh` peer kind is scaffolded but not exercised end-to-end.
