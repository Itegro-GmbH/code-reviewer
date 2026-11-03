// SPDX-License-Identifier: LicenseRef-Proprietary

// The rule for the agent's network (#745, step 7): how a typed host is brought to its stored form, and which bodies are a rule. The
// runner (`runner/tests/unit/test_network_rule.py`) holds the same cases for the same form.
import { describe, expect, it } from "vitest";
import {
  NETWORK_HOSTS_MAX,
  checkNetwork,
  hostsToText,
  normalizeHostEntry,
  ruleOf,
} from "./network.ts";

describe("a host entry", () => {
  // #745-T38
  it.each([
    ["registry.npmjs.org", "registry.npmjs.org"],
    ["Registry.NPMJS.org", "registry.npmjs.org"],
    ["  registry.npmjs.org  ", "registry.npmjs.org"],
    ["a.example.com\r\n", "a.example.com"],
    ["registry.npmjs.org.", "registry.npmjs.org"],
    ["*.pythonhosted.org", "*.pythonhosted.org"],
    ["*.PythonHosted.ORG.", "*.pythonhosted.org"],
    ["bücher.example", "xn--bcher-kva.example"],
    ["*.München.de", "*.xn--mnchen-3ya.de"],
    ["xn--bcher-kva.example", "xn--bcher-kva.example"],
    ["a-b.c1.example", "a-b.c1.example"],
    ["1password.com", "1password.com"],
  ])("%j is stored as %j", (typed, stored) => {
    expect(normalizeHostEntry(typed)).toBe(stored);
  });

  // #745-T38
  it.each([
    "",
    "   ",
    "com",
    "localhost",
    "*.com",
    "*",
    "*.",
    "*.*.example.com",
    "a.*.example.com",
    "*example.com",
    "10.0.0.1",
    "127.0.0.1",
    "8.8.8.8",
    "127.1",
    "0x7f.1",
    "2130706433",
    "[::1]",
    "::1",
    "fe80::1%eth0",
    "registry.npmjs.org:443",
    "registry.npmjs.org/path",
    "https://registry.npmjs.org",
    "user@registry.npmjs.org",
    "a b.example.com",
    "a_b.example.com",
    "-a.example.com",
    "a-.example.com",
    "a..example.com",
    "foo.1",
    `${"a".repeat(64)}.example.com`,
    `${"a.".repeat(130)}com`,
    "a.example.com\u0000",
    "a\tb.example.com",
  ])("%j is not a host entry", (typed) => {
    expect(normalizeHostEntry(typed)).toBeNull();
  });
});

describe("the rule of a body", () => {
  const LIST = {
    mode: "list",
    hosts: ["registry.npmjs.org", "*.pythonhosted.org"],
  };

  // #745-T39
  it("is off when the body names none", () => {
    expect(checkNetwork(undefined)).toEqual({
      ok: true,
      rule: { mode: "off", hosts: [] },
    });
  });

  // #745-T39
  it("takes each mode, brings the hosts to their form, drops blank lines and repeats, keeps the order", () => {
    expect(checkNetwork({ mode: "open", hosts: [] })).toEqual({
      ok: true,
      rule: { mode: "open", hosts: [] },
    });
    expect(checkNetwork({ mode: "off" })).toEqual({
      ok: true,
      rule: { mode: "off", hosts: [] },
    });
    expect(
      checkNetwork({
        mode: "list",
        hosts: [
          "Registry.npmjs.org",
          "",
          "  ",
          "registry.npmjs.org.",
          "*.PythonHosted.org",
          "bücher.example",
        ],
      }),
    ).toEqual({
      ok: true,
      rule: {
        mode: "list",
        hosts: [
          "registry.npmjs.org",
          "*.pythonhosted.org",
          "xn--bcher-kva.example",
        ],
      },
    });
  });

  // #745-T39
  it.each([
    ["null", null, "network", "invalid"],
    ["a list", [], "network", "invalid"],
    ["a string", "open", "network", "invalid"],
    ["no mode", { hosts: [] }, "network", "invalid"],
    ["another mode", { mode: "closed", hosts: [] }, "network", "invalid"],
    [
      "hosts that are not a list",
      { mode: "list", hosts: "a.example.com" },
      "networkHosts",
      "invalid",
    ],
    [
      "a host that is a number",
      { mode: "list", hosts: [1] },
      "networkHosts",
      "invalid",
    ],
    [
      "an address",
      { mode: "list", hosts: ["10.0.0.1"] },
      "networkHosts",
      "invalid",
    ],
    [
      "a suffix of one label",
      { mode: "list", hosts: ["*.com"] },
      "networkHosts",
      "invalid",
    ],
    [
      "a list with no host",
      { mode: "list", hosts: [] },
      "networkHosts",
      "required",
    ],
    [
      "a list of blank lines",
      { mode: "list", hosts: ["", " "] },
      "networkHosts",
      "required",
    ],
    [
      "hosts next to off",
      { mode: "off", hosts: ["a.example.com"] },
      "networkHosts",
      "invalid",
    ],
    [
      "hosts next to open",
      { mode: "open", hosts: ["a.example.com"] },
      "networkHosts",
      "invalid",
    ],
    [
      "more hosts than a list may have",
      {
        mode: "list",
        hosts: Array.from(
          { length: NETWORK_HOSTS_MAX + 1 },
          (_, i) => `h${String(i)}.example.com`,
        ),
      },
      "networkHosts",
      "too_long",
    ],
    [
      "a paste far over any list",
      {
        mode: "list",
        hosts: Array.from({ length: 1001 }, () => "a.example.com"),
      },
      "networkHosts",
      "too_long",
    ],
  ])("refuses %s", (_what, body, field, code) => {
    expect(checkNetwork(body)).toEqual({ ok: false, field, code });
  });

  // #745-T39
  it("accepts the longest list", () => {
    const hosts = Array.from(
      { length: NETWORK_HOSTS_MAX },
      (_, i) => `h${String(i)}.example.com`,
    );
    expect(checkNetwork({ mode: "list", hosts })).toEqual({
      ok: true,
      rule: { mode: "list", hosts },
    });
    expect(checkNetwork(LIST).ok).toBe(true);
  });
});

describe("the stored rule", () => {
  // #745-T40
  it("is written one host on each line and read back", () => {
    const hosts = ["registry.npmjs.org", "*.pythonhosted.org"];
    expect(hostsToText(hosts)).toBe("registry.npmjs.org\n*.pythonhosted.org");
    expect(ruleOf("list", hostsToText(hosts))).toEqual({ mode: "list", hosts });
    expect(ruleOf("open", "")).toEqual({ mode: "open", hosts: [] });
    expect(ruleOf("off", "")).toEqual({ mode: "off", hosts: [] });
  });

  // #745-T40
  it("reads off for what it does not know: no mode, an unknown mode, a list without hosts", () => {
    expect(ruleOf(null, null)).toEqual({ mode: "off", hosts: [] });
    expect(ruleOf("everything", "")).toEqual({ mode: "off", hosts: [] });
    expect(ruleOf("list", "")).toEqual({ mode: "off", hosts: [] });
    expect(ruleOf("list", null)).toEqual({ mode: "off", hosts: [] });
  });
});
