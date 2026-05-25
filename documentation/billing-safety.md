# Billing safety

Headless `claude -p` draws from the user's Claude **subscription** — *unless* an API-key
env var leaks into the spawned process, which silently switches it to metered,
pay-as-you-go API billing (a documented cause of large surprise bills). Billing safety is
therefore a first-class subsystem, in `src/billing.ts`, that every spawn passes through.

## The core facts (and why they matter)

- **Cost cannot tell you the billing route.** A subscription `claude -p` run still reports
  a `total_cost_usd` in its stream-json `result` event. So `parseCostFromResult()` always
  returns `billing: "unknown"` — inferring the route from cost produced false
  `billing=api` positives. The route is decided separately, from whether a key was
  actually present and allowed.
- **The only reliable signal is the env.** `billingRouteUsed(opts, env)` returns `"api"`
  *only* when `opts.allowApiKey` is true **and** a key (`ANTHROPIC_API_KEY` /
  `ANTHROPIC_AUTH_TOKEN`) was present in the local env; otherwise `"subscription"`.
  `delegate()` sets `cost.billing = billingRouteUsed(...)`.

## The guardrails

1. **Strip routing env vars by default.** `sanitizeEnv(env, opts)` deletes
   `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`
   (`API_BILLING_ENV_VARS`) from the spawned peer environment unless `allowApiKey` is set.
   The caller's key is **never** forwarded across the transport.
2. **Cap every job.** `resolveBillingOptions` defaults to a cheaper model
   (`DEFAULT_MODEL = "claude-haiku-4-5"`) and `DEFAULT_MAX_TURNS = 12`; `maxBudgetUsd` is
   optional. `billingFlags` emits `--model` / `--max-turns` / `--max-budget-usd`. **No
   silent retries.**
3. **Each peer authenticates with its own subscription.** We do not share OAuth tokens to
   dodge a second login (a ToS/billing trap).
4. **`doctor` audits both sides.** It flags a stray API key locally
   (`localBillingRoute`) and on each peer (an env probe), and surfaces the Agent-SDK
   credit-pool note.

## The 2026-06-15 change

`AGENT_SDK_CREDIT_NOTE`, surfaced by `doctor`:

> From 2026-06-15, subscription `claude -p` / Agent SDK usage draws from a separate
> monthly Agent SDK credit pool, distinct from interactive limits. Delegated jobs consume
> that pool, not your interactive usage.

## Opting into metered API

`--allow-api-key` (CLI) / `allowApiKey: true` (MCP) keeps the env vars and lets the job
bill the API. This is the only way the tool will ever route to metered billing, and it is
off by default.
