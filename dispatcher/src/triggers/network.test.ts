// SPDX-License-Identifier: LicenseRef-Proprietary

import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { FakeSandboxService } from "../../../fakes/sandbox/service.ts";
import type { NetworkRule } from "../network/rule.ts";
import { switchToken } from "../network/switch-token.ts";
import { recordingLogger } from "../test-support/harness.ts";
import { MAX_NETWORK_BODY_BYTES, mountNetworkRoute } from "./network.ts";

const SECRET = "s".repeat(40);
const PREVIOUS = "p".repeat(40);
const VM = "cr-implementer-0b9f6f4e-3c1a-4d9e-8f43-2a7d5e1c9b10-abcd1234";
const LIST: NetworkRule = {
  mode: "list",
  hosts: ["registry.npmjs.org", "*.pythonhosted.org"],
};
const OFF: NetworkRule = { mode: "off", hosts: [] };
const OPEN: NetworkRule = { mode: "open", hosts: [] };

function build() {
  const sandbox = new FakeSandboxService();
  sandbox.seedVm({
    name: VM,
    tags: { app: "code-reviewer", kind: "implementer" },
    createdAtMs: Date.now(),
  });
  const logger = recordingLogger();
  const app = new Hono();
  mountNetworkRoute(app, {
    apps: [
      { id: "factory", url: "https://app.example.test/" },
      { id: "reviewer", url: "https://reviews.example.test" },
    ],
    keys: [
      { kid: "k1", secret: SECRET, appId: "factory" },
      { kid: "k0", secret: PREVIOUS, appId: "factory" },
      { kid: "r1", secret: "r".repeat(40), appId: "reviewer" },
    ],
    fleet: sandbox,
    publicUrl: "https://dispatcher.example.test",
    logger,
  });
  return { app, sandbox, logger };
}

function body(rule: NetworkRule, changes: Record<string, unknown> = {}) {
  return {
    vm: VM,
    appId: "factory",
    network: rule,
    modelHost: "api.anthropic.com",
    token: switchToken(SECRET, "factory", VM, rule),
    ...changes,
  };
}

async function call(
  app: Hono,
  payload: unknown,
  headers: Record<string, string> = { "content-type": "application/json" },
) {
  return app.request("/network", {
    method: "POST",
    headers,
    body: typeof payload === "string" ? payload : JSON.stringify(payload),
  });
}

describe("POST /network", () => {
  // #745-T30
  it("narrows the VM to GitHub, the model provider, the App, itself and the list, and says so", async () => {
    const { app, sandbox, logger } = build();

    const response = await call(app, body(LIST));

    expect(response.status).toBe(200);
    expect(await response.json()).toStrictEqual({
      version: 1,
      status: "applied",
    });
    expect(sandbox.policies).toHaveLength(1);
    const [policy] = sandbox.policies;
    expect(policy?.name).toBe(VM);
    expect(policy?.policy).toStrictEqual({
      allow: [
        "github.com",
        "api.github.com",
        "api.anthropic.com",
        "app.example.test",
        "dispatcher.example.test",
        "registry.npmjs.org",
        "*.pythonhosted.org",
      ],
    });
    expect(logger.text()).toContain("network_policy_applied");
    expect(logger.text()).not.toContain(SECRET);
    expect(logger.text()).not.toContain(body(LIST).token);
  });

  // #745-T30
  it("narrows an off rule to the same names without the list", async () => {
    const { app, sandbox } = build();

    expect((await call(app, body(OFF))).status).toBe(200);

    expect(sandbox.policies[0]?.policy).toStrictEqual({
      allow: [
        "github.com",
        "api.github.com",
        "api.anthropic.com",
        "app.example.test",
        "dispatcher.example.test",
      ],
    });
  });

  // #745-T30
  it("leaves the policy of an open rule as it is and still answers applied", async () => {
    const { app, sandbox } = build();

    const response = await call(app, body(OPEN));

    expect(response.status).toBe(200);
    expect(sandbox.policies).toStrictEqual([]);
  });

  // #745-T30
  it("answers a call that is repeated the same way, because the first answer may have been cut off", async () => {
    const { app, sandbox } = build();

    expect((await call(app, body(LIST))).status).toBe(200);
    expect((await call(app, body(LIST))).status).toBe(200);

    expect(sandbox.policies).toHaveLength(2);
    expect(sandbox.policies[1]?.policy).toStrictEqual(
      sandbox.policies[0]?.policy,
    );
  });

  // #745-T31
  it("accepts a token made with the previous key while keys rotate", async () => {
    const { app } = build();
    const token = switchToken(PREVIOUS, "factory", VM, LIST);

    expect((await call(app, body(LIST, { token }))).status).toBe(200);
  });

  // #745-T31
  it.each([
    [
      "another rule than the token was made for",
      () => body(OFF, { token: switchToken(SECRET, "factory", VM, LIST) }),
    ],
    ["another VM", () => body(LIST, { vm: VM.replace("abcd", "dcba") })],
    ["another app", () => body(LIST, { appId: "reviewer" })],
    ["an app that is not served", () => body(LIST, { appId: "nobody" })],
    [
      "a token of another key",
      () =>
        body(LIST, { token: switchToken("x".repeat(40), "factory", VM, LIST) }),
    ],
    ["a token that is not one", () => body(LIST, { token: "nope" })],
  ])(
    "refuses %s, with the same answer and nothing narrowed",
    async (_what, make) => {
      const { app, sandbox } = build();

      const response = await call(app, make());

      expect([400, 401]).toContain(response.status);
      expect(sandbox.policies).toStrictEqual([]);
    },
  );

  // #745-T31
  it("gives the same words to a token that does not fit and a rule it was not made for", async () => {
    const { app } = build();
    const wrongRule = await call(
      app,
      body(OFF, { token: switchToken(SECRET, "factory", VM, LIST) }),
    );
    const wrongKey = await call(
      app,
      body(LIST, { token: switchToken("x".repeat(40), "factory", VM, LIST) }),
    );

    expect(wrongRule.status).toBe(wrongKey.status);
    expect(await wrongRule.text()).toBe(await wrongKey.text());
  });

  // #745-T31
  it.each([
    ["a host that is a wildcard", { modelHost: "*.anthropic.com" }],
    ["an address as the model host", { modelHost: "10.0.0.1" }],
    ["a model host with a port", { modelHost: "api.anthropic.com:443" }],
    [
      "a VM that is not an Implementer's",
      { vm: "cr-diff-0b9f6f4e-3c1a-4d9e-8f43-2a7d5e1c9b10-abcd1234" },
    ],
    ["a VM name with a path in it", { vm: "../etc/passwd" }],
    ["a field it does not know", { extra: 1 }],
  ])("refuses %s", async (_what, changes) => {
    const { app, sandbox } = build();

    expect((await call(app, body(LIST, changes))).status).toBe(400);
    expect(sandbox.policies).toStrictEqual([]);
  });

  // #745-T31
  it("refuses a body that is not JSON, not an object, or has the wrong content type", async () => {
    const { app } = build();

    expect((await call(app, "{nope")).status).toBe(400);
    expect((await call(app, "[]")).status).toBe(400);
    expect(
      (await call(app, body(LIST), { "content-type": "text/plain" })).status,
    ).toBe(400);
  });

  // #745-T31
  it("refuses a body that is too large before it reads it as JSON", async () => {
    const { app } = build();
    const big = JSON.stringify({ pad: "x".repeat(MAX_NETWORK_BODY_BYTES + 1) });

    expect((await call(app, big)).status).toBe(413);
  });

  // #745-T32
  it("asks the caller to come back when the platform cannot be reached, and never says why", async () => {
    const { app, sandbox, logger } = build();
    sandbox.policyError = new Error("secret platform text");

    const response = await call(app, body(LIST));

    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).not.toBeNull();
    expect(await response.text()).not.toContain("secret");
    expect(logger.text()).toContain("network_policy_failed");
    expect(logger.text()).not.toContain("secret platform text");
  });

  // #745-T32
  it("asks the caller to come back for a VM the platform no longer has", async () => {
    const { app, sandbox } = build();

    const response = await call(
      app,
      body(LIST, {
        vm: "cr-implementer-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa-abcd1234",
        token: switchToken(
          SECRET,
          "factory",
          "cr-implementer-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa-abcd1234",
          LIST,
        ),
      }),
    );

    expect(response.status).toBe(503);
    expect(sandbox.policies).toStrictEqual([]);
  });
});
