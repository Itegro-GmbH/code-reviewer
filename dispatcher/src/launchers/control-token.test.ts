// SPDX-License-Identifier: LicenseRef-Proprietary

import { readFileSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { readContract } from "../test-support/harness.ts";
import {
  CONTROL_TOKEN_BYTES,
  controlTokenMatches,
  generateControlToken,
  isControlToken,
  verifyControlMessage,
  verifyExitReport,
} from "./control-token.ts";

const TOKEN = generateControlToken();
const OTHER = generateControlToken();

function tokenSchema(file: string): (value: unknown) => boolean {
  const ajv = new Ajv2020({ strict: false });
  const contract = readContract<{ $id: string }>(file);
  ajv.addSchema(contract);
  const check = ajv.getSchema(`${contract.$id}#/$defs/ControlToken`);
  if (check === undefined) throw new Error(file);
  return (value) => check(value) as boolean;
}

describe("the per-VM control token", () => {
  // #977-T07
  it("is random, of the shape the contracts name and different for every VM", () => {
    expect(isControlToken(TOKEN)).toBe(true);
    expect(TOKEN).toHaveLength(Math.ceil((CONTROL_TOKEN_BYTES * 8) / 6));
    expect(TOKEN).not.toBe(OTHER);
    const defs = (
      readContract("vm-init.v1.json") as { $defs: Record<string, unknown> }
    ).$defs;
    expect(defs.ControlToken).toMatchObject({ pattern: expect.any(String) });
  });

  // #977-T07
  it("is a token of both contracts, whose patterns are the helper's", () => {
    for (const file of ["vm-init.v1.json", "environment-control.v1.json"]) {
      const check = tokenSchema(file);
      expect(check(TOKEN), file).toBe(true);
      expect(check("short"), file).toBe(false);
      expect(check(`${TOKEN} `), file).toBe(false);
      expect(isControlToken("short")).toBe(false);
      expect(isControlToken(`${TOKEN} `)).toBe(false);
      expect(isControlToken(1)).toBe(false);
    }
  });

  // #977-T07
  it("matches only itself", () => {
    expect(controlTokenMatches(TOKEN, TOKEN)).toBe(true);
    expect(controlTokenMatches(OTHER, TOKEN)).toBe(false);
    expect(controlTokenMatches(TOKEN.slice(0, -1), TOKEN)).toBe(false);
    expect(controlTokenMatches(`${TOKEN}x`, TOKEN)).toBe(false);
    expect(controlTokenMatches("", TOKEN)).toBe(false);
    expect(controlTokenMatches(undefined, TOKEN)).toBe(false);
    expect(controlTokenMatches(1, TOKEN)).toBe(false);
    expect(controlTokenMatches(null, TOKEN)).toBe(false);
  });
});

describe("the host's check of a message of the environment control", () => {
  const narrow = {
    version: 1,
    type: "narrow",
    network: { mode: "off", hosts: [] },
    modelHost: "api.example.com",
  };

  // #977-T07
  it("takes a request with the VM's token", () => {
    expect(verifyControlMessage({ ...narrow, token: TOKEN }, TOKEN)).toBe("ok");
    expect(
      verifyControlMessage(
        { version: 1, type: "end", exitCode: 0, token: TOKEN },
        TOKEN,
      ),
    ).toBe("ok");
  });

  // #977-T07
  it("refuses a request without a token", () => {
    expect(verifyControlMessage(narrow, TOKEN)).toBe("missing");
  });

  // #977-T07
  it("refuses a request with another token, an empty one or one that is not text", () => {
    expect(verifyControlMessage({ ...narrow, token: OTHER }, TOKEN)).toBe(
      "wrong",
    );
    expect(verifyControlMessage({ ...narrow, token: "" }, TOKEN)).toBe("wrong");
    expect(verifyControlMessage({ ...narrow, token: 7 }, TOKEN)).toBe("wrong");
    expect(verifyControlMessage({ ...narrow, token: null }, TOKEN)).toBe(
      "wrong",
    );
  });

  // #977-T07
  it("refuses the token of another VM", () => {
    const first = generateControlToken();
    const second = generateControlToken();

    expect(verifyControlMessage({ token: first }, second)).toBe("wrong");
  });

  // #977-T07
  it("reads the example messages of the contract, which carry a token", () => {
    for (const name of ["NarrowRequest", "EndRequest"]) {
      const example = JSON.parse(
        readFileSync(
          new URL(
            `../../../contracts/examples/environment-control/${name}.json`,
            import.meta.url,
          ),
          "utf8",
        ),
      ) as { token: string };

      expect(isControlToken(example.token)).toBe(true);
      expect(verifyControlMessage(example, example.token)).toBe("ok");
    }
  });
});

describe("the host's check of an exit report", () => {
  const report = {
    version: 1,
    type: "exit",
    exitCode: 0,
    reason: "worker_exited",
  };

  // #977-T07
  it("requires the token once the host has an ack for the start", () => {
    const check = { expected: TOKEN, startAcked: true };

    expect(verifyExitReport({ ...report, token: TOKEN }, check)).toBe("ok");
    expect(verifyExitReport(report, check)).toBe("missing");
    expect(verifyExitReport({ ...report, token: OTHER }, check)).toBe("wrong");
  });

  // #977-T07
  it("takes a report without a token before the start was acked, and a wrong one never", () => {
    const check = { expected: TOKEN, startAcked: false };

    expect(
      verifyExitReport({ ...report, reason: "start_timeout" }, check),
    ).toBe("ok");
    expect(verifyExitReport({ ...report, token: TOKEN }, check)).toBe("ok");
    expect(verifyExitReport({ ...report, token: OTHER }, check)).toBe("wrong");
  });
});
