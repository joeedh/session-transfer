import type { BillingOptions, JobCost } from "./types.js";

/**
 * Environment variables that redirect Claude Code to metered, pay-as-you-go
 * API billing instead of the user's subscription. If any of these leak into a
 * spawned `claude -p`, the job silently bills the Anthropic Console balance
 * (the documented cause of surprise four-figure charges). We strip them by
 * default and only keep them when the user explicitly opts in.
 */
export const API_BILLING_ENV_VARS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
] as const;

export const DEFAULT_MODEL = "claude-haiku-4-5";
export const DEFAULT_MAX_TURNS = 12;

export function resolveBillingOptions(partial: Partial<BillingOptions>): BillingOptions {
  return {
    model: partial.model ?? DEFAULT_MODEL,
    maxTurns: partial.maxTurns ?? DEFAULT_MAX_TURNS,
    maxBudgetUsd: partial.maxBudgetUsd,
    allowApiKey: partial.allowApiKey ?? false,
  };
}

/**
 * Produce the environment for the spawned peer process. Unless the caller
 * explicitly allows API-key billing, we delete the routing vars so the peer
 * falls back to its own subscription login. We NEVER forward the caller's key
 * across the transport.
 */
export function sanitizeEnv(
  baseEnv: NodeJS.ProcessEnv,
  opts: BillingOptions,
): { env: NodeJS.ProcessEnv; stripped: string[] } {
  const env: NodeJS.ProcessEnv = { ...baseEnv };
  const stripped: string[] = [];
  if (!opts.allowApiKey) {
    for (const key of API_BILLING_ENV_VARS) {
      if (env[key] != null) {
        delete env[key];
        stripped.push(key);
      }
    }
  }
  return { env, stripped };
}

/**
 * Detect whether the *current* (local) environment would route to metered API.
 * Used by `doctor` and as a pre-flight warning. We can only directly inspect
 * the local env; for the peer we surface what we strip and rely on the peer's
 * own subscription login.
 */
export function localBillingRoute(env = process.env): "api" | "subscription-or-unknown" {
  return env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN ? "api" : "subscription-or-unknown";
}

/** Translate billing options into cost-control flags for `claude`. */
export function billingFlags(opts: BillingOptions): string[] {
  const flags: string[] = [];
  if (opts.model) flags.push("--model", opts.model);
  flags.push("--max-turns", String(opts.maxTurns));
  if (opts.maxBudgetUsd != null) flags.push("--max-budget-usd", String(opts.maxBudgetUsd));
  return flags;
}

/** Parse the `result` event of a stream-json run into a JobCost. */
export function parseCostFromResult(result: Record<string, unknown>): JobCost {
  const usage = (result.usage ?? {}) as Record<string, number>;
  const cost = (result.total_cost_usd ?? result.cost_usd) as number | undefined;
  return {
    totalCostUsd: typeof cost === "number" ? cost : undefined,
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheReadTokens: usage.cache_read_input_tokens,
    numTurns: typeof result.num_turns === "number" ? (result.num_turns as number) : undefined,
    durationMs: typeof result.duration_ms === "number" ? (result.duration_ms as number) : undefined,
    // The result reports a token cost regardless of billing route (subscription
    // runs still surface an equivalent cost_usd), so it cannot tell us the route.
    // The caller sets `billing` from whether an API key was actually used.
    billing: "unknown",
  };
}

/**
 * Determine the billing route a delegated job actually used: we only reach
 * metered API when the user opted in AND a key was present in the local env.
 * Otherwise the peer falls back to its subscription login.
 */
export function billingRouteUsed(opts: BillingOptions, baseEnv = process.env): "subscription" | "api" {
  const hadKey = !!(baseEnv.ANTHROPIC_API_KEY || baseEnv.ANTHROPIC_AUTH_TOKEN);
  return opts.allowApiKey && hadKey ? "api" : "subscription";
}

/** Note about the upcoming Agent-SDK credit pool change, surfaced by doctor. */
export const AGENT_SDK_CREDIT_NOTE =
  "From 2026-06-15, subscription `claude -p` / Agent SDK usage draws from a separate " +
  "monthly Agent SDK credit pool, distinct from interactive limits. Delegated jobs will " +
  "consume that pool, not your interactive usage.";
