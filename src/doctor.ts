import type { RelayConfig } from "./types.js";
import { buildShellSpec, isWsl, localOS, quoteClaude } from "./peer.js";
import { run } from "./run.js";
import { listAllPeers } from "./resolve.js";
import { AGENT_SDK_CREDIT_NOTE, localBillingRoute } from "./billing.js";

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface DoctorReport {
  checks: DoctorCheck[];
  notes: string[];
  ok: boolean;
}

/** Run health + billing-safety checks for the local side and every peer. */
export async function doctor(config: RelayConfig): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  const notes: string[] = [AGENT_SDK_CREDIT_NOTE];

  checks.push({
    name: "local environment",
    ok: true,
    detail: `os=${localOS()}${isWsl() ? " (wsl)" : ""}, repoRoot=${config.repoRoot}`,
  });

  // Billing safety: a local API key means delegated jobs could bill metered API
  // unless stripped. We strip by default, but warn so the user is aware.
  const route = localBillingRoute();
  checks.push({
    name: "local billing route",
    ok: route !== "api",
    detail:
      route === "api"
        ? "ANTHROPIC_API_KEY/AUTH_TOKEN is set locally — claude-relay strips it from delegated jobs by default; pass --allow-api-key only if you intend metered API billing."
        : "no API-key env vars detected; delegated jobs will use the peer's subscription login.",
  });

  // Explicit config peers plus implicitly discovered docker/devcontainer peers.
  // Resolution failures (e.g. a docker peer with no matching container) surface
  // as failed checks rather than crashing the whole report.
  const { resolved, errors } = await listAllPeers(config);
  for (const e of errors) {
    checks.push({ name: `peer "${e.name}" resolution`, ok: false, detail: e.error });
  }

  for (const peer of resolved) {
    const where =
      peer.kind === "docker" ? ` (docker: ${peer.container}, repoRoot=${peer.repoRoot})` : "";
    // Reachability + claude presence on the peer, over the process boundary.
    // Probe the configured binary so a custom claudePath is honored.
    const probe = `${quoteClaude(peer)} --version`;
    try {
      const res = await run(buildShellSpec(peer, probe), {});
      const found = res.code === 0 && res.stdout.trim().length > 0;
      checks.push({
        name: `peer "${peer.name}" claude`,
        ok: found,
        detail: found
          ? `reachable${where}; claude ${res.stdout.trim().split(/\r?\n/)[0]}`
          : `reachable${where} but claude not runnable (code ${res.code}). ` +
            `${res.stderr.trim() || res.stdout.trim()} ` +
            `— install with: claude-relay handoff --to ${peer.name} --install-claude`,
      });

      // Peer billing route: detect a stray API key on the peer.
      const envProbe =
        peer.os === "windows"
          ? `cmd /c if defined ANTHROPIC_API_KEY (echo api) else if defined ANTHROPIC_AUTH_TOKEN (echo api) else (echo sub)`
          : `[ -n "$ANTHROPIC_API_KEY$ANTHROPIC_AUTH_TOKEN" ] && echo api || echo sub`;
      const er = await run(buildShellSpec(peer, envProbe), {});
      const peerApi = er.stdout.includes("api");
      checks.push({
        name: `peer "${peer.name}" billing route`,
        ok: !peerApi,
        detail: peerApi
          ? "peer has an API-key env var; ensure it is logged in via subscription or expect metered billing."
          : "no API-key env vars on peer; will use its subscription login.",
      });
    } catch (e) {
      checks.push({
        name: `peer "${peer.name}" reachability`,
        ok: false,
        detail: `could not reach peer: ${(e as Error).message}`,
      });
    }
  }

  return { checks, notes, ok: checks.every((c) => c.ok) };
}
