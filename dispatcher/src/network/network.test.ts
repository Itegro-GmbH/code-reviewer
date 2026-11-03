// SPDX-License-Identifier: LicenseRef-Proprietary

// The environment's rule for the agent's network as the Dispatcher meets it (#745, step 7): what the second wall is made of, the
// token that lets a VM ask for it, and the address that call is made to.
import { describe, expect, it } from "vitest";
import { ConfigError } from "../config.ts";
import { publicUrlOf } from "./public-url.ts";
import {
  GITHUB_HOSTS,
  HOST_ENTRY,
  NetworkRuleSchema,
  PLAIN_HOST,
  policyFor,
  type NetworkRule,
} from "./rule.ts";
import { switchToken, verifySwitchToken } from "./switch-token.ts";

const HOSTS = {
  appHost: "app.example.test",
  dispatcherHost: "dispatcher.example.test",
  modelHost: "api.anthropic.com",
};
const LIST: NetworkRule = {
  mode: "list",
  hosts: ["registry.npmjs.org", "*.pythonhosted.org"],
};
const VM = "cr-implementer-0b9f6f4e-3c1a-4d9e-8f43-2a7d5e1c9b10-abcd1234";

describe("the rule", () => {
  // #745-T26
  it("takes the three modes with the lists the contract allows", () => {
    expect(
      NetworkRuleSchema.safeParse({ mode: "off", hosts: [] }).success,
    ).toBe(true);
    expect(
      NetworkRuleSchema.safeParse({ mode: "open", hosts: [] }).success,
    ).toBe(true);
    expect(NetworkRuleSchema.safeParse(LIST).success).toBe(true);
  });

  // #745-T26
  it.each([
    { mode: "list", hosts: [] },
    { mode: "off", hosts: ["registry.npmjs.org"] },
    { mode: "open", hosts: ["registry.npmjs.org"] },
    { mode: "closed", hosts: [] },
    { mode: "list", hosts: ["10.0.0.1"] },
    { mode: "list", hosts: ["*.com"] },
    { mode: "list", hosts: ["com"] },
    { mode: "list", hosts: ["Registry.NPMJS.org"] },
    { mode: "list", hosts: ["registry.npmjs.org:443"] },
    { mode: "list", hosts: ["*.*.example.com"] },
    {
      mode: "list",
      hosts: Array.from({ length: 101 }, (_, i) => `h${String(i)}.example.com`),
    },
    { mode: "list", hosts: ["a.example.com"], extra: 1 },
  ])("refuses a rule that is not the contract's: %j", (rule) => {
    expect(NetworkRuleSchema.safeParse(rule).success).toBe(false);
  });

  // #745-T26
  it("knows a host entry from a plain host name", () => {
    expect(HOST_ENTRY.test("*.pythonhosted.org")).toBe(true);
    expect(PLAIN_HOST.test("*.pythonhosted.org")).toBe(false);
    expect(PLAIN_HOST.test("api.anthropic.com")).toBe(true);
    expect(PLAIN_HOST.test("127.0.0.1")).toBe(false);
  });
});

describe("the second wall", () => {
  // #745-T27
  it("keeps GitHub, the model provider, the App and the Dispatcher for off, and nothing more", () => {
    expect(policyFor({ mode: "off", hosts: [] }, HOSTS)).toStrictEqual({
      allow: [
        ...GITHUB_HOSTS,
        "api.anthropic.com",
        "app.example.test",
        "dispatcher.example.test",
      ],
    });
  });

  // #745-T27
  it("adds the rule's own hosts, suffixes as they are, for a list", () => {
    const policy = policyFor(LIST, HOSTS);
    expect(policy).toMatchObject({
      allow: expect.arrayContaining([
        "github.com",
        "api.anthropic.com",
        "app.example.test",
        "dispatcher.example.test",
        "registry.npmjs.org",
        "*.pythonhosted.org",
      ]),
    });
  });

  // #745-T27
  it("does not name a host twice", () => {
    const policy = policyFor(
      { mode: "list", hosts: ["github.com", "api.anthropic.com"] },
      HOSTS,
    );
    expect(policy).not.toBeNull();
    const allow =
      typeof policy === "object" && policy !== null ? policy.allow : [];
    expect(new Set(allow).size).toBe(allow.length);
  });

  // #745-T27
  it("does not narrow open", () => {
    expect(policyFor({ mode: "open", hosts: [] }, HOSTS)).toBeNull();
  });
});

describe("the switch token", () => {
  const SECRET = "s".repeat(40);

  // #745-T28
  it("is good for the app, the VM and the rule it was made for and no other", () => {
    const token = switchToken(SECRET, "factory", VM, LIST);

    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(verifySwitchToken([SECRET], "factory", VM, LIST, token)).toBe(true);
    expect(verifySwitchToken([SECRET], "other", VM, LIST, token)).toBe(false);
    expect(
      verifySwitchToken(
        [SECRET],
        "factory",
        VM.replace("abcd", "dcba"),
        LIST,
        token,
      ),
    ).toBe(false);
    expect(
      verifySwitchToken(
        [SECRET],
        "factory",
        VM,
        { mode: "list", hosts: [...LIST.hosts, "evil.example.com"] },
        token,
      ),
    ).toBe(false);
    expect(
      verifySwitchToken(
        [SECRET],
        "factory",
        VM,
        { mode: "open", hosts: [] },
        token,
      ),
    ).toBe(false);
    expect(
      verifySwitchToken(["t".repeat(40)], "factory", VM, LIST, token),
    ).toBe(false);
  });

  // #745-T28
  it("is accepted for the previous key while keys rotate, and refuses what is not a token", () => {
    const old = "o".repeat(40);
    const token = switchToken(old, "factory", VM, LIST);

    expect(verifySwitchToken([SECRET, old], "factory", VM, LIST, token)).toBe(
      true,
    );
    for (const bad of [
      "",
      "xyz",
      token.slice(1),
      token.toUpperCase(),
      `${token}0`,
    ])
      expect(verifySwitchToken([SECRET, old], "factory", VM, LIST, bad)).toBe(
        false,
      );
  });

  // #745-T28
  it("is not a signature of the wake-up call: the key is derived for this purpose", () => {
    const token = switchToken(SECRET, "factory", VM, LIST);

    expect(token).not.toBe(switchToken(`${SECRET}x`, "factory", VM, LIST));
    expect(token).not.toContain(SECRET);
  });

  // #745-T28
  it("cannot be moved between a host that is a prefix of another by the way the message is joined", () => {
    const a = switchToken(SECRET, "factory", VM, {
      mode: "list",
      hosts: ["a.b.com", "c.d.com"],
    });
    const b = switchToken(SECRET, "factory", VM, {
      mode: "list",
      hosts: ["a.b.com,c.d.com"] as string[],
    });
    expect(a).not.toBe(b);
  });
});

describe("the Dispatcher's own address", () => {
  // #745-T29
  it("is the configured one, without a trailing slash", () => {
    expect(
      publicUrlOf({
        DISPATCHER_PUBLIC_URL: "https://dispatcher.example.test/",
      }),
    ).toBe("https://dispatcher.example.test");
    expect(
      publicUrlOf({ DISPATCHER_PUBLIC_URL: "https://x.example.test/base/" }),
    ).toBe("https://x.example.test/base");
  });

  // #745-T29
  it("is the platform's production host when nothing is configured, and nothing without either", () => {
    expect(
      publicUrlOf({ VERCEL_PROJECT_PRODUCTION_URL: "Dispatcher.Example.TEST" }),
    ).toBe("https://dispatcher.example.test");
    expect(publicUrlOf({})).toBeUndefined();
    expect(
      publicUrlOf({ VERCEL_PROJECT_PRODUCTION_URL: "not a host" }),
    ).toBeUndefined();
  });

  // #745-T29
  it.each([
    "http://dispatcher.example.test",
    "dispatcher.example.test",
    "https://user:pw@dispatcher.example.test",
    "https://dispatcher.example.test/?x=1",
    "https://dispatcher.example.test/#f",
  ])("refuses an address that is not an https origin: %s", (value) => {
    expect(() => publicUrlOf({ DISPATCHER_PUBLIC_URL: value })).toThrow(
      ConfigError,
    );
  });
});
