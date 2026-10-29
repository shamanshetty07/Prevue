import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { loadCurrentDesign } from "./preview-api.js";

/**
 * Local, read-only HTTP server for the browser preview.
 *
 * Trust boundary (see docs/PREVIEW.md): it binds to 127.0.0.1 only, but being on localhost does not authenticate anyone, so
 *  - every request must carry the exact Host the server is listening on (stops DNS rebinding from another site);
 *  - a request with an Origin header must be same-origin (stops other pages in the user's browser reading the API);
 *  - /api/design additionally needs a random per-launch token, handed to the developer in the URL fragment (never sent to
 *    the server or in a Referer), which keeps unrelated web pages and unrelated local web clients out;
 *  - only GET and HEAD exist. There is no route that registers, approves, resets, writes, or reads a caller-chosen path.
 * The server does not defend against another process running as the same user, which can read the same files anyway.
 *
 * Static assets come from an exact allowlist of regular files captured at startup (no path from the request is ever joined
 * to the file system), served with a CSP that allows only same-origin scripts, styles and connections.
 */
export interface PreviewOptions {
  dataDir: string;
  projectDir: string;
  /** Directory of the built preview app, or null to serve only the API. */
  staticDir: string | null;
  port?: number;
  token?: string;
}
export interface PreviewServer {
  url: string;
  port: number;
  token: string;
  server: Server;
  close(): Promise<void>;
}

const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".json": "application/json; charset=utf-8", ".png": "image/png", ".ico": "image/x-icon", ".woff2": "font/woff2" };
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const BASE_HEADERS = { "Content-Security-Policy": CSP, "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "Cross-Origin-Resource-Policy": "same-origin", "Cache-Control": "no-store" };
const MAX_FILES = 200;
const MAX_FILE_BYTES = 5 * 1024 * 1024;

type Asset = { type: string; body: Buffer };

/** Regular files only (symlinks and special files are skipped), bounded in count, depth and size. */
function collectAssets(root: string): Map<string, Asset> {
  const out = new Map<string, Asset>();
  const walk = (dir: string, rel: string, depth: number) => {
    if (depth > 4) return;
    for (const name of readdirSync(dir).sort()) {
      if (out.size >= MAX_FILES) return;
      const full = join(dir, name);
      const st = lstatSync(full);
      const urlPath = `${rel}/${name}`;
      if (st.isDirectory()) walk(full, urlPath, depth + 1);
      else if (st.isFile() && st.size <= MAX_FILE_BYTES && TYPES[extname(name).toLowerCase()]) out.set(urlPath, { type: TYPES[extname(name).toLowerCase()]!, body: readFileSync(full) });
    }
  };
  walk(root, "", 0);
  const index = out.get("/index.html");
  if (index) out.set("/", index);
  return out;
}

function send(res: ServerResponse, status: number, headers: Record<string, string>, body: string | Buffer, head: boolean): void {
  res.writeHead(status, { ...BASE_HEADERS, ...headers, "Content-Length": String(Buffer.byteLength(body)) });
  res.end(head ? undefined : body);
}
const json = (res: ServerResponse, status: number, value: unknown, head: boolean) => send(res, status, { "Content-Type": "application/json; charset=utf-8" }, JSON.stringify(value), head);

export async function startPreviewServer(opts: PreviewOptions): Promise<PreviewServer> {
  const token = opts.token ?? randomBytes(24).toString("base64url");
  const assets = opts.staticDir ? collectAssets(opts.staticDir) : new Map<string, Asset>();
  let allowedHosts = new Set<string>();
  const tokenOk = (given: unknown): boolean => {
    if (typeof given !== "string") return false;
    const a = Buffer.from(given);
    const b = Buffer.from(token);
    return a.length === b.length && timingSafeEqual(a, b);
  };

  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    const head = req.method === "HEAD";
    if (req.method !== "GET" && !head) return send(res, 405, { Allow: "GET, HEAD", "Content-Type": "text/plain; charset=utf-8" }, "method not allowed", false);
    const host = String(req.headers.host ?? "").toLowerCase();
    if (!allowedHosts.has(host)) return send(res, 421, { "Content-Type": "text/plain; charset=utf-8" }, "unexpected host", head);
    const origin = req.headers.origin;
    if (origin !== undefined && !allowedHosts.has(String(origin).toLowerCase().replace(/^http:\/\//, ""))) return send(res, 403, { "Content-Type": "text/plain; charset=utf-8" }, "cross-origin request refused", head);
    let pathname: string;
    try {
      if (!req.url || !req.url.startsWith("/")) throw new Error("bad url");
      pathname = new URL(req.url, "http://localhost").pathname;
    } catch {
      return send(res, 400, { "Content-Type": "text/plain; charset=utf-8" }, "bad request", head);
    }
    if (pathname === "/api/design") {
      if (!tokenOk(req.headers["x-prevue-token"])) return json(res, 401, { ok: false, code: "unauthorized", message: "A valid preview token is required." }, head);
      const v = loadCurrentDesign(opts.dataDir, opts.projectDir);
      const status = v.ok ? 200 : v.code === "no_state" || v.code === "no_design" || v.code === "no_canonical_design" ? 404 : 409;
      return json(res, status, v, head);
    }
    const asset = assets.get(pathname); // exact match on a startup allowlist: nothing from the request reaches the file system
    if (asset) return send(res, 200, { "Content-Type": asset.type }, asset.body, head);
    return send(res, 404, { "Content-Type": "text/plain; charset=utf-8" }, "not found", head);
  };

  const server = createServer(handler);
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 0, "127.0.0.1", () => resolve());
  });
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("preview server has no address");
  allowedHosts = new Set([`127.0.0.1:${addr.port}`, `localhost:${addr.port}`]);
  return {
    url: `http://127.0.0.1:${addr.port}/`,
    port: addr.port,
    token,
    server,
    close: () => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }),
  };
}
