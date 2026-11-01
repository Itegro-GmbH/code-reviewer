// SPDX-License-Identifier: LicenseRef-Proprietary

// Pins down that a production server refuses to start without the settings a deployment needs
// besides sign in (the runner token): one readable line with the code and the variable names, exit
// code 1, and never a value in that line. The GitHub App is not required: the instance starts
// without any GITHUB_ variable. Development servers are left alone.
import { describe, expect, it, vi } from "vitest";
import {
  configuredRunnerToken,
  tokensMatch,
} from "../runner-api/token-auth.ts";
import {
  checkDeploymentConfigOnStart,
  findDeploymentConfigProblems,
} from "./startup.ts";

const validEnv = {
  NODE_ENV: "production",
  RUNNER_TOKEN: "r".repeat(40),
};

async function run(
  env: Record<string, string | undefined>,
  builtProductId?: string,
) {
  const exit = vi.fn();
  const log = vi.fn();
  const warn = vi.fn();
  await checkDeploymentConfigOnStart({
    env,
    log,
    warn,
    exit,
    builtProductId,
  });
  return { exit, log, warn };
}

describe("checking the deployment settings when the server starts", () => {
  it("lets a complete configuration start", async () => {
    const { exit, log } = await run(validEnv);

    expect(exit).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  // CR-37-T08
  it("stops the start with one line naming the missing runner token", async () => {
    const { exit, log } = await run({ ...validEnv, RUNNER_TOKEN: undefined });

    expect(exit).toHaveBeenCalledWith(1);
    expect(log).toHaveBeenCalledTimes(1);
    const line = String(log.mock.calls[0]?.[0]);
    expect(line).toContain("DEPLOY_CONFIG_INVALID");
    expect(line).toContain("RUNNER_TOKEN");
    expect(line).not.toContain("\n");
  });

  // CR-37-T08
  it("rejects a runner token that is too short to be a secret", async () => {
    const { exit, log } = await run({ ...validEnv, RUNNER_TOKEN: "short" });

    expect(exit).toHaveBeenCalledWith(1);
    const line = String(log.mock.calls[0]?.[0]);
    expect(line).toContain("RUNNER_TOKEN");
    expect(line).toContain("at least 32 characters");
  });

  // CR-37-T08
  it("judges the runner token exactly as the runner API does, white space around it included", async () => {
    const tokens = [
      "x".repeat(31),
      "x".repeat(32),
      `${"x".repeat(32)}\n`,
      `${"x".repeat(31)}\n`,
      `  ${"x".repeat(32)}  `,
      `${"x".repeat(20)} ${"x".repeat(20)}`,
      `${"x".repeat(40)}\u0007`,
      "   ",
      "",
    ];

    for (const token of tokens) {
      const usable = tokensMatch(
        configuredRunnerToken({ RUNNER_TOKEN: token }),
        token.trim(),
      );
      const problems = findDeploymentConfigProblems({
        ...validEnv,
        RUNNER_TOKEN: token,
      });

      expect(
        problems.some((problem) => problem.includes("RUNNER_TOKEN")),
        JSON.stringify(token),
      ).toBe(!usable);
    }
  });

  // CR-37-T09
  it("never prints a value of any setting", async () => {
    const { log } = await run({
      ...validEnv,
      RUNNER_TOKEN: "short-secret-token",
    });

    const line = String(log.mock.calls[0]?.[0]);
    expect(line).not.toContain("short-secret-token");
  });

  it("does not check anything outside production so that the dev server starts", async () => {
    const { exit, log } = await run({ NODE_ENV: "development" });

    expect(exit).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });
});

describe("checking the operator API token when the server starts", () => {
  // #275-T01
  it("lets a deployment without an operator token start unchanged", async () => {
    const { exit, log } = await run({
      ...validEnv,
      OPERATOR_API_TOKEN: undefined,
    });

    expect(exit).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  // #275-T02
  it("stops the start when the operator token equals RUNNER_TOKEN or APP_SECRET, naming only the variables", async () => {
    const same = await run({
      ...validEnv,
      OPERATOR_API_TOKEN: validEnv.RUNNER_TOKEN,
    });
    const secret = "m".repeat(40);
    const sameSecret = await run({
      ...validEnv,
      APP_SECRET: secret,
      OPERATOR_API_TOKEN: secret,
    });

    expect(same.exit).toHaveBeenCalledWith(1);
    expect(String(same.log.mock.calls[0]?.[0])).toContain(
      "OPERATOR_API_TOKEN must differ from RUNNER_TOKEN",
    );
    expect(sameSecret.exit).toHaveBeenCalledWith(1);
    expect(String(sameSecret.log.mock.calls[0]?.[0])).toContain(
      "OPERATOR_API_TOKEN must differ from APP_SECRET",
    );
    expect(String(same.log.mock.calls[0]?.[0])).not.toContain(
      validEnv.RUNNER_TOKEN,
    );
    expect(String(sameSecret.log.mock.calls[0]?.[0])).not.toContain(secret);
  });

  // #275-T02
  it("stops the start when the operator token equals BETTER_AUTH_SECRET and APP_SECRET is not set", async () => {
    const secret = "o".repeat(40);
    const { exit, log } = await run({
      ...validEnv,
      APP_SECRET: "",
      BETTER_AUTH_SECRET: secret,
      OPERATOR_API_TOKEN: secret,
    });

    expect(exit).toHaveBeenCalledWith(1);
    expect(String(log.mock.calls[0]?.[0])).toContain(
      "OPERATOR_API_TOKEN must differ from BETTER_AUTH_SECRET",
    );
    expect(String(log.mock.calls[0]?.[0])).not.toContain(secret);
  });

  // #275-T02
  it("lets a weak operator token start: the API stays off and a warning says why (operator-api/startup.ts)", async () => {
    const { exit } = await run({ ...validEnv, OPERATOR_API_TOKEN: "short" });

    expect(exit).not.toHaveBeenCalled();
  });
});

describe("checking the dispatch webhook settings when the server starts", () => {
  const SECRET = "dispatch-signing-secret-0123456789abcdef";
  const webhook = {
    ...validEnv,
    RUNNER_DISPATCH: "webhook",
    RUNNER_WEBHOOK_URL: "https://dispatcher.example.test/dispatch",
    RUNNER_WEBHOOK_SECRET: SECRET,
  };

  // #326-T07
  it("leaves a deployment that polls (the default) unchanged, whatever webhook variables are left over", async () => {
    for (const extra of [
      {},
      { RUNNER_DISPATCH: "poll" },
      { RUNNER_WEBHOOK_SECRET: "short", RUNNER_WEBHOOK_URL: "nonsense" },
    ]) {
      const { exit, log } = await run({ ...validEnv, ...extra });
      expect(exit).not.toHaveBeenCalled();
      expect(log).not.toHaveBeenCalled();
    }
  });

  // #326-T08
  it("lets a complete webhook setup start", async () => {
    const { exit, log } = await run(webhook);

    expect(exit).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  // #326-T08
  it("stops the start for webhook mode without a URL or a secret, naming only the variables", async () => {
    const { exit, log } = await run({
      ...validEnv,
      RUNNER_DISPATCH: "webhook",
    });

    expect(exit).toHaveBeenCalledWith(1);
    const line = String(log.mock.calls[0]?.[0]);
    expect(line).toContain("DEPLOY_CONFIG_INVALID");
    expect(line).toContain("RUNNER_WEBHOOK_URL is not set");
    expect(line).toContain("RUNNER_WEBHOOK_SECRET is not set");
  });

  // #326-T08
  it("stops the start for a short secret or a secret that is another credential, without printing any value", async () => {
    const short = await run({
      ...webhook,
      RUNNER_WEBHOOK_SECRET: "short-secret",
    });
    const reused = await run({
      ...webhook,
      RUNNER_WEBHOOK_SECRET: validEnv.RUNNER_TOKEN,
    });

    for (const { exit, log } of [short, reused]) {
      expect(exit).toHaveBeenCalledWith(1);
      const line = String(log.mock.calls[0]?.[0]);
      expect(line).not.toContain("short-secret");
      expect(line).not.toContain(validEnv.RUNNER_TOKEN);
      expect(line).not.toContain("dispatcher.example.test");
    }
    expect(String(short.log.mock.calls[0]?.[0])).toContain(
      "RUNNER_WEBHOOK_SECRET must be at least 32 characters long",
    );
    expect(String(reused.log.mock.calls[0]?.[0])).toContain(
      "RUNNER_WEBHOOK_SECRET must differ from RUNNER_TOKEN",
    );
  });

  // #731-T02
  it("stops the start when the capability set names something the product does not allow, without repeating a value", async () => {
    const { exit, log } = await run({
      ...validEnv,
      PRODUCT_CAPABILITIES: "review,hunter2-secret",
    });

    expect(exit).toHaveBeenCalledWith(1);
    const line = String(log.mock.calls[0]?.[0]);
    expect(line).toContain("DEPLOY_CONFIG_INVALID");
    expect(line).toContain("PRODUCT_CAPABILITIES");
    expect(line).not.toContain("hunter2");
  });

  // #731-T08
  it("stops the start for implementer on code-review.com", async () => {
    const { exit, log } = await run({
      ...validEnv,
      PRODUCT_CAPABILITIES: "review,implementer",
    });

    expect(exit).toHaveBeenCalledWith(1);
    expect(String(log.mock.calls[0]?.[0])).toContain("PRODUCT_CAPABILITIES");
  });

  // #731-T01
  it("lets the factory set start", async () => {
    const { exit } = await run({
      ...validEnv,
      PRODUCT_ID: "factory",
      PRODUCT_CAPABILITIES: "review,dynamic-review",
    });

    expect(exit).not.toHaveBeenCalled();
  });

  // #747-T01
  it("lets the factory start with implementer", async () => {
    const { exit, log } = await run({
      ...validEnv,
      PRODUCT_ID: "factory",
      PRODUCT_CAPABILITIES: "review,dynamic-review,implementer",
    });

    expect(exit).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  // #747-T02
  it("stops the start for implementer with the full list on code-review.com, naming the variable and the capability", async () => {
    const { exit, log } = await run({
      ...validEnv,
      PRODUCT_CAPABILITIES: "review,dynamic-review,billing,implementer",
    });

    expect(exit).toHaveBeenCalledWith(1);
    const line = String(log.mock.calls[0]?.[0]);
    expect(line).toContain("DEPLOY_CONFIG_INVALID");
    expect(line).toContain("PRODUCT_CAPABILITIES");
    expect(line).toContain('"implementer"');
    expect(line).toContain("code-review-com does not allow");
  });

  // #747-T04
  it("stops the start for implementer without dynamic-review on the factory", async () => {
    const { exit, log } = await run({
      ...validEnv,
      PRODUCT_ID: "factory",
      PRODUCT_CAPABILITIES: "review,implementer",
    });

    expect(exit).toHaveBeenCalledWith(1);
    const line = String(log.mock.calls[0]?.[0]);
    expect(line).toContain("PRODUCT_CAPABILITIES");
    expect(line).toContain('"implementer" but not "dynamic-review"');
  });

  // #740-T08
  it("warns when the product of the build and PRODUCT_ID of the running server disagree", async () => {
    const { exit, log, warn } = await run(
      { ...validEnv, PRODUCT_ID: "factory" },
      "",
    );

    expect(exit).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0]?.[0]);
    expect(line).toContain("NEXT_PUBLIC_PRODUCT_ID");
    expect(line).toContain("PRODUCT_ID");
    expect(line).not.toContain("\n");
  });

  // #740-T08
  it("stays quiet when both name the same product, or both are unset, white space aside", async () => {
    for (const [productId, built] of [
      ["factory", "factory"],
      [undefined, undefined],
      [undefined, ""],
      ["", undefined],
      [" factory ", "factory"],
    ] as const) {
      const { warn } = await run({ ...validEnv, PRODUCT_ID: productId }, built);
      expect(warn).not.toHaveBeenCalled();
    }
  });
});
