import { defineConfig } from "tsup";

export default defineConfig([
  // Public library — generates .d.ts for consumers
  {
    entry: { index: "src/api/index.ts" },
    format: ["esm"],
    dts: true,
    sourcemap: true,
    clean: true,
    esbuildOptions(options) {
      options.platform = "node";
    },
  },
  // Binary entry points — no .d.ts needed, shebang preserved
  {
    entry: {
      cli: "src/cli/index.ts",
      "mcp/server": "src/mcp/server.ts",
      "openapi/server": "src/openapi/server.ts",
    },
    format: ["esm"],
    dts: false,
    sourcemap: false,
    esbuildOptions(options) {
      options.platform = "node";
    },
  },
]);
