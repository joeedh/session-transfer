/** Shared types for claude-relay. */

export type OS = "windows" | "linux";

export type PeerKind = "wsl" | "windows" | "ssh";

/** A reachable Claude Code peer: another OS/checkout we can delegate work to. */
export interface PeerConfig {
  /** Stable name used on the CLI / MCP (`--to <name>`), e.g. "windows", "wsl", "gpubox". */
  name: string;
  kind: PeerKind;
  /** OS the peer runs. Determines path style + default claude binary. */
  os: OS;
  /** Absolute path to the repo checkout ON THE PEER (peer-native form). */
  repoRoot: string;
  /** Path to the `claude` executable on the peer. Defaults per-kind if omitted. */
  claudePath?: string;
  /** wsl: distro name (`wsl.exe -d <distro>`). Defaults to the default distro. */
  distro?: string;
  /** ssh (future): user@host or an ssh config alias. */
  sshTarget?: string;
}

export interface RelayConfig {
  /** Absolute path to the repo checkout on THIS machine. */
  repoRoot: string;
  peers: PeerConfig[];
}

/** Billing controls applied to every spawned peer claude process. */
export interface BillingOptions {
  /** Force a (typically cheaper) model for the delegated job. */
  model?: string;
  /** Cap agentic turns. */
  maxTurns: number;
  /** Hard spend ceiling per job (USD). */
  maxBudgetUsd?: number;
  /**
   * Allow the peer to run even if it would bill the pay-as-you-go API
   * (i.e. don't strip ANTHROPIC_API_KEY / refuse on API auth). Off by default.
   */
  allowApiKey: boolean;
}

/** Usage/cost extracted from the peer's stream-json `result` event. */
export interface JobCost {
  totalCostUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  numTurns?: number;
  durationMs?: number;
  /** Whether we believe this ran on subscription vs metered API. */
  billing: "subscription" | "api" | "unknown";
}

export interface DelegateResult {
  jobId: string;
  peer: string;
  /** Final assistant text / result summary from the peer agent. */
  summary: string;
  /** True if the peer claude exited cleanly with a `result` of subtype success. */
  ok: boolean;
  cost: JobCost;
  /** Git bundle the peer produced (base64), if any commits were made. */
  bundleBase64?: string;
  /** Human-readable list of commits the peer created. */
  commits: string[];
  /** Raw error text if the job failed. */
  error?: string;
}
