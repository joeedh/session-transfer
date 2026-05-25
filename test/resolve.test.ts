import { test } from "node:test";
import assert from "node:assert/strict";
import { discoverDockerPeers, resolvePeer, resolvePeerByName } from "../src/resolve.js";
import type { Runner } from "../src/resolve.js";
import type { RelayConfig } from "../src/types.js";

const LOCAL_ROOT = "C:\\dev\\foo";
const config: RelayConfig = {
  repoRoot: LOCAL_ROOT,
  peers: [{ name: "windows", kind: "windows", os: "windows", repoRoot: "C:\\dev\\foo" }],
};

// `docker ps` lines are <id>\t<names>\t<devcontainer.local_folder>. The match
// line uses a differently-cased, backslash path to prove normalized comparison.
const matchLine = "abc123\tfoo-app-1\tc:\\dev\\foo";
const otherLine = "def456\tbar-app-1\tC:\\dev\\other";

function fakeDocker(opts: { psLines?: string[]; available?: boolean; repoRoot?: string } = {}): Runner {
  const { psLines = [], available = true, repoRoot = "/workspaces/foo" } = opts;
  return async (spec) => {
    if (!available) throw new Error("docker: command not found");
    if (spec.file !== "docker") return { code: 0, stdout: "", stderr: "" };
    if (spec.args[0] === "ps") return { code: 0, stdout: psLines.join("\n") + "\n", stderr: "" };
    if (spec.args[0] === "exec") {
      const cmd = spec.args[spec.args.length - 1] ?? "";
      if (cmd.includes("rev-parse")) return { code: 0, stdout: repoRoot + "\n", stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  };
}

test("discoverDockerPeers matches by normalized devcontainer label and probes repoRoot", async () => {
  const peers = await discoverDockerPeers(LOCAL_ROOT, fakeDocker({ psLines: [otherLine, matchLine] }));
  assert.equal(peers.length, 1);
  assert.equal(peers[0]!.container, "foo-app-1");
  assert.equal(peers[0]!.kind, "docker");
  assert.equal(peers[0]!.os, "linux");
  assert.equal(peers[0]!.repoRoot, "/workspaces/foo");
});

test("discoverDockerPeers matches a repo-volume devcontainer by git remote url", async () => {
  // No local-folder label; the repo lives under /workspaces with the same origin.
  const runner: Runner = async (spec) => {
    if (spec.file === "git") return { code: 0, stdout: "https://github.com/me/foo.git\n", stderr: "" };
    if (spec.file === "docker" && spec.args[0] === "ps") {
      return { code: 0, stdout: "c1\tnice_name\t\n", stderr: "" }; // empty label
    }
    if (spec.file === "docker" && spec.args[0] === "exec") {
      const cmd = spec.args[spec.args.length - 1] ?? "";
      if (cmd.includes("/workspaces/*/")) {
        return { code: 0, stdout: "/workspaces/foo/::https://github.com/me/foo.git\n", stderr: "" };
      }
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  const peers = await discoverDockerPeers(LOCAL_ROOT, runner);
  assert.equal(peers.length, 1);
  assert.equal(peers[0]!.container, "nice_name");
  assert.equal(peers[0]!.repoRoot, "/workspaces/foo");
});

test("discoverDockerPeers returns [] when docker is unavailable (non-fatal)", async () => {
  const peers = await discoverDockerPeers(LOCAL_ROOT, fakeDocker({ available: false }));
  assert.deepEqual(peers, []);
});

test("resolvePeer probes repoRoot for a docker peer given only a container", async () => {
  const peer = await resolvePeer(
    config,
    { name: "devc", kind: "docker", container: "foo-app-1" },
    fakeDocker({ repoRoot: "/workspaces/foo" }),
  );
  assert.equal(peer.repoRoot, "/workspaces/foo");
  assert.equal(peer.os, "linux");
});

test("resolvePeerByName prefers an explicit peer over discovery", async () => {
  const peer = await resolvePeerByName(config, "windows", fakeDocker({ psLines: [matchLine] }));
  assert.equal(peer.kind, "windows");
  assert.equal(peer.repoRoot, "C:\\dev\\foo");
});

test("resolvePeerByName resolves the implicit 'docker' alias when exactly one matches", async () => {
  const peer = await resolvePeerByName(config, "docker", fakeDocker({ psLines: [matchLine] }));
  assert.equal(peer.kind, "docker");
  assert.equal(peer.container, "foo-app-1");
});

test("resolvePeerByName throws a helpful error when nothing matches", async () => {
  await assert.rejects(
    () => resolvePeerByName(config, "nope", fakeDocker({ psLines: [] })),
    /No peer named "nope"/,
  );
});
