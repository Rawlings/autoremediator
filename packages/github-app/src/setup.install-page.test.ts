import { describe, expect, it } from "vitest";

import { renderInstallPage } from "./setup.js";

describe("renderInstallPage", () => {
  it("shows a numeric installation id", () => {
    expect(renderInstallPage("12345")).toContain("Installation 12345 active");
  });

  it("never reflects a non-numeric installation id", () => {
    const payload = `"><script>alert(1)</script>`;
    const html = renderInstallPage(payload);
    expect(html).not.toContain("<script>alert(1)");
    expect(html).not.toContain("alert(1)");
    expect(html).toContain("App installed.");
  });
});
