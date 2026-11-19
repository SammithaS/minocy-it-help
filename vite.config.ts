import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import agents from "agents/vite";
import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    tanstackRouter({
      target: "react",
      autoCodeSplitting: true,
      routesDirectory: "./web/src/routes",
      generatedRouteTree: "./web/src/routeTree.gen.ts",
    }),
    agents(), // TC39 decorators (@callable): Vite 8 / Oxc can't compile them yet
    react(),
    tailwindcss(),
    cloudflare(),
  ],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./web/src", import.meta.url)) },
  },
});
