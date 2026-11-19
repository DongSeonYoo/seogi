import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";
import type { Plugin } from "vite";

/**
 * Content-Security-Policy for the packaged renderer only: the dev server needs inline scripts and
 * a websocket for HMR. The AudioWorklet loads from blob:, Pretendard is a bundled asset, chunk
 * audio plays from seogi-audio:, and the renderer itself makes no network requests.
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self' blob:",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self'",
  "img-src 'self' data:",
  "media-src 'self' seogi-audio:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

const cspInBuild: Plugin = {
  name: "seogi-csp",
  apply: "build",
  transformIndexHtml: () => [
    { tag: "meta", attrs: { "http-equiv": "Content-Security-Policy", content: CSP }, injectTo: "head-prepend" },
  ],
};

export default defineConfig({
  // electron-vite externalizes production dependencies. Only sherpa and its native addon ship loose.
  main: { build: { license: true } },
  // Sandboxed preloads cannot be ES modules.
  preload: { build: { rollupOptions: { output: { format: "cjs", entryFileNames: "[name].cjs" } } } },
  renderer: { build: { license: true }, plugins: [react(), cspInBuild] },
});
