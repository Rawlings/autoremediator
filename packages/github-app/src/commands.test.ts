import { describe, expect, it } from "vitest";

import { parseComment } from "./commands.js";

describe("parseComment", () => {
  it("parses plan and fix with advisory ids", () => {
    expect(parseComment("/autoremediator plan cve-2021-23337")).toEqual({
      name: "plan",
      advisoryIds: ["CVE-2021-23337"],
      ignored: [],
    });
    expect(parseComment("/autoremediator fix CVE-2021-23337, GHSA-35jh-r3h4-6jhm CVE-2021-23337")).toEqual({
      name: "fix",
      advisoryIds: ["CVE-2021-23337", "GHSA-35JH-R3H4-6JHM"],
      ignored: [],
    });
  });

  it("finds the command on any line of a longer comment", () => {
    expect(parseComment("Thanks!\n\n  /autoremediator fix CVE-2024-0001\n\nbye")?.name).toBe("fix");
  });

  it("treats an unknown word as help and never acts on it", () => {
    const parsed = parseComment("/autoremediator rm -rf CVE-2024-0001");
    expect(parsed?.name).toBe("help");
    expect(parsed?.advisoryIds).toEqual(["CVE-2024-0001"]);
    expect(parsed?.ignored).toEqual(["rm", "-rf"]);
  });

  it("rejects ids that do not match exactly", () => {
    const parsed = parseComment("/autoremediator fix CVE-2024-0001;curl CVE-24-1 ../x");
    expect(parsed?.advisoryIds).toEqual([]);
    expect(parsed?.ignored.length).toBe(3);
  });

  it("caps the number of ids", () => {
    const ids = Array.from({ length: 30 }, (_, i) => `CVE-2024-${1000 + i}`).join(" ");
    expect(parseComment(`/autoremediator fix ${ids}`)?.advisoryIds).toHaveLength(10);
  });

  it("ignores quoted text and code blocks", () => {
    expect(parseComment("> /autoremediator fix CVE-2024-0001")).toBeUndefined();
    expect(parseComment("```\n/autoremediator fix CVE-2024-0001\n```")).toBeUndefined();
    expect(parseComment("try `/autoremediator fix CVE-2024-0001` to start")).toBeUndefined();
  });

  it("does not match the command in the middle of a line", () => {
    expect(parseComment("please run /autoremediator fix CVE-2024-0001")).toBeUndefined();
    expect(parseComment("/autoremediatorfix CVE-2024-0001")).toBeUndefined();
  });

  it("a bare command is help", () => {
    expect(parseComment("/autoremediator")?.name).toBe("help");
  });
});
