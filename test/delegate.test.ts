import { test } from "node:test";
import assert from "node:assert/strict";
import { buildBrief, extractRelayResult } from "../src/delegate.js";
import { buildShellSpec, quoteClaude, quoteArg, composeArgv } from "../src/peer.js";
import type { PeerConfig } from "../src/types.js";

const wslPeer: PeerConfig = { name: "wsl", kind: "wsl", os: "linux", distro: "Ubuntu", repoRoot: "/home/u/dev/foo" };
const winPeer: PeerConfig = {
  name: "windows",
  kind: "windows",
  os: "windows",
  repoRoot: "C:\\dev\\foo",
  claudePath: "C:\\Users\\u\\.local\\bin\\claude.exe",
};

test("buildBrief includes job id, peer root, and the result protocol", () => {
  const brief = buildBrief("abc123", winPeer, { task: "run nvidia-smi", relevantFiles: ["src/x.ts"] });
  assert.match(brief, /abc123/);
  assert.match(brief, /C:\\dev\\foo/);
  assert.match(brief, /RELAY RESULT/);
  assert.match(brief, /src\/x\.ts/);
  assert.match(brief, /run nvidia-smi/);
});

test("buildShellSpec wraps wsl peer in bash -lc with cd", () => {
  const spec = buildShellSpec(wslPeer, "git status");
  assert.equal(spec.file, "wsl.exe");
  assert.deepEqual(spec.args.slice(0, 4), ["-d", "Ubuntu", "--", "bash"]);
  assert.equal(spec.args[4], "-lc");
  assert.match(spec.args[5]!, /^cd '\/home\/u\/dev\/foo' && git status$/);
});

test("buildShellSpec uses cmd /d /s /c for windows peer", () => {
  const spec = buildShellSpec(winPeer, "where claude");
  assert.equal(spec.file, "cmd.exe");
  assert.deepEqual(spec.args.slice(0, 3), ["/d", "/s", "/c"]);
  assert.match(spec.args[3]!, /^cd \/d "C:\\dev\\foo" && where claude$/);
});

test("quoteClaude leaves space-free paths unquoted", () => {
  assert.equal(quoteClaude(winPeer), "C:\\Users\\u\\.local\\bin\\claude.exe");
  assert.equal(quoteClaude(wslPeer), "claude");
});

test("quoteArg quotes values with spaces/parens per shell", () => {
  // The allowed-tools value (spaces + parens) must survive as one token.
  const val = "Edit Write Bash(git commit:*)";
  assert.equal(quoteArg("windows", val), `"Edit Write Bash(git commit:*)"`);
  assert.equal(quoteArg("linux", val), `'Edit Write Bash(git commit:*)'`);
  // Simple tokens are left bare.
  assert.equal(quoteArg("windows", "--print"), "--print");
  assert.equal(quoteArg("linux", "--max-turns"), "--max-turns");
});

test("composeArgv quotes each token so flag values stay intact", () => {
  const cmd = composeArgv(winPeer, ["claude", "--allowedTools", "Edit Bash(git add:*)", "--print"]);
  assert.equal(cmd, `claude --allowedTools "Edit Bash(git add:*)" --print`);
});

test("extractRelayResult prefers the RELAY RESULT section", () => {
  const text = "blah blah\n### RELAY RESULT\nDid the thing.\nGPU: ok";
  assert.equal(extractRelayResult(text), "Did the thing.\nGPU: ok");
});

test("extractRelayResult falls back to full text", () => {
  assert.equal(extractRelayResult("just a summary"), "just a summary");
});
