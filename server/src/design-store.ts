import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import { LIMITS } from "./spec/schema.js";
import { parseSpecText } from "./spec/validate.js";
import { paths, type GateState } from "./state.js";

/**
 * Read-only verification of the canonical design stored for a revision (`<project dir>/designs/<hash>.json`).
 * It trusts nothing it reads: the file must be a regular file reached without following a symlink, small, valid UTF-8,
 * pass the full specification validation, and hash (after normalization) to both its own name and the state's designHash.
 * Failures return a code only; no content, path or parser message is ever returned. This module never writes.
 */
export type DesignCheck = { ok: true } | { ok: false; code: DesignFailure };
export type DesignFailure = "design_missing" | "design_untrusted" | "design_unreadable" | "design_too_large" | "design_invalid" | "design_hash_mismatch";

export const designFile = (dataDir: string, projectDir: string, hash: string): string => join(paths(dataDir, projectDir).dir, "designs", `${hash}.json`);

export const verifyStoredDesign = (dataDir: string, projectDir: string, state: GateState): DesignCheck => verifyDesignFile(dataDir, projectDir, state.designHash);

/** Verifies `designs/<hash>.json` against `hash` alone (used by the gate through the state, and by registration before it reuses a file). */
export function verifyDesignFile(dataDir: string, projectDir: string, hash: string | null): DesignCheck {
  if (typeof hash !== "string" || !/^[0-9a-f]{64}$/.test(hash)) return { ok: false, code: "design_invalid" };
  const dir = join(paths(dataDir, projectDir).dir, "designs");
  const file = join(dir, `${hash}.json`);
  let fd: number | undefined;
  try {
    try {
      if (!lstatSync(dir).isDirectory()) return { ok: false, code: "design_untrusted" }; // lstat: a symlinked directory is not a directory
      if (!lstatSync(file).isFile()) return { ok: false, code: "design_untrusted" }; // symlink, directory, device, fifo
    } catch (e) {
      return { ok: false, code: (e as NodeJS.ErrnoException).code === "ENOENT" ? "design_missing" : "design_unreadable" };
    }
    fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); // O_NOFOLLOW closes the lstat-to-open swap window
    const st = fstatSync(fd);
    if (!st.isFile()) return { ok: false, code: "design_untrusted" };
    if (st.size > LIMITS.rawBytes) return { ok: false, code: "design_too_large" };
    const buf = Buffer.alloc(st.size);
    let n = 0;
    while (n < buf.length) {
      const r = readSync(fd, buf, n, buf.length - n, n);
      if (r === 0) break;
      n += r;
    }
    if (n !== buf.length) return { ok: false, code: "design_unreadable" };
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buf);
    } catch {
      return { ok: false, code: "design_invalid" };
    }
    const r = parseSpecText(text);
    if (!r.ok) return { ok: false, code: "design_invalid" };
    return r.hash === hash ? { ok: true } : { ok: false, code: "design_hash_mismatch" };
  } catch {
    return { ok: false, code: "design_unreadable" };
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch {}
  }
}
