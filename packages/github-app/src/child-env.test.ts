import { describe, expect, it } from "vitest";

import { childEnvironment, gitAuthEnvironment } from "./child-env.js";

describe("childEnvironment", () => {
  it("drops the app's credentials and injection variables, keeps the rest", () => {
    const env = childEnvironment(
      {},
      {
        PATH: "/usr/bin",
        HOME: "/home/app",
        AUTOREMEDIATOR_GITHUB_APP_PRIVATE_KEY: "pem",
        AUTOREMEDIATOR_GITHUB_APP_WEBHOOK_SECRET: "whsec",
        GITHUB_TOKEN: "ghs_x",
        ANTHROPIC_API_KEY: "sk-ant",
        NODE_OPTIONS: "--require /evil.js",
        NPM_TOKEN: "npm_x",
      },
    );
    expect(Object.keys(env).toSorted()).toEqual(["HOME", "NPM_TOKEN", "PATH"]);
  });

  it("adds the extra variables last", () => {
    expect(childEnvironment({ A: "1" }, { A: "0", B: "2" })).toEqual({ A: "1", B: "2" });
  });
});

describe("gitAuthEnvironment", () => {
  it("passes the token as an extra header for github.com only, never in an argument", () => {
    const env = gitAuthEnvironment("ghs_secret");
    expect(env["GIT_CONFIG_KEY_0"]).toBe("http.https://github.com/.extraheader");
    expect(env["GIT_CONFIG_VALUE_0"]).toBe(
      `AUTHORIZATION: basic ${Buffer.from("x-access-token:ghs_secret").toString("base64")}`,
    );
  });
});
