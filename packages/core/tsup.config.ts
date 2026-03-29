import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/api/index.ts",
    cli: "src/cli/index.ts",
    "mcp/server": "src/mcp/server.ts",
    "openapi/server": "src/openapi/server.ts",
  },
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  esbuildOptions(options) {
    options.platform = "node";
  },
});
