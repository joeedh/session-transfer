import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";

function writeConfig(obj: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "relay-cfg-"));
  writeFileSync(join(dir, "relay.config.json"), JSON.stringify(obj));
  return dir;
}

test("loadConfig accepts a docker peer with no repoRoot (probed later)", () => {
  const dir = writeConfig({ repoRoot: "C:\\dev\\foo", peers: [{ name: "devc", kind: "docker" }] });
  const cfg = loadConfig(dir);
  assert.equal(cfg.peers[0]!.kind, "docker");
  assert.equal(cfg.peers[0]!.repoRoot, undefined);
});

test("loadConfig still rejects a wsl peer missing repoRoot", () => {
  const dir = writeConfig({ repoRoot: "C:\\dev\\foo", peers: [{ name: "w", kind: "wsl" }] });
  assert.throws(() => loadConfig(dir), /missing "repoRoot"/);
});

test("loadConfig rejects an unknown peer kind", () => {
  const dir = writeConfig({ repoRoot: "C:\\dev\\foo", peers: [{ name: "x", kind: "podman" }] });
  assert.throws(() => loadConfig(dir), /invalid kind/);
});
