import { test } from "node:test";
import assert from "node:assert/strict";
import {
  sanitizeEnv,
  resolveBillingOptions,
  billingFlags,
  parseCostFromResult,
  billingRouteUsed,
  localBillingRoute,
  DEFAULT_MODEL,
} from "../src/billing.js";

test("sanitizeEnv strips API-billing vars by default", () => {
  const base = { ANTHROPIC_API_KEY: "sk-x", ANTHROPIC_AUTH_TOKEN: "t", ANTHROPIC_BASE_URL: "u", PATH: "/x" };
  const { env, stripped } = sanitizeEnv(base, resolveBillingOptions({}));
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, undefined);
  assert.equal(env.ANTHROPIC_BASE_URL, undefined);
  assert.equal(env.PATH, "/x");
  assert.deepEqual(stripped.sort(), ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL"]);
});

test("sanitizeEnv keeps API key when allowApiKey is set", () => {
  const base = { ANTHROPIC_API_KEY: "sk-x" };
  const { env, stripped } = sanitizeEnv(base, resolveBillingOptions({ allowApiKey: true }));
  assert.equal(env.ANTHROPIC_API_KEY, "sk-x");
  assert.deepEqual(stripped, []);
});

test("resolveBillingOptions applies safe defaults", () => {
  const o = resolveBillingOptions({});
  assert.equal(o.model, DEFAULT_MODEL);
  assert.equal(typeof o.maxTurns, "number");
  assert.equal(o.allowApiKey, false);
});

test("billingFlags emits model, max-turns, budget", () => {
  const flags = billingFlags(resolveBillingOptions({ model: "m", maxTurns: 3, maxBudgetUsd: 0.5 }));
  assert.deepEqual(flags, ["--model", "m", "--max-turns", "3", "--max-budget-usd", "0.5"]);
});

test("parseCostFromResult reads usage; billing is not inferred from cost", () => {
  const cost = parseCostFromResult({
    total_cost_usd: 0.12,
    num_turns: 4,
    duration_ms: 5000,
    usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 50 },
  });
  assert.equal(cost.totalCostUsd, 0.12);
  assert.equal(cost.inputTokens, 1000);
  assert.equal(cost.numTurns, 4);
  // Cost can't distinguish route (subscription runs still report cost_usd).
  assert.equal(cost.billing, "unknown");
});

test("billingRouteUsed: subscription unless a key is present AND allowed", () => {
  assert.equal(billingRouteUsed(resolveBillingOptions({}), { ANTHROPIC_API_KEY: "x" }), "subscription");
  assert.equal(billingRouteUsed(resolveBillingOptions({ allowApiKey: true }), {}), "subscription");
  assert.equal(
    billingRouteUsed(resolveBillingOptions({ allowApiKey: true }), { ANTHROPIC_API_KEY: "x" }),
    "api",
  );
});

test("localBillingRoute flags an API key", () => {
  assert.equal(localBillingRoute({ ANTHROPIC_API_KEY: "x" }), "api");
  assert.equal(localBillingRoute({}), "subscription-or-unknown");
});
