#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { loadConfig } from "./config.js";
import { delegate } from "./delegate.js";
import { prepareHandoff, deliverHandoff } from "./handoff.js";
import { resolvePeerByName, listAllPeers, ensureClaude } from "./resolve.js";
import { doctor } from "./doctor.js";
import type { DelegateOptions } from "./delegate.js";

function parseFlags(argv: string[]): { positional: string[]; flags: Record<string, string | boolean> } {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        flags[key] = true;
      } else {
        flags[key] = next;
        i++;
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

function die(msg: string): never {
  console.error(`error: ${msg}`);
  process.exit(1);
}

const USAGE = `claude-relay — cross-OS Claude task delegation & session handoff

Usage:
  claude-relay delegate --to <peer> --task "<text>" [options]
  claude-relay handoff  --to <peer> [--session <id>] [--fork] [--deliver]
  claude-relay doctor
  claude-relay config

Delegate options:
  --to <peer>            peer name from relay.config.json (required)
  --task "<text>"        the task for the peer agent (required)
  --files a,b,c          repo-relative files to highlight
  --model <name>         model for the delegated job (default: cheaper model)
  --max-turns <n>        cap agentic turns
  --max-budget-usd <n>   hard spend ceiling for the job
  --allow-api-key        DANGER: keep API-key env vars (may bill metered API)
  --permission-mode <m>  peer permission mode (default: acceptEdits; use
                         bypassPermissions only if you want a fully autonomous agent)
  --allowed-tools "<s>"  tools the peer may run without prompting
                         (default: edits + git add/commit/status/diff)
  --apply                apply the returned git bundle into the local checkout

Handoff options:
  --session <id>         session to hand off (default: most recent in this repo)
  --fork                 resume as a forked session on the peer
  --deliver              write the translated transcript onto the peer (else dry-run)
  --install-claude       install claude on the peer if missing (needed to resume)

Peers may be "wsl", "windows", "ssh", or "docker". A docker peer needs no config:
a running devcontainer whose devcontainer.local_folder label matches this repo is
auto-discovered and reachable as --to docker (its repoRoot is probed in-container).
`;

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  const { flags } = parseFlags(rest);

  if (!cmd || cmd === "help" || cmd === "--help") {
    console.log(USAGE);
    return;
  }

  if (cmd === "config") {
    const config = loadConfig();
    console.log(JSON.stringify(config, null, 2));
    const { resolved, errors } = await listAllPeers(config);
    console.log(`\nresolved peers (incl. auto-discovered docker):`);
    for (const p of resolved) {
      console.log(`  ${p.name}  [${p.kind}${p.container ? `: ${p.container}` : ""}]  ${p.os}  ${p.repoRoot}`);
    }
    for (const e of errors) console.log(`  ${e.name}  (unresolved: ${e.error})`);
    return;
  }

  if (cmd === "doctor") {
    const report = await doctor(loadConfig());
    for (const c of report.checks) {
      console.log(`${c.ok ? "✓" : "✗"} ${c.name}: ${c.detail}`);
    }
    console.log("");
    for (const n of report.notes) console.log(`note: ${n}`);
    process.exit(report.ok ? 0 : 1);
  }

  if (cmd === "delegate") {
    const config = loadConfig();
    const to = str(flags.to) ?? die("--to <peer> is required");
    const task = str(flags.task) ?? die('--task "<text>" is required');
    const peer = await resolvePeerByName(config, to);
    const opts: DelegateOptions = {
      task,
      relevantFiles: str(flags.files)?.split(",").map((s) => s.trim()).filter(Boolean),
      model: str(flags.model),
      maxTurns: num(flags["max-turns"]),
      maxBudgetUsd: num(flags["max-budget-usd"]),
      allowApiKey: flags["allow-api-key"] === true,
      permissionMode: str(flags["permission-mode"]),
      allowedTools: str(flags["allowed-tools"]),
      onProgress: (t) => process.stderr.write(`· ${t.slice(0, 120)}\n`),
    };
    console.error(`delegating to "${peer.name}" (${peer.os})...`);
    const result = await delegate(peer, opts);

    console.log(`\n=== delegate result (job ${result.jobId}) ===`);
    console.log(`ok: ${result.ok}`);
    if (result.error) console.log(`error: ${result.error}`);
    console.log(`commits: ${result.commits.length ? "\n  " + result.commits.join("\n  ") : "(none)"}`);
    console.log(`cost: ${formatCost(result)}`);
    console.log(`\n${result.summary}`);

    if (result.bundleBase64) {
      const bundlePath = `relay-${result.jobId}.bundle`;
      writeFileSync(bundlePath, Buffer.from(result.bundleBase64, "base64"));
      console.log(`\ngit bundle written to ${bundlePath}`);
      console.log(`to apply here: git fetch ${bundlePath} HEAD && git merge FETCH_HEAD`);
      console.log(`(requires this checkout to contain the commit the peer started from)`);
    }
    process.exit(result.ok ? 0 : 1);
  }

  if (cmd === "handoff") {
    const config = loadConfig();
    const to = str(flags.to) ?? die("--to <peer> is required");
    const peer = await resolvePeerByName(config, to);
    const plan = prepareHandoff(config, peer, {
      sessionId: str(flags.session),
      fork: flags.fork === true,
    });
    console.log(`session:     ${plan.sessionId}`);
    console.log(`source:      ${plan.transcriptPath}`);
    console.log(`peer:        ${peer.name} (${peer.kind}${peer.container ? `: ${peer.container}` : ""})`);
    console.log(`peer dest:   ${plan.peerDestPath}`);
    console.log(`then run on "${peer.name}":\n  ${plan.resumeCommand}`);

    // Resuming on the peer needs claude installed there. Probe it; install only
    // if the user opted in with --install-claude.
    const claude = await ensureClaude(peer, { install: flags["install-claude"] === true });
    console.log(`\nclaude on peer: ${claude.detail}`);

    if (flags.deliver === true) {
      await deliverHandoff(peer, plan);
      console.log(`\n✓ transcript delivered to peer.`);
      if (!claude.installed) {
        console.log(`⚠ claude is not runnable on the peer yet — resume will fail until it is installed.`);
      }
    } else {
      console.log(`\n(dry run — pass --deliver to write it onto the peer)`);
    }
    return;
  }

  die(`unknown command "${cmd}". Run "claude-relay help".`);
}

function str(v: string | boolean | undefined): string | undefined {
  return typeof v === "string" ? v : undefined;
}
function num(v: string | boolean | undefined): number | undefined {
  const s = str(v);
  return s != null ? Number(s) : undefined;
}
function formatCost(r: { cost: { totalCostUsd?: number; inputTokens?: number; outputTokens?: number; numTurns?: number; billing: string } }): string {
  const c = r.cost;
  const parts: string[] = [];
  if (c.totalCostUsd != null) parts.push(`$${c.totalCostUsd.toFixed(4)}`);
  if (c.inputTokens != null) parts.push(`in=${c.inputTokens}`);
  if (c.outputTokens != null) parts.push(`out=${c.outputTokens}`);
  if (c.numTurns != null) parts.push(`turns=${c.numTurns}`);
  parts.push(`billing=${c.billing}`);
  return parts.join(" ");
}

main().catch((e) => die((e as Error).message));
