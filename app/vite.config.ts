import { rmSync } from "node:fs";
import { defineConfig } from "vite";

export default defineConfig({
  base: "./", // relative URLs: the site works from any host or IPFS path, including the swarm's sites gateway
  build: { rollupOptions: { input: { main: "index.html", parts: "parts.html", docs: "docs.html", archive: "archive.html" } } },
  plugins: [{
    // the hosted site ships only the real deployment: local and fork test manifests stay out of dist
    name: "drop-test-manifests",
    apply: "build",
    closeBundle() {
      for (const f of ["deploy.local.json", "deploy.fork.json"]) rmSync(`dist/${f}`, { force: true });
    },
  }],
});
