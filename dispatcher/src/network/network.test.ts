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
import {
  switchToken,
  verifySwitchToken,
  type SwitchTokenSubject,
} from "./switch-token.ts";

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
  const NOW = 1_800_000_000;
  const SUBJECT: SwitchTokenSubject = {
    appId: "factory",
    vm: VM,
    rule: LIST,
    modelHost: "api.anthropic.com",
    expires: NOW + 3600,
  };
  const verify = (
    subject: SwitchTokenSubject,
    token: string,
    secrets: readonly string[] = [SECRET],
    now = NOW,
  ) => verifySwitchToken(secrets, subject, token, now);

  // #745-T28
  it("is good for the app, the VM, the rule, the model host and the expiry it was made for and no other", () => {
    const token = switchToken(SECRET, SUBJECT);

    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(verify(SUBJECT, token)).toBe(true);
    for (const other of [
      { ...SUBJECT, appId: "other" },
      { ...SUBJECT, vm: VM.replace("abcd", "dcba") },
      {
        ...SUBJECT,
        rule: { mode: "list", hosts: [...LIST.hosts, "evil.example.com"] },
      },
      { ...SUBJECT, rule: { mode: "open", hosts: [] } },
      // The review of #830: the provider's host is signed, so the Worker cannot name another one.
      { ...SUBJECT, modelHost: "evil.example.com" },
      { ...SUBJECT, modelHost: "api.anthropic.com.evil.example.com" },
      // ... and so is the expiry, so a token cannot be given a longer life.
      { ...SUBJECT, expires: SUBJECT.expires + 1 },
    ] satisfies SwitchTokenSubject[])
      expect(verify(other, token)).toBe(false);
    expect(verify(SUBJECT, token, ["t".repeat(40)])).toBe(false);
  });

  // The review of #830: a token for a VM that is gone is no token.
  it("is refused after its expiry and accepted up to it", () => {
    const token = switchToken(SECRET, SUBJECT);

    expect(verify(SUBJECT, token, [SECRET], SUBJECT.expires)).toBe(true);
    expect(verify(SUBJECT, token, [SECRET], SUBJECT.expires + 1)).toBe(false);
  });

  // #745-T28
  it("is accepted for the previous key while keys rotate, and refuses what is not a token", () => {
    const old = "o".repeat(40);
    const token = switchToken(old, SUBJECT);

    expect(verify(SUBJECT, token, [SECRET, old])).toBe(true);
    for (const bad of [
      "",
      "xyz",
      token.slice(1),
      token.toUpperCase(),
      `${token}0`,
    ])
      expect(verify(SUBJECT, bad, [SECRET, old])).toBe(false);
  });

  // #745-T28
  it("is not a signature of the wake-up call: the key is derived for this purpose", () => {
    const token = switchToken(SECRET, SUBJECT);

    expect(token).not.toBe(switchToken(`${SECRET}x`, SUBJECT));
    expect(token).not.toContain(SECRET);
  });

  // #745-T28
  it("cannot be moved between a host that is a prefix of another by the way the message is joined", () => {
    const a = switchToken(SECRET, {
      ...SUBJECT,
      rule: { mode: "list", hosts: ["a.b.com", "c.d.com"] },
    });
    const b = switchToken(SECRET, {
      ...SUBJECT,
      rule: { mode: "list", hosts: ["a.b.com,c.d.com"] },
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
      publicUrlOf({ DISPATCHER_PUBLIC_URL: "https://dispatcher.example.test" }),
    ).toBe("https://dispatcher.example.test");
  });

  // The review of #830: the route is mounted at the root, so a path would send every call of every turn to nothing.
  it.each([
    "https://x.example.test/base",
    "https://x.example.test/base/",
    "https://x.example.test//",
    "https://x.example.test/a/b",
  ])(
    "refuses a configured address with a path, at start-up and clearly: %s",
    (value) => {
      const refusal = (() => {
        try {
          publicUrlOf({ DISPATCHER_PUBLIC_URL: value });
        } catch (error) {
          return error;
        }
        return undefined;
      })();
      expect(refusal).toBeInstanceOf(ConfigError);
      expect((refusal as ConfigError).variable).toBe("DISPATCHER_PUBLIC_URL");
      expect((refusal as ConfigError).message).toContain("without a path");
    },
  );

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
