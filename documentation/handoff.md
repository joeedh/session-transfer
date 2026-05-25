# Session handoff

Handoff is the secondary feature: move a whole conversation to the other terminal. It
translates the current session transcript to the peer's checkout, delivers it over the
transport, and prints the `claude --resume <id>` command to continue on the peer.

Implemented in `src/handoff.ts`.

## Where sessions live

A Claude Code session is fully captured by its transcript:

```
~/.claude/projects/<encoded-cwd>/<session-id>.jsonl
```

The encoding replaces `\`, `/`, and `:` with `-`:

- `C:\dev\foo`  → `C--dev-foo`
- `/home/u/dev/foo` → `-home-u-dev-foo`

(`encodeProjectDir` does this.) The transcript is the **single source of truth** —
`session-env/` is empty and `tasks/<uuid>/` holds only lock files. See the
`reference-claude-session-storage` memory.

- `localProjectsDir(cwd)` — the projects dir for a cwd.
- `findTranscript(cwd, sessionId?)` — the named session's jsonl, or the most recent one.

## Translating the transcript

`translateTranscriptLine(line, localRoot, peerRoot, peerOS)` parses each JSONL line and
**recursively remaps every string** through `translatePath`. Strings under the local repo
root become peer paths; everything else is left untouched.

This rewrites structured, path-bearing fields (`cwd`, tool-use `file_path`, etc.).
**Limitation:** free-form paths embedded in prose inside text blocks are *not* rewritten —
they aren't distinguishable from ordinary text and many lie outside the repo root anyway.

## Delivering it (no filesystem bridge)

`prepareHandoff(config, peer, {sessionId?, fork?})` returns a `HandoffPlan`:

```ts
{ sessionId, transcriptPath, content, peerDestPath, resumeCommand }
```

`deliverHandoff(peer, plan)` writes the translated content onto the peer **over the
transport** — there is no shared filesystem. The peer shell computes its **own** home dir
so we never depend on a bridge or on env expansion inside quotes:

- **windows:** a `powershell -NoProfile` command that joins `$env:USERPROFILE`, creates
  the projects dir, reads the transcript from stdin (`[Console]::In.ReadToEnd()`), and
  writes it with `[IO.File]::WriteAllText`.
- **linux:** `dest="$HOME/.claude/projects/<enc>/<id>.jsonl"; mkdir -p ... && cat > "$dest"`.

The content is fed to that command on **stdin**. A `docker` peer uses the linux branch,
delivered through `docker exec -i` — the `-i` keeps stdin open so the transcript pipes in.
Because resuming needs `claude` in the container, the CLI probes it first and
`--install-claude` will install it on demand (see `configuration.md`).

## Resuming

`resumeCommand` is `claude --resume <sessionId>` (plus `--fork-session` when `fork` is
set). Run it on the peer terminal to continue the conversation with peer-native paths.

The CLI defaults to a **dry run** (it prints the plan); pass `--deliver` to actually write
the transcript onto the peer.
