# claude-relay documentation

Deep-dive docs for the cross-OS Claude task delegation & session handoff tool. The
top-level `../README.md` is the user-facing quickstart; these pages cover the internals.

- [architecture.md](architecture.md) — constraints, module map, data flow.
- [delegation.md](delegation.md) — the primary feature: brief, permissions, claude
  invocation, git-bundle carry-back.
- [handoff.md](handoff.md) — session transcript translation & delivery, resume.
- [billing-safety.md](billing-safety.md) — the `src/billing.ts` guardrail subsystem and
  why cost ≠ billing route.
- [configuration.md](configuration.md) — config resolution, peers, repo-root-relative
  path translation.
- [cli-and-mcp.md](cli-and-mcp.md) — CLI commands/flags and the MCP tools.

For working *in* this repo as an agent, start with the root [`../CLAUDE.md`](../CLAUDE.md).
