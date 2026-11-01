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
    expect(IMPLEMENTER_REASONS).toHaveLength(9);
    expect(IMPLEMENTER_REASONS.every((r) => PROBE_REASONS.includes(r))).toBe(
      true,
    );
  });

  // #765-D3, D4: opencode and its reasons come from the first output, implementer and its reasons from the second.
  describe("the verdict of the two probes of a deployment that serves the Implementer", () => {
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
    const merged = (first: string, second: string | undefined) => {
      const { line: text, implementerProven } = mergeVerdictOutputs(
        first,
        second,
      );
      return { verdict: parseProbeOutput(text), implementerProven };
    };

    it("names the engine only when the first container passed and the second proved it", () => {
      const { verdict, implementerProven } = merged(dynamic, proving);

      expect(implementerProven).toBe(true);
      expect(verdict).toStrictEqual({
        engines: ["pr-agent", "opencode", "implementer"],
        reasons: [],
        passed: true,
      });
    });

    it("takes `implementer` from the second output only, whatever the first claims", () => {
      const claims = line({
        version: 1,
        engines: ["pr-agent", "opencode", "implementer"],
        reasons: [],
      });
      const { verdict } = merged(claims, dynamic);

      // In the line itself, not only after a reader filtered it again.
      expect(
        (
          JSON.parse(mergeVerdictOutputs(claims, dynamic).line) as {
            engines: string[];
          }
        ).engines,
      ).toStrictEqual(["pr-agent", "opencode"]);
      expect(verdict?.engines).toStrictEqual(["pr-agent", "opencode"]);
      expect(verdict?.reasons).toStrictEqual(["implementer_probe_failed"]);
    });

    it("keeps the Dynamic verdict when the second half did not run: `implementer` is missing with a reason, opencode stays", () => {
      const { verdict, implementerProven } = merged(dynamic, undefined);

      expect(implementerProven).toBe(false);
      expect(verdict).toStrictEqual({
        engines: ["pr-agent", "opencode"],
        reasons: ["implementer_probe_failed"],
        passed: true,
      });
    });

    it("keeps the Dynamic verdict when the second answer is not a verdict", () => {
      const { verdict } = merged(dynamic, "not a verdict");

      expect(verdict?.engines).toStrictEqual(["pr-agent", "opencode"]);
      expect(verdict?.reasons).toStrictEqual(["implementer_probe_failed"]);
    });

    it("does not let a failed check of the Dynamic self-check in the Implementer's container take opencode down", () => {
      const failing = line({
        version: 1,
        engines: ["pr-agent"],
        reasons: ["engine_binary_missing"],
      });
      const { verdict } = merged(dynamic, failing);

      expect(verdict?.engines).toStrictEqual(["pr-agent", "opencode"]);
      expect(verdict?.reasons).toStrictEqual(["implementer_probe_failed"]);
      expect(verdict?.passed).toBe(true);
    });

    it("names the Implementer's own reason when the second container gave one", () => {
      const own = line({
        version: 1,
        engines: ["pr-agent", "opencode"],
        reasons: ["implementer_work_dir_not_exec"],
      });
      const { verdict } = merged(dynamic, own);

      expect(verdict?.engines).toStrictEqual(["pr-agent", "opencode"]);
      expect(verdict?.reasons).toStrictEqual(["implementer_work_dir_not_exec"]);
    });

    it("does not let a reason it does not know vanish: the proof is missing and says so", () => {
      const strange = line({
        version: 1,
        engines: ["pr-agent", "opencode", "implementer"],
        reasons: ["a_reason_of_a_newer_runner"],
      });
      const { verdict, implementerProven } = merged(dynamic, strange);

      expect(implementerProven).toBe(false);
      expect(verdict?.engines).not.toContain("implementer");
      expect(verdict?.reasons).toStrictEqual(["implementer_probe_failed"]);
    });

    it("lets a failure of the Dynamic container stand, whatever the second says", () => {
      const failing = line({
        version: 1,
        engines: ["pr-agent"],
        reasons: ["engine_binary_missing"],
      });
      const { verdict } = merged(failing, proving);

      expect(verdict?.passed).toBe(false);
      expect(verdict?.engines).toStrictEqual(["pr-agent"]);
    });

    it("never names `implementer` when the Dynamic check failed, however clean the second output is", () => {
      const failing = line({
        version: 1,
        engines: ["pr-agent"],
        reasons: ["engine_binary_missing"],
      });

      const merged = mergeVerdictOutputs(failing, proving);

      const written = JSON.parse(merged.line) as {
        engines: string[];
        reasons: string[];
      };
      expect(merged.implementerProven).toBe(false);
      expect(written.engines).toStrictEqual(["pr-agent"]);
      expect(written.reasons).toStrictEqual([
        "engine_binary_missing",
        "implementer_probe_failed",
      ]);
    });

    it("returns a first output that is no verdict as it is", () => {
      expect(mergeVerdictOutputs("not a verdict", proving).line).toBe(
        "not a verdict",
      );
      expect(
        parseProbeOutput(mergeVerdictOutputs("x", dynamic).line),
      ).toBeUndefined();
    });
  });
});
