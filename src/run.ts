import { spawn } from "node:child_process";
import type { SpawnSpec } from "./peer.js";

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  /** Written to the child's stdin, then stdin is closed. */
  stdin?: string;
  /** Environment for the child (defaults to process.env). */
  env?: NodeJS.ProcessEnv;
  /** Collect stdout as raw bytes (base64) instead of utf8 text (for binaries). */
  binaryStdout?: boolean;
  /** Called for each complete stdout line (utf8 mode only). */
  onLine?: (line: string) => void;
}

/** Spawn a SpawnSpec, optionally feeding stdin, and collect output. */
export function run(spec: SpawnSpec, opts: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(spec.file, spec.args, {
      env: opts.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      // Node's default cmd.exe arg-escaping mangles our `cd /d "..." && cmd`
      // string (it inserts carets/quotes that break the `&&`). Passing the
      // command line verbatim and relying on `/s` quote-stripping is correct.
      // Ignored on non-Windows (the WSL-interop path quotes args itself).
      windowsVerbatimArguments: /(^|\\)cmd\.exe$/i.test(spec.file),
    });

    const stdoutChunks: Buffer[] = [];
    let stderr = "";
    let lineBuf = "";

    child.stdout.on("data", (buf: Buffer) => {
      stdoutChunks.push(buf);
      if (opts.onLine && !opts.binaryStdout) {
        lineBuf += buf.toString("utf8");
        let idx: number;
        while ((idx = lineBuf.indexOf("\n")) >= 0) {
          const line = lineBuf.slice(0, idx).replace(/\r$/, "");
          lineBuf = lineBuf.slice(idx + 1);
          if (line.length) opts.onLine(line);
        }
      }
    });
    child.stderr.on("data", (buf: Buffer) => {
      stderr += buf.toString("utf8");
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (opts.onLine && !opts.binaryStdout && lineBuf.trim().length) {
        opts.onLine(lineBuf.replace(/\r$/, ""));
      }
      const all = Buffer.concat(stdoutChunks);
      resolve({
        code,
        stdout: opts.binaryStdout ? all.toString("base64") : all.toString("utf8"),
        stderr,
      });
    });

    if (opts.stdin != null) {
      child.stdin.write(opts.stdin);
    }
    child.stdin.end();
  });
}
