// SPDX-License-Identifier: LicenseRef-Proprietary

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  decide,
  isPrivateAddress,
  parsePolicy,
  targetOf,
  type NetworkPolicy,
} from "./policy.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
type Examples = {
  allowLists: { name: string; allow: string[] | null }[];
  verdicts: { list: string; host: string; port: number; allowed: boolean }[];
};
const EXAMPLES = JSON.parse(
  readFileSync(join(ROOT, "contracts", "network-rule-examples.json"), "utf8"),
) as Examples;

describe("the shared verdicts of contracts/network-rule-examples.json", () => {
  // #1159-T01
  it.each(
    EXAMPLES.verdicts.map(
      (v, i) => [`${v.list}: ${v.host}:${v.port}`, v, i] as const,
    ),
  )("%s", (_name, v) => {
    const entry = EXAMPLES.allowLists.find((each) => each.name === v.list);
    expect(entry?.allow).toBeTruthy();
    const policy: NetworkPolicy = { allow: entry?.allow ?? [] };
    expect(decide(policy, { host: v.host, port: v.port }).allowed).toBe(
      v.allowed,
    );
  });
});

describe("decide", () => {
  const list: NetworkPolicy = { allow: ["github.com", "*.pythonhosted.org"] };

  // #1159-T02
  it("allow-all lets a public name through on any port and deny-all nothing", () => {
    expect(
      decide("allow-all", { host: "example.com", port: 443 }).allowed,
    ).toBe(true);
    expect(
      decide("allow-all", { host: "example.com", port: 8443 }).allowed,
    ).toBe(true);
    expect(decide("deny-all", { host: "example.com", port: 443 })).toEqual({
      allowed: false,
      reason: "policy",
    });
  });

  // #1159-T02
  it("refuses private, loopback, link-local and metadata addresses and local names under every policy", () => {
    for (const host of [
      "10.0.0.2",
      "169.254.169.254",
      "192.168.1.1",
      "100.64.0.1",
      "127.0.0.1",
      "172.16.0.9",
      "0.0.0.0",
      "224.0.0.1",
      "localhost",
      "db.internal",
      "printer.local",
      "::1",
      "[fd00::119:1]",
    ]) {
      expect(decide("allow-all", { host, port: 80 }), host).toEqual({
        allowed: false,
        reason: "private",
      });
    }
  });

  // #1159-T02
  it("treats odd spellings of an address as the address they are", () => {
    for (const host of ["0x7f.1", "2130706433", "017700000001", "127.1"]) {
      expect(decide("allow-all", { host, port: 80 }).allowed, host).toBe(false);
    }
    expect(
      decide("allow-all", { host: "93.184.216.34", port: 80 }).allowed,
    ).toBe(true);
  });

  // #1159-T02
  it("refuses the reserved .door names, also when the list names them", () => {
    expect(decide("allow-all", { host: "model.door", port: 443 })).toEqual({
      allowed: false,
      reason: "reserved",
    });
    expect(
      decide({ allow: ["github.com"] }, { host: "app.door", port: 80 }).allowed,
    ).toBe(false);
  });

  // #1159-T02
  it("compares names in lower case without a trailing dot, and a suffix only strictly below", () => {
    expect(decide(list, { host: "GitHub.com.", port: 443 }).allowed).toBe(true);
    expect(decide(list, { host: "pythonhosted.org", port: 443 }).allowed).toBe(
      false,
    );
    expect(
      decide(list, { host: "files.pythonhosted.org", port: 443 }).allowed,
    ).toBe(true);
    expect(decide(list, { host: "github.com", port: 22 })).toEqual({
      allowed: false,
      reason: "port",
    });
  });
});

describe("parsePolicy", () => {
  // #1159-T03
  it("accepts the three forms and refuses everything else", () => {
    expect(parsePolicy("allow-all")).toBe("allow-all");
    expect(parsePolicy("deny-all")).toBe("deny-all");
    expect(
      parsePolicy({ allow: ["github.com", "github.com", "*.npmjs.org"] }),
    ).toEqual({ allow: ["github.com", "*.npmjs.org"] });
    for (const bad of [
      undefined,
      null,
      "open",
      1,
      [],
      {},
      { allow: "github.com" },
      { allow: ["10.0.0.1"] },
      { allow: ["Github.com"] },
      { allow: ["*"] },
      { allow: ["*.com"] },
      { allow: ["a b.example"] },
      { allow: Array.from({ length: 201 }, (_, i) => `h${i}.example.com`) },
    ]) {
      expect(parsePolicy(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe("helpers", () => {
  // #1159-T02
  it("reads the port of a URL with the default of its protocol", () => {
    expect(targetOf(new URL("https://example.com/x"))).toEqual({
      host: "example.com",
      port: 443,
    });
    expect(targetOf(new URL("http://example.com/x"))).toEqual({
      host: "example.com",
      port: 80,
    });
    expect(targetOf(new URL("http://example.com:8080/x"))).toEqual({
      host: "example.com",
      port: 8080,
    });
    expect(isPrivateAddress("8.8.8.8")).toBe(false);
  });
});
