#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadConfig, getPeer } from "./config.js";
import { delegate } from "./delegate.js";
import { prepareHandoff, deliverHandoff } from "./handoff.js";
import { doctor } from "./doctor.js";

const server = new McpServer({ name: "claude-relay", version: "0.1.0" });

server.registerTool(
  "delegate_to_os",
  {
    description:
      "Delegate a focused task to a fresh Claude on another OS/checkout (e.g. WSL<->Windows). " +
      "The peer agent works in its own checkout, commits, and returns a summary plus a git " +
      "bundle of its commits. Billing-safe: API-key env vars are stripped from the peer unless " +
      "allowApiKey is set, and jobs are capped by model/max-turns/budget.",
    inputSchema: {
      to: z.string().describe("peer name from relay.config.json"),
      task: z.string().describe("the task for the peer agent, in natural language"),
      files: z.array(z.string()).optional().describe("repo-relative files to highlight"),
      model: z.string().optional().describe("model for the delegated job (default: a cheaper model)"),
      maxTurns: z.number().optional().describe("cap on agentic turns"),
      maxBudgetUsd: z.number().optional().describe("hard spend ceiling for this job (USD)"),
      allowApiKey: z.boolean().optional().describe("DANGER: allow metered-API billing on the peer"),
    },
  },
  async (args) => {
    const config = loadConfig();
    const peer = getPeer(config, args.to);
    const result = await delegate(peer, {
      task: args.task,
      relevantFiles: args.files,
      model: args.model,
      maxTurns: args.maxTurns,
      maxBudgetUsd: args.maxBudgetUsd,
      allowApiKey: args.allowApiKey ?? false,
    });
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      isError: !result.ok,
    };
  },
);

server.registerTool(
  "prepare_handoff",
  {
    description:
      "Prepare (and optionally deliver) a full session handoff to a peer: translates the current " +
      "transcript's paths to the peer's checkout and returns the `claude --resume` command to run there.",
    inputSchema: {
      to: z.string().describe("peer name from relay.config.json"),
      session: z.string().optional().describe("session id (default: most recent in this repo)"),
      fork: z.boolean().optional().describe("resume as a forked session on the peer"),
      deliver: z.boolean().optional().describe("write the transcript onto the peer (else dry-run)"),
    },
  },
  async (args) => {
    const config = loadConfig();
    const peer = getPeer(config, args.to);
    const plan = prepareHandoff(config, peer, { sessionId: args.session, fork: args.fork });
    if (args.deliver) await deliverHandoff(peer, plan);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              sessionId: plan.sessionId,
              peerDestPath: plan.peerDestPath,
              resumeCommand: plan.resumeCommand,
              delivered: args.deliver ?? false,
            },
            null,
            2,
          ),
        },
      ],
    };
  },
);

server.registerTool(
  "relay_doctor",
  {
    description: "Check reachability and billing safety for the local side and every configured peer.",
    inputSchema: {},
  },
  async () => {
    const report = await doctor(loadConfig());
    return { content: [{ type: "text", text: JSON.stringify(report, null, 2) }], isError: !report.ok };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
