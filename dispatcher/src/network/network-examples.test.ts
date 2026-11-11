// SPDX-License-Identifier: LicenseRef-Proprietary

// #979: the rule language of the outer wall as the hosted rule code speaks it. The local Dispatcher's proxy (runner/.../firecracker/outer_rule.py)
// reads the same rules; both suites read contracts/network-rule-examples.json and must give its answers (the runner's is
// runner/tests/unit/test_firecracker_outer_rule.py).
import { describe, expect, it } from "vitest";
import { readContract } from "../test-support/harness.ts";
import { NetworkRuleSchema, policyFor, type NetworkRule } from "./rule.ts";

type Examples = {
  rules: { name: string; rule: unknown; valid: boolean }[];
  allowLists: {
    name: string;
    rule: NetworkRule;
    modelHost: string;
    appHost: string;
    allow: string[] | null;
  }[];
  verdicts: { list: string; host: string; port: number; allowed: boolean }[];
};

const EXAMPLES = readContract<Examples>("network-rule-examples.json");
// A local machine has no Dispatcher host in the Internet: the hosted list holds one more name than a VM's.
const DISPATCHER_HOST = "dispatcher.example.test";

/** The names the hosted second wall allows for an example, without the Dispatcher's own host; null when the rule is not narrowed. */
function hostedList(entry: Examples["allowLists"][number]): string[] | null {
  const policy = policyFor(entry.rule, {
    appHost: entry.appHost,
    dispatcherHost: DISPATCHER_HOST,
    modelHost: entry.modelHost,
  });
  if (policy === null) return null;
  if (typeof policy !== "object") throw new Error("not a list");
  return policy.allow.filter((name) => name !== DISPATCHER_HOST);
}

/** The matching rule the examples file writes down: exact, or strictly below a `*.suffix`; ports 80 and 443; an address is never a name. */
function allows(list: string[], host: string, port: number): boolean {
  if (port !== 80 && port !== 443) return false;
  if (
    /^(0x[0-9a-f]*|[0-9]+)(\.(0x[0-9a-f]*|[0-9]+)){0,3}$/i.test(host) ||
    host.includes(":") ||
    host.includes("[")
  )
    return false;
  return list.some((entry) =>
    entry.startsWith("*.")
      ? host.endsWith(entry.slice(1)) && host.length > entry.length - 1
      : host === entry,
  );
}

describe("the examples both implementations answer alike", () => {
  // #979-T03
  it.each(EXAMPLES.rules.map((each) => [each.name, each] as const))(
    "a rule document is a rule as the hosted code says: %s",
    (_name, example) => {
      expect(NetworkRuleSchema.safeParse(example.rule).success).toBe(
        example.valid,
      );
    },
  );

  // #979-T03
  it.each(EXAMPLES.allowLists.map((each) => [each.name, each] as const))(
    "the hosted list of names is the one the proxy narrows to: %s",
    (_name, example) => {
      const found = hostedList(example);

      if (example.allow === null) {
        expect(found).toBeNull();
        return;
      }
      expect(found).not.toBeNull();
      expect(new Set(found)).toStrictEqual(new Set(example.allow));
      expect(new Set(found).size).toBe(found?.length);
    },
  );

  // #979-T03
  it.each(
    EXAMPLES.verdicts.map(
      (each) => [`${each.list}: ${each.host}:${String(each.port)}`, each] as const,
    ),
  )("a name has the verdict of the examples: %s", (_name, example) => {
    const entry = EXAMPLES.allowLists.find((each) => each.name === example.list);
    expect(entry).toBeDefined();
    const list = hostedList(entry as Examples["allowLists"][number]);
    expect(list).not.toBeNull();

    expect(allows(list as string[], example.host, example.port)).toBe(
      example.allowed,
    );
  });
});
