import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import { loadCurrentDesign } from "../src/preview-api.js";
import { startPreviewServer, type PreviewServer } from "../src/preview-server.js";
import { registerCanonical } from "../src/register.js";
import { approve, canonicalJson, hashDesign, paths, registerDesign } from "../src/state.js";
import { parseSpecText } from "../src/spec/validate.js";
import { sandbox, tmp, type Sandbox } from "./helpers.js";

const repoRoot = process.env.PREVUE_REPO_ROOT ?? join(import.meta.dirname, "..", "..", "..");
const A = readFileSync(join(repoRoot, "docs", "examples", "expense-dashboard.json"), "utf8");
const B = JSON.stringify({ ...JSON.parse(A), screen: { ...JSON.parse(A).screen, name: "Dashboard B" } });
const HASH_A = (parseSpecText(A) as any).hash as string;
const E = (s: Sandbox): NodeJS.ProcessEnv => ({ CLAUDE_PLUGIN_DATA: s.data, CLAUDE_PROJECT_DIR: s.project });
const designsDir = (s: Sandbox) => join(paths(s.data, s.project).dir, "designs");
const registered = (text = A): Sandbox => {
  const s = sandbox();
  assert.equal((registerCanonical(E(s), text) as any).ok, true);
  return s;
};

function snapshot(dir: string): string {
  if (!existsSync(dir)) return "(absent)";
  const out: string[] = [];
  const walk = (d: string) => {
    for (const n of readdirSync(d).sort()) {
      const p = join(d, n);
      const st = lstatSync(p, { bigint: true });
      out.push(st.isDirectory() ? `${p}|dir` : `${p}|${readFileSync(p).toString("base64")}|${st.mtimeNs}`);
      if (st.isDirectory()) walk(p);
    }
  };
  walk(dir);
  return out.join("\n");
}

// ---- the loader -----------------------------------------------------------------------------------------------------

test("preview loader: no state, no design, and a legacy registration each say so, with a fixed message", () => {
  const s = sandbox();
  assert.deepEqual(loadCurrentDesign(s.data, s.project), { ok: false, code: "no_state", message: (loadCurrentDesign(s.data, s.project) as any).message });
  registerDesign(s.data, s.project, { v: "phase 0" }); // legacy: no marker, no stored design
  const legacy = loadCurrentDesign(s.data, s.project) as any;
  assert.equal(legacy.code, "no_canonical_design");
  const t = sandbox();
  mkdirSync(paths(t.data, t.project).dir, { recursive: true });
  writeFileSync(paths(t.data, t.project).file, "{");
  assert.equal((loadCurrentDesign(t.data, t.project) as any).code, "state_invalid");
});

test("preview loader: a registered design is returned as the normalized specification with its revision and hash", () => {
  const s = registered();
  const v = loadCurrentDesign(s.data, s.project) as any;
  assert.deepEqual([v.ok, v.status, v.revision, v.hash, v.approved], [true, "PENDING", 1, HASH_A, false]);
  assert.equal(canonicalJson(v.spec), canonicalJson((parseSpecText(A) as any).spec));
  assert.equal(hashDesign(v.spec), HASH_A);
  approve(s.data, s.project, HASH_A.slice(0, 12));
  const ap = loadCurrentDesign(s.data, s.project) as any;
  assert.deepEqual([ap.status, ap.approved, ap.revision], ["APPROVED", true, 1]);
  registerCanonical(E(s), B);
  const b = loadCurrentDesign(s.data, s.project) as any;
  assert.deepEqual([b.status, b.approved, b.revision, b.spec.screen.name], ["PENDING", false, 2, "Dashboard B"]);
  assert.notEqual(b.hash, HASH_A); // the old design file is still stored, but the preview follows the state, not the directory
});

test("preview loader: it applies the gate's integrity checks and reports a code, never content or paths", () => {
  const cases: Array<[string, (s: Sandbox, file: string) => void, string]> = [
    ["missing file", (_s, f) => rmSync(f), "design_missing"],
    ["corrupt JSON", (_s, f) => writeFileSync(f, '{"schemaVersion":1,"x":"TOP-SECRET-MARKER"'), "design_invalid"],
    ["schema-invalid", (_s, f) => writeFileSync(f, JSON.stringify({ ...JSON.parse(readFileSync(f, "utf8")), extra: 1 })), "design_invalid"],
    ["a different valid design under the name", (_s, f) => writeFileSync(f, JSON.stringify((parseSpecText(B) as any).spec)), "design_hash_mismatch"],
    ["oversized", (_s, f) => writeFileSync(f, " ".repeat(70_000)), "design_too_large"],
    ["symlink", (_s, f) => { const real = join(tmp("real"), "r.json"); writeFileSync(real, readFileSync(f)); rmSync(f); symlinkSync(real, f); }, "design_untrusted"],
    ["directory", (_s, f) => { rmSync(f); mkdirSync(f); }, "design_untrusted"],
  ];
  for (const [label, damage, code] of cases) {
    const s = registered();
    damage(s, join(designsDir(s), `${HASH_A}.json`));
    const v = loadCurrentDesign(s.data, s.project) as any;
    assert.deepEqual([label, v.ok, v.code], [label, false, code]);
    const text = JSON.stringify(v);
    assert.ok(!text.includes("TOP-SECRET-MARKER") && !text.includes(s.data) && !text.includes(s.project), label);
    assert.ok(!("spec" in v), label);
  }
});

test("preview loader: it follows the state's hash only; a design file that the state does not name is never shown", () => {
  const s = registered();
  registerCanonical(E(s), B);
  rmSync(join(designsDir(s), `${(parseSpecText(B) as any).hash}.json`)); // the current design is gone; the old A file remains
  const v = loadCurrentDesign(s.data, s.project) as any;
  assert.deepEqual([v.ok, v.code], [false, "design_missing"]);
});

test("preview loader: loading never changes any file (state, designs, mtimes)", () => {
  const s = registered();
  approve(s.data, s.project, HASH_A.slice(0, 12));
  const before = snapshot(s.data);
  for (let i = 0; i < 20; i++) loadCurrentDesign(s.data, s.project);
  assert.equal(snapshot(s.data), before);
  const none = sandbox();
  loadCurrentDesign(none.data, none.project);
  assert.deepEqual(readdirSync(none.data), []); // not even a missing state is created by looking at it
});

// ---- the server's boundary ----------------------------------------------------------------------------------------------

function assets(): string {
  const root = tmp("static");
  mkdirSync(join(root, "assets"));
  writeFileSync(join(root, "index.html"), "<!doctype html><title>x</title><script type=module src=/assets/app.js></script>");
  writeFileSync(join(root, "assets", "app.js"), "console.log(1)");
  writeFileSync(join(root, "assets", "app.css"), "body{}");
  writeFileSync(join(root, "assets", "notes.txt"), "not an allowed type");
  writeFileSync(join(root, ".env"), "SECRET=1");
  const outside = join(tmp("outside"), "secret.js");
  writeFileSync(outside, "SECRET");
  symlinkSync(outside, join(root, "assets", "leak.js"));
  return root;
}

interface Res { status: number; headers: Record<string, string | string[] | undefined>; body: string }
function req(p: PreviewServer, opts: { method?: string; path?: string; headers?: Record<string, string>; body?: string; host?: string | null } = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { ...(opts.host === null ? {} : { Host: opts.host ?? `127.0.0.1:${p.port}` }), ...opts.headers };
    const r = request({ host: "127.0.0.1", port: p.port, method: opts.method ?? "GET", path: opts.path ?? "/", headers, setHost: false }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body }));
    });
    r.on("error", reject);
    r.end(opts.body);
  });
}
const withServer = async (s: Sandbox, fn: (p: PreviewServer) => Promise<void>, staticDir: string | null = assets()) => {
  const p = await startPreviewServer({ dataDir: s.data, projectDir: s.project, staticDir });
  try {
    await fn(p);
  } finally {
    await p.close();
  }
};
const tok = (p: PreviewServer) => ({ "X-Prevue-Token": p.token });

test("preview server: binds to 127.0.0.1 only and serves the allow-listed app with a strict CSP", async () => {
  await withServer(registered(), async (p) => {
    assert.equal((p.server.address() as any).address, "127.0.0.1");
    assert.match(p.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
    const idx = await req(p);
    assert.equal(idx.status, 200);
    assert.match(String(idx.headers["content-type"]), /text\/html/);
    const csp = String(idx.headers["content-security-policy"]);
    for (const d of ["default-src 'none'", "script-src 'self'", "connect-src 'self'", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'"]) assert.ok(csp.includes(d), d);
    assert.ok(!/unsafe-inline|unsafe-eval|https?:|\*/.test(csp));
    assert.equal(idx.headers["x-content-type-options"], "nosniff");
    assert.equal(idx.headers["referrer-policy"], "no-referrer");
    assert.equal(idx.headers["cache-control"], "no-store");
    assert.ok(!Object.keys(idx.headers).some((h) => h.startsWith("access-control-")), "no CORS headers: other origins cannot read responses");
    assert.equal((await req(p, { path: "/assets/app.js" })).status, 200);
    assert.match(String((await req(p, { path: "/assets/app.css" })).headers["content-type"]), /text\/css/);
    const head = await req(p, { method: "HEAD", path: "/assets/app.js" });
    assert.deepEqual([head.status, head.body], [200, ""]);
  });
});

test("preview server: nothing outside the startup allow-list is reachable (traversal, symlinks, dotfiles, other types)", async () => {
  await withServer(registered(), async (p) => {
    for (const path of ["/assets/leak.js", "/assets/notes.txt", "/.env", "/..%2f..%2fetc%2fpasswd", "/%2e%2e/%2e%2e/etc/passwd", "/assets%2f..%2f..%2f.env", "//etc/passwd", "/etc/passwd", "/assets/", "/assets", "/api/", "/api/design/x", "/api/designs", "/api/design%2f..%2f..", "/index.html%00.js", "/\\..\\etc\\passwd", "/%00"]) {
      const r = await req(p, { path, headers: tok(p) });
      assert.ok([404, 400].includes(r.status), `${path} -> ${r.status}`);
      assert.ok(!r.body.includes("SECRET") && !r.body.includes("root:"), path);
    }
    for (const path of ["relative", "*"]) assert.ok([400, 404].includes((await req(p, { path })).status), path);
  });
});

test("preview server: the API needs the exact per-launch token", async () => {
  const s = registered();
  await withServer(s, async (p) => {
    const bad: Array<Record<string, string>> = [{}, { "X-Prevue-Token": "" }, { "X-Prevue-Token": "wrong" }, { "X-Prevue-Token": p.token + "x" }, { "X-Prevue-Token": p.token.slice(1) }, { Authorization: p.token }, { Cookie: `token=${p.token}` }];
    for (const h of bad) {
      const r = await req(p, { path: "/api/design", headers: h });
      assert.equal(r.status, 401, JSON.stringify(h));
      assert.ok(!r.body.includes("spec"));
    }
    assert.equal((await req(p, { path: "/api/design?token=" + p.token })).status, 401); // a token in the query string is not accepted
    const ok = await req(p, { path: "/api/design", headers: tok(p) });
    assert.equal(ok.status, 200);
    assert.deepEqual(JSON.parse(ok.body), JSON.parse(JSON.stringify(loadCurrentDesign(s.data, s.project))));
    assert.match(String(ok.headers["content-type"]), /application\/json/);
    assert.equal(ok.headers["cache-control"], "no-store");
  });
  // tokens differ per launch
  const a = await startPreviewServer({ dataDir: s.data, projectDir: s.project, staticDir: null });
  const b = await startPreviewServer({ dataDir: s.data, projectDir: s.project, staticDir: null });
  try {
    assert.notEqual(a.token, b.token);
    assert.ok(a.token.length >= 32);
    assert.equal((await req(a, { path: "/api/design", headers: tok(b) })).status, 401);
  } finally {
    await a.close();
    await b.close();
  }
});

test("preview server: Host and Origin checks refuse DNS-rebinding and cross-origin reads", async () => {
  await withServer(registered(), async (p) => {
    const api = { path: "/api/design", headers: tok(p) };
    for (const host of ["evil.example", `evil.example:${p.port}`, `127.0.0.1:${p.port + 1}`, "127.0.0.1", "localhost", "0.0.0.0:" + p.port, "[::1]:" + p.port, ""]) {
      // 421 from the handler; Node itself answers 400 to an empty or missing Host before the handler runs. Either is a refusal.
      assert.ok([400, 421].includes((await req(p, { ...api, host })).status), host);
      assert.ok([400, 421].includes((await req(p, { host })).status), `static ${host}`);
      if (host && host !== "") assert.equal((await req(p, { ...api, host })).status, 421, host);
    }
    assert.ok([400, 421].includes((await req(p, { ...api, host: null })).status)); // no Host header at all
    assert.equal((await req(p, { ...api, host: `localhost:${p.port}` })).status, 200); // the other loopback name is allowed
    assert.equal((await req(p, { ...api, host: `LOCALHOST:${p.port}` })).status, 200);
    for (const origin of ["http://evil.example", "https://evil.example", "null", `http://127.0.0.1:${p.port + 1}`, `https://127.0.0.1:${p.port}`, "http://localhost"]) {
      assert.equal((await req(p, { path: "/api/design", headers: { ...tok(p), Origin: origin } })).status, 403, origin);
    }
    assert.equal((await req(p, { path: "/api/design", headers: { ...tok(p), Origin: `http://127.0.0.1:${p.port}` } })).status, 200);
  });
});

test("preview server: it is read-only: no method but GET/HEAD, and no route can register, approve, reset or write", async () => {
  const s = registered();
  approve(s.data, s.project, HASH_A.slice(0, 12));
  const before = snapshot(s.data);
  await withServer(s, async (p) => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS", "TRACE", "CONNECT", "PROPFIND"]) {
      for (const path of ["/", "/api/design", "/api/approve", "/api/register", "/api/reset", "/api/state"]) {
        const r: Res = await req(p, { method, path, headers: tok(p), body: JSON.stringify({ approve: HASH_A, spec: B }) }).catch(() => ({ status: 0, headers: {}, body: "" }));
        assert.ok(r.status === 405 || r.status === 0, `${method} ${path} -> ${r.status}`);
        if (r.status === 405) assert.equal(r.headers["allow"], "GET, HEAD");
      }
    }
    for (const path of ["/api/approve", "/api/register", "/api/reset", "/api/state", "/api/design/approve", "/api/files?path=/etc/passwd", "/api/design?hash=" + "0".repeat(64) + "&revision=1&path=/etc/passwd"]) {
      const r = await req(p, { path, headers: tok(p) });
      assert.ok(r.status === 404 || (path.startsWith("/api/design?") && r.status === 200), `${path} -> ${r.status}`);
      if (path.startsWith("/api/design?")) assert.equal(JSON.parse(r.body).hash, HASH_A, "query parameters cannot choose another design or revision");
    }
  });
  assert.equal(snapshot(s.data), before, "no request changed any file");
  assert.equal((await import("../src/state.js")).load(s.data, s.project).status, "APPROVED"); // and the approval is untouched
});

test("preview server: it reports the same errors as the loader, with distinct statuses, and serves no design when integrity fails", async () => {
  const none = sandbox();
  await withServer(none, async (p) => {
    const r = await req(p, { path: "/api/design", headers: tok(p) });
    assert.deepEqual([r.status, JSON.parse(r.body).code], [404, "no_state"]);
  });
  const s = registered();
  writeFileSync(join(designsDir(s), `${HASH_A}.json`), '{"leak":"TOP-SECRET-MARKER"');
  await withServer(s, async (p) => {
    const r = await req(p, { path: "/api/design", headers: tok(p) });
    assert.deepEqual([r.status, JSON.parse(r.body).code], [409, "design_invalid"]);
    assert.ok(!r.body.includes("TOP-SECRET-MARKER") && !r.body.includes(s.data) && !/"spec"\s*:/.test(r.body));
  });
  await withServer(s, async (p) => assert.equal((await req(p, { path: "/" })).status, 404), null); // API-only: no app to serve
});

test("preview server: its source cannot register, approve, reset or write (static import check)", () => {
  const src = join(import.meta.dirname, "..", "src");
  for (const f of ["preview-api.js", "preview-server.js", "preview-cli.js"]) {
    const withStrings = readFileSync(join(src, f), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
    assert.ok(!/register\.js|from\s*["']\.\/hook|gate\.js|classify\.js/.test(withStrings), `${f} imports registration, hook or gate code`);
    const text = withStrings.replace(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g, '""'); // identifiers only: user-facing messages may mention "reset"
    assert.ok(!/\b(approve|registerDesign|registerLocked|registerCanonical|initIfMissing|reset|withLock|writeAtomic)\b/.test(text), `${f} references a state-changing function`);
    assert.ok(!/\b(writeFile|writeFileSync|appendFile|appendFileSync|unlink|unlinkSync|rmSync|rename|renameSync|mkdirSync|copyFile|createWriteStream|linkSync|symlinkSync|chmod)\b/.test(text), `${f} uses a file-writing API`);
    assert.ok(!/child_process|process\.env/.test(text), `${f} spawns processes or reads the environment`);
  }
  const st = readFileSync(join(src, "preview-api.js"), "utf8");
  assert.match(st, /from "\.\/state\.js"/);
  assert.ok(/import \{ load \} from "\.\/state\.js"/.test(st), "the loader imports only `load` from the state module");
});

// ---- the CLI command ------------------------------------------------------------------------------------------------------

/** A copy of the compiled server in a temp tree, so `preview` resolves its app directory inside the temp tree. */
function isolatedCli(withApp: boolean): { cli: string; root: string } {
  const root = tmp("cli-tree");
  cpSync(join(import.meta.dirname, "..", "src"), join(root, "server", "dist", "src"), { recursive: true });
  writeFileSync(join(root, "server", "package.json"), JSON.stringify({ type: "module" }));
  symlinkSync(join(import.meta.dirname, "..", "..", "node_modules"), join(root, "server", "node_modules"));
  if (withApp) {
    mkdirSync(join(root, "preview", "dist"), { recursive: true });
    writeFileSync(join(root, "preview", "dist", "index.html"), "<!doctype html><title>t</title>");
  }
  return { cli: join(root, "server", "dist", "src", "cli.js"), root };
}
const runCli = (cli: string, args: string[], env: Record<string, string | undefined>) =>
  new Promise<{ code: number | null; out: string; err: string; child: ReturnType<typeof spawn> }>((resolve) => {
    const e: Record<string, string> = { PATH: process.env.PATH ?? "" };
    for (const [k, v] of Object.entries(env)) if (v !== undefined) e[k] = v;
    const child = spawn("node", [cli, ...args], { env: e });
    let out = "", err = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (err += c));
    child.on("close", (code) => resolve({ code, out, err, child }));
  });

test("preview command: usage and configuration errors exit before any server starts", async () => {
  const { cli } = isolatedCli(true);
  const s = sandbox();
  assert.equal((await runCli(cli, ["preview"], {})).code, 64); // no CLAUDE_PLUGIN_DATA
  assert.equal((await runCli(cli, ["preview"], { CLAUDE_PLUGIN_DATA: "relative" })).code, 64);
  for (const args of [["preview", "--port", "abc"], ["preview", "--port", "70000"], ["preview", "--port"], ["preview", "--bogus"], ["preview", s.project, "extra"]]) {
    const r = await runCli(cli, args, { CLAUDE_PLUGIN_DATA: s.data });
    assert.equal(r.code, 64, args.join(" "));
    assert.match(r.err, /usage/);
  }
  assert.deepEqual(readdirSync(s.data), []);
});

test("preview command: exits 2 with a clear message when the preview app is not built", async () => {
  const { cli } = isolatedCli(false);
  const s = sandbox();
  const r = await runCli(cli, ["preview", s.project], { CLAUDE_PLUGIN_DATA: s.data });
  assert.equal(r.code, 2);
  assert.match(r.err, /not built/);
});

test("preview command: starts on loopback, prints a URL with the token in the fragment, serves the registered design, and stops on SIGTERM", async () => {
  const { cli } = isolatedCli(true);
  const s = registered();
  const child = spawn("node", [cli, "preview", s.project, "--port", "0"], { env: { PATH: process.env.PATH ?? "", CLAUDE_PLUGIN_DATA: s.data } });
  let out = "";
  const exited = new Promise<number | null>((r) => child.on("close", r));
  const line = await new Promise<string>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("preview did not start")), 10_000);
    child.stdout.on("data", (c) => {
      out += c;
      const m = /(http:\/\/127\.0\.0\.1:\d+\/)#token=([A-Za-z0-9_-]+)/.exec(out);
      if (m) { clearTimeout(t); resolve(m[0]); }
    });
  });
  try {
    const m = /^http:\/\/127\.0\.0\.1:(\d+)\/#token=(.+)$/.exec(line)!;
    const fake = { port: Number(m[1]), token: m[2]! } as PreviewServer;
    const api = await req(fake, { path: "/api/design", headers: { "X-Prevue-Token": fake.token } });
    assert.equal(api.status, 200);
    assert.equal(JSON.parse(api.body).hash, HASH_A);
    assert.equal((await req(fake, { path: "/" })).status, 200);
    assert.match(out, /cannot register or approve/);
  } finally {
    child.kill("SIGTERM");
  }
  assert.equal(await exited, 0);
});
