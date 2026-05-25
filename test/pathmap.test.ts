import { test } from "node:test";
import assert from "node:assert/strict";
import { translatePath, pathOS } from "../src/config.js";
import { encodeProjectDir, translateTranscriptLine } from "../src/handoff.js";

test("pathOS detects windows vs linux", () => {
  assert.equal(pathOS("C:\\dev\\foo"), "windows");
  assert.equal(pathOS("/home/u/dev/foo"), "linux");
});

test("translatePath: windows root -> linux peer", () => {
  const out = translatePath("C:\\dev\\foo\\src\\x.ts", "C:\\dev\\foo", "/home/u/dev/foo", "linux");
  assert.equal(out, "/home/u/dev/foo/src/x.ts");
});

test("translatePath: linux root -> windows peer", () => {
  const out = translatePath("/home/u/dev/foo/src/x.ts", "/home/u/dev/foo", "C:\\dev\\foo", "windows");
  assert.equal(out, "C:\\dev\\foo\\src\\x.ts");
});

test("translatePath: root itself maps to peer root", () => {
  assert.equal(translatePath("C:\\dev\\foo", "C:\\dev\\foo", "/home/u/dev/foo", "linux"), "/home/u/dev/foo");
});

test("translatePath: windows is case-insensitive on the root", () => {
  const out = translatePath("c:\\Dev\\Foo\\a.txt", "C:\\dev\\foo", "/home/u/dev/foo", "linux");
  assert.equal(out, "/home/u/dev/foo/a.txt");
});

test("translatePath: outside the root returns undefined", () => {
  assert.equal(translatePath("C:\\other\\x", "C:\\dev\\foo", "/home/u/dev/foo", "linux"), undefined);
  assert.equal(translatePath("/etc/passwd", "/home/u/dev/foo", "C:\\dev\\foo", "windows"), undefined);
});

test("encodeProjectDir matches Claude Code's folder scheme", () => {
  assert.equal(encodeProjectDir("C:\\dev\\session-transfer"), "C--dev-session-transfer");
  assert.equal(encodeProjectDir("/home/u/dev/foo"), "-home-u-dev-foo");
});

test("translateTranscriptLine rewrites cwd and nested file paths", () => {
  const line = JSON.stringify({
    type: "user",
    cwd: "C:\\dev\\foo",
    message: { tool_use: { input: { file_path: "C:\\dev\\foo\\src\\x.ts", other: "keep" } } },
    unrelated: "C:\\other\\y",
  });
  const out = JSON.parse(translateTranscriptLine(line, "C:\\dev\\foo", "/home/u/dev/foo", "linux"));
  assert.equal(out.cwd, "/home/u/dev/foo");
  assert.equal(out.message.tool_use.input.file_path, "/home/u/dev/foo/src/x.ts");
  assert.equal(out.message.tool_use.input.other, "keep");
  assert.equal(out.unrelated, "C:\\other\\y"); // outside root: untouched
});

test("translateTranscriptLine passes through non-JSON unchanged", () => {
  assert.equal(translateTranscriptLine("not json", "C:\\dev\\foo", "/home/u/dev/foo", "linux"), "not json");
});
