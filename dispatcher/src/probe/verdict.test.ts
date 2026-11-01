// SPDX-License-Identifier: LicenseRef-Proprietary

import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { readContract } from "../test-support/harness.ts";
import {
  IMPLEMENTER_REASONS,
  PROBE_REASONS,
  mergeVerdictOutputs,
  parseProbeOutput,
} from "./verdict.ts";

const line = (document: unknown) => `${JSON.stringify(document)}\n`;

describe("the probe verdict", () => {
  // #331-T08
  it("lists the stable reasons of the contract and no others", () => {
    const contract = readContract<{
      $defs: { ProbeReason: { enum: string[] } };
    }>("probe-verdict.v1.json");

    expect([...PROBE_REASONS].sort()).toStrictEqual(
      [...contract.$defs.ProbeReason.enum].sort(),
    );
  });

  // #331-T01
  it("reads a passing verdict: opencode is advertised and nothing is said against it", () => {
    const verdict = parseProbeOutput(
      line({ version: 1, engines: ["pr-agent", "opencode"], reasons: [] }),
    );

    expect(verdict).toStrictEqual({
      engines: ["pr-agent", "opencode"],
      reasons: [],
      passed: true,
    });
  });

  // #331-T02
  it("reads a verdict without opencode with its stable reasons", () => {
    const verdict = parseProbeOutput(
      line({
        version: 1,
        engines: ["pr-agent"],
        reasons: ["ipv6_not_disabled", "network_probe_failed"],
      }),
    );

    expect(verdict).toStrictEqual({
      engines: ["pr-agent"],
      reasons: ["ipv6_not_disabled", "network_probe_failed"],
      passed: false,
    });
  });

  // #331-T08
  it("keeps stable reasons only: a reason shaped like a secret is dropped and never echoed", () => {
    const secret = "ghp_" + "0123456789abcdef0123456789abcdef0123";
    const verdict = parseProbeOutput(
      line({
        version: 1,
        engines: ["pr-agent"],
        reasons: [
          "capabilities_not_dropped",
          secret,
          "sk-or-v1-abcdef0123456789",
        ],
      }),
    );

    expect(verdict?.reasons).toStrictEqual(["capabilities_not_dropped"]);
    expect(JSON.stringify(verdict)).not.toContain("ghp_");
    expect(JSON.stringify(verdict)).not.toContain("sk-or");
  });

  // #331-T08
  it("ignores a field it does not know and does not carry it on", () => {
    const verdict = parseProbeOutput(
      line({
        version: 1,
        engines: ["pr-agent", "opencode"],
        reasons: [],
        token: "ghp_" + "0123456789abcdef0123456789abcdef0123",
        env: { RUNNER_TOKEN: "dummy" },
      }),
    );

    expect(verdict).toStrictEqual({
      engines: ["pr-agent", "opencode"],
      reasons: [],
      passed: true,
    });
  });

  // #331-T02
  it("does not count opencode as proven when the same verdict also gives a reason against it", () => {
    const verdict = parseProbeOutput(
      line({
        version: 1,
        engines: ["pr-agent", "opencode"],
        reasons: ["root_filesystem_writable"],
      }),
    );

    expect(verdict?.passed).toBe(false);
    expect(verdict?.engines).toStrictEqual(["pr-agent"]);
  });

  // #331-T02
  it("does not count opencode as proven when a reason was dropped as unknown", () => {
    const verdict = parseProbeOutput(
      line({
        version: 1,
        engines: ["pr-agent", "opencode"],
        reasons: ["something_new"],
      }),
    );

    expect(verdict?.passed).toBe(false);
    expect(verdict?.engines).toStrictEqual(["pr-agent"]);
    expect(verdict?.reasons).toStrictEqual([]);
  });

  // #331-T02
  it("reads the last line of the output and leaves what came before it", () => {
    const verdict = parseProbeOutput(
      `starting\n${line({ version: 1, engines: ["pr-agent"], reasons: ["pin_untrusted"] })}\n`,
    );

    expect(verdict?.reasons).toStrictEqual(["pin_untrusted"]);
  });

  // #331-T02
  it.each([
    ["nothing", ""],
    ["text", "opencode is fine\n"],
    [
      "a different version",
      line({ version: 2, engines: ["pr-agent", "opencode"], reasons: [] }),
    ],
    ["no engines field", line({ version: 1, reasons: [] })],
    [
      "engines that are not a list",
      line({ version: 1, engines: "opencode", reasons: [] }),
    ],
    ["a list", line(["opencode"])],
    ["half a line", '{"version":1,"engines":["pr-agent","open'],
    [
      "too much",
      `${" ".repeat(70_000)}${line({ version: 1, engines: ["opencode"], reasons: [] })}`,
    ],
  ])("cannot read %s and advertises nothing from it", (_name, output) => {
    expect(parseProbeOutput(output)).toBeUndefined();
  });

  // #331-T02
  it("never reads an engine it does not know as an engine", () => {
    const verdict = parseProbeOutput(
      line({ version: 1, engines: ["pr-agent", "root-shell"], reasons: [] }),
    );

    expect(verdict?.engines).toStrictEqual(["pr-agent"]);
  });

  // #331-T08
  it("validates its own reading against the contract's closed shapes", () => {
    const ajv = new Ajv2020({ strict: false });
    ajv.addSchema(readContract("runner-api.v1.json") as object);
    const probe = readContract<{ $id: string }>("probe-verdict.v1.json");
    ajv.addSchema(probe);
    const check = ajv.getSchema(`${probe.$id}#/$defs/ProbeVerdict`);
    const verdict = parseProbeOutput(
      line({ version: 1, engines: ["pr-agent"], reasons: ["pin_unreadable"] }),
    );

    expect(
      check?.({
        version: 1,
        engines: verdict?.engines,
        reasons: verdict?.reasons,
      }),
    ).toBe(true);
  });

  // #765-T08
  it("knows `implementer` as an engine and proves it only on top of a passing Dynamic check", () => {
    const three = ["pr-agent", "opencode", "implementer"];

    expect(
      parseProbeOutput(line({ version: 1, engines: three, reasons: [] })),
    ).toStrictEqual({ engines: three, reasons: [], passed: true });
    // Never without opencode, whatever the line claims.
    expect(
      parseProbeOutput(
        line({
          version: 1,
          engines: ["pr-agent", "implementer"],
          reasons: ["pin_unreadable"],
        }),
      )?.engines,
    ).toStrictEqual(["pr-agent"]);
    // Not with a reason of its own in the same line.
    expect(
      parseProbeOutput(
        line({
          version: 1,
          engines: three,
          reasons: ["implementer_work_dir_not_exec"],
        }),
      )?.engines,
    ).toStrictEqual(["pr-agent", "opencode"]);
  });

  // #765-T08
  it("keeps the Implementer's reasons apart from the reasons against opencode", () => {
    const verdict = parseProbeOutput(
      line({
        version: 1,
        engines: ["pr-agent", "opencode"],
        reasons: ["implementer_git_too_old"],
      }),
    );

    expect(verdict).toStrictEqual({
      engines: ["pr-agent", "opencode"],
      reasons: ["implementer_git_too_old"],
      passed: true,
    });
    expect(IMPLEMENTER_REASONS).toHaveLength(8);
    expect(IMPLEMENTER_REASONS.every((r) => PROBE_REASONS.includes(r))).toBe(
      true,
    );
  });

  // #765-T08
  it("unites the verdicts of two containers: a failure of either leaves its engine out", () => {
    const dynamic = line({
      version: 1,
      engines: ["pr-agent", "opencode"],
      reasons: [],
    });
    const proving = line({
      version: 1,
      engines: ["pr-agent", "opencode", "implementer"],
      reasons: [],
    });
    const failing = line({
      version: 1,
      engines: ["pr-agent"],
      reasons: ["engine_binary_missing"],
    });

    expect(
      parseProbeOutput(mergeVerdictOutputs([dynamic, proving])),
    ).toStrictEqual({
      engines: ["pr-agent", "opencode", "implementer"],
      reasons: [],
      passed: true,
    });
    const hidden = parseProbeOutput(mergeVerdictOutputs([dynamic, failing]));
    expect(hidden?.passed).toBe(false);
    expect(hidden?.engines).toStrictEqual(["pr-agent"]);
    expect(mergeVerdictOutputs([dynamic, "not a verdict"])).toBe(
      "not a verdict",
    );
    expect(
      parseProbeOutput(mergeVerdictOutputs(["not a verdict", dynamic])),
    ).toBeUndefined();
  });
});
