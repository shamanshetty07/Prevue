import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { LIMITS } from "./spec/schema.js";
import { fileErrorReport, parseSpecText, specReport, type SpecReport } from "./spec/validate.js";

/**
 * `cli.js validate <file|->`: validate a specification file. Read-only: it never touches Prevue state,
 * needs no CLAUDE_PLUGIN_DATA, and prints one JSON document (see SKILL.md for the format).
 *
 *   exit 0  valid            exit 1  invalid (parse_error or schema_error)
 *   exit 2  file_error       exit 64 usage
 */
export const EXIT = { valid: 0, invalid: 1, file: 2, usage: 64 } as const;

type Read = { ok: true; text: string } | { ok: false; code: string; message: string };
const tooLarge: Read = { ok: false, code: "too_large", message: `input is larger than ${LIMITS.rawBytes} bytes` };

/** Reads at most LIMITS.rawBytes from a regular file (or stdin for "-"). Never reads a device, FIFO or directory. */
export function readSpecInput(path: string): Read {
  let fd: number | undefined;
  try {
    if (path === "-") fd = 0;
    else {
      // O_NONBLOCK: opening a FIFO with no writer must not hang.
      fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
      const st = fstatSync(fd);
      if (!st.isFile()) return { ok: false, code: "not_a_file", message: "the path is not a regular file" };
      if (st.size > LIMITS.rawBytes) return tooLarge;
    }
    const buf = Buffer.alloc(LIMITS.rawBytes + 1);
    let n = 0;
    while (n < buf.length) {
      let got: number;
      try {
        got = readSync(fd, buf, n, buf.length - n, null);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "EAGAIN") continue; // non-blocking stdin/pipe that is not ready yet
        if ((e as NodeJS.ErrnoException).code === "EOF") break;
        throw e;
      }
      if (got === 0) break;
      n += got;
    }
    if (n > LIMITS.rawBytes) return tooLarge;
    try {
      return { ok: true, text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buf.subarray(0, n)) };
    } catch {
      return { ok: false, code: "invalid_encoding", message: "the input is not valid UTF-8" };
    }
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return { ok: false, code: "file_not_found", message: "no such file" };
    if (code === "EISDIR") return { ok: false, code: "not_a_file", message: "the path is not a regular file" };
    return { ok: false, code: "file_unreadable", message: "the file cannot be read" };
  } finally {
    if (fd !== undefined && fd > 2) closeSync(fd);
  }
}

export function validateFile(path: string): { exit: number; report: SpecReport } {
  const read = readSpecInput(path);
  if (!read.ok) return { exit: EXIT.file, report: fileErrorReport(read.code, read.message) };
  const report = specReport(parseSpecText(read.text));
  return { exit: report.valid ? EXIT.valid : EXIT.invalid, report };
}

/** Prints the JSON report and returns the exit code (the caller sets process.exitCode so stdout is flushed). */
export function validateCommand(path: string | undefined): number {
  if (!path) {
    console.error("usage: cli validate <spec.json|->");
    return EXIT.usage;
  }
  const { exit, report } = validateFile(path);
  process.stdout.write(`${JSON.stringify(report)}\n`);
  return exit;
}
