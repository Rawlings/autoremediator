import { describe, expect, it } from "vitest";

import { assertTarballUrlAllowed } from "./registry.js";

describe("assertTarballUrlAllowed", () => {
  it("accepts https and http to localhost", () => {
    expect(() => assertTarballUrlAllowed("https://registry.npmjs.org/a/-/a-1.0.0.tgz")).not.toThrow();
    expect(() => assertTarballUrlAllowed("http://127.0.0.1:4873/a.tgz")).not.toThrow();
    expect(() => assertTarballUrlAllowed("http://localhost/a.tgz")).not.toThrow();
  });

  it("refuses other schemes, plain http to a remote host, and non-URLs", () => {
    for (const url of ["http://evil.example/a.tgz", "file:///etc/passwd", "ftp://x/a.tgz", "gopher://x", "not a url"]) {
      expect(() => assertTarballUrlAllowed(url)).toThrow();
    }
  });
});
