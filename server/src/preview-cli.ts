import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { startPreviewServer } from "./preview-server.js";

/**
 * `cli.js preview [projectDir] [--port N]` (developer command, needs an absolute CLAUDE_PLUGIN_DATA like the other state commands).
 * Starts the read-only preview server on 127.0.0.1 and prints a URL whose fragment carries the per-launch token.
 * Exit codes: 0 stopped by signal, 2 the preview app is not built, 64 usage.
 */
export async function previewCommand(dataDir: string, args: string[]): Promise<number> {
  let project: string | undefined;
  let port = 0;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--port") {
      const n = Number(args[++i]);
      if (!Number.isInteger(n) || n < 0 || n > 65535) {
        console.error("usage: cli preview [projectDir] [--port 0-65535]");
        return 64;
      }
      port = n;
    } else if (!args[i]!.startsWith("--") && project === undefined) project = args[i];
    else {
      console.error("usage: cli preview [projectDir] [--port 0-65535]");
      return 64;
    }
  }
  const staticDir = join(import.meta.dirname, "..", "..", "..", "preview", "dist");
  if (!existsSync(join(staticDir, "index.html"))) {
    console.error("The preview app is not built. Run `npm run build` in the preview directory first.");
    return 2;
  }
  const p = await startPreviewServer({ dataDir, projectDir: resolve(project ?? process.cwd()), staticDir, port });
  console.log(`Prevue preview (read-only, local only): ${p.url}#token=${p.token}`);
  console.log("It shows the current registered design. It cannot register or approve anything. Press Ctrl+C to stop.");
  await new Promise<void>((done) => {
    for (const sig of ["SIGINT", "SIGTERM"] as const) process.once(sig, () => void p.close().then(done));
  });
  return 0;
}
