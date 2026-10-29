import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Production: `npm run build` writes dist/, which `prevue preview` serves. Development: `PREVUE_PREVIEW_URL=<printed url>
// npm run dev` proxies /api to a running `prevue preview` (it still requires that launch's token, in the page URL fragment).
export default defineConfig({
  plugins: [react()],
  build: { outDir: "dist", sourcemap: false, assetsInlineLimit: 0 },
  server: {
    host: "127.0.0.1",
    proxy: process.env.PREVUE_PREVIEW_URL ? { "/api": { target: process.env.PREVUE_PREVIEW_URL, changeOrigin: true } } : undefined,
  },
});
