import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/api.ts",
    cli: "src/cli.ts",
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
