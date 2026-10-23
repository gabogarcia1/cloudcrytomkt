import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// catalog.json lives with the agent (app/agent/catalog.json) so the deployed
// agent ships it; the storefront imports the very same file at build time.
const catalog = fileURLToPath(new URL("../app/agent/catalog.json", import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { "@catalog": catalog } },
  server: { port: 5173, fs: { allow: [".", "../app/agent/catalog.json"] } },
});
