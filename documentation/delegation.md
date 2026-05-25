# Delegation

Delegation is the primary feature: the calling session stays put and launches a **fresh
headless `claude -p`** on a peer, which works in the peer's own checkout, commits, and
returns a structured result plus a git bundle of its new commits.

Implemented in `src/delegate.ts`. Entry point: `delegate(peer, opts)`.

## The brief (`buildBrief`)

The peer agent receives its instructions as the `-p` prompt **over stdin** — never a
shared file. The brief contains:

- the job id and which peer it is running on (and that the caller is on a different
  checkout);
- the peer's repo root as the working directory;
- the task text and any `relevantFiles` (repo-relative);
- **rules**: do the work here, make focused commits, do not push/force-push/touch
  unrelated files, stay on the current branch;
- the **result protocol**: end the final message with a `### RELAY RESULT` section
  summarizing what was done and any requested output.

`extractRelayResult(text)` pulls that section back out (regex
`/###\s*RELAY RESULT\s*\n([\s\S]*)$/i`), falling back to the full text if the agent
didn't emit the heading.

## Permissions

A delegated agent is headless — there is no human to answer permission prompts — so it
needs *standing* permission to act. The defaults are deliberately the least powerful that
still work:

- `DEFAULT_PERMISSION_MODE = "acceptEdits"`
- `DEFAULT_ALLOWED_TOOLS = "Edit Write Read Bash(git add:*) Bash(git commit:*) Bash(git status:*) Bash(git diff:*)"`

`bypassPermissions` is available but must be chosen **explicitly by the user** — it is
never defaulted, because it creates an unrestricted agent. (The Claude Code harness's
auto-mode classifier will itself *block* an agent that chooses `bypassPermissions` on its
own; see `reference-claude-session-storage` memory.)

`claudeFlags()` only appends `--allowedTools` when the mode is *not* `bypassPermissions`
(under bypass the allow-list is moot).

## The claude invocation

`claudeFlags(billing, permissionMode, allowedTools)` produces:

```
--print --input-format text --output-format stream-json --verbose
--permission-mode <mode> [--allowedTools "<tools>"]
--model <m> --max-turns <n> [--max-budget-usd <n>]      (from billingFlags)
```

The argv is assembled as an **array** `[claudeBin(peer), ...flags]` and then quoted
**per token** by `composeArgv(peer, argv)` before being handed to `buildShellSpec`. This
matters: an `--allowedTools` value like `Bash(git commit:*)` contains spaces and parens;
without per-token quoting the peer shell splits it and the parens become metacharacters,
so the commit silently never gets allowed. (This was a real bug — see the project
history.)

## Carrying commits back (git bundle)

1. Before running, capture the peer's `HEAD` (`baseHead`).
2. After running, capture `HEAD` again (`newHead`).
3. If they differ, `git log --oneline base..new` gives the human-readable `commits[]`, and
   `git bundle create - base..HEAD` (collected as **base64 via `binaryStdout`**) becomes
   `bundleBase64`.

The caller writes the bundle and applies it with:

```
git fetch relay-<jobId>.bundle HEAD && git merge FETCH_HEAD
```

**Limitation:** the bundle is incremental (`base..HEAD`), so the caller's checkout must
already contain `base` (the commit the peer started from). Keep the checkouts roughly in
sync, or use a shared remote.

## Result

`DelegateResult`:

```ts
{ jobId, peer, summary, ok, cost, bundleBase64?, commits[], error? }
```

- `ok` is true when the stream-json `result` event has subtype `success` (or
  `is_error === false`).
- `cost.billing` is set from `billingRouteUsed()` — **not** inferred from cost (see
  `billing-safety.md`).
