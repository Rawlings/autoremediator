import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "packages/core/src/api.ts",
    cli: "packages/core/src/cli.ts",
    "mcp/server": "packages/core/src/mcp/server.ts",
    "openapi/server": "packages/core/src/openapi/server.ts",
  },
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  esbuildOptions(options) {
    options.platform = "node";
  },
});
