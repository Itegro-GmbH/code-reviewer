// SPDX-License-Identifier: LicenseRef-Proprietary

import { describe, expect, it } from "vitest";
import { identityFor } from "../../product-identity/identities.ts";
import { GENERIC_FAILURE } from "../../ui/transport-messages.ts";
import { RUNNER_FLEET_ERROR_CODES } from "../errors.ts";
import {
  describeRunnerFleetFailure,
  registerCommand,
  STATUS_COPY,
} from "./messages.ts";

const factory = identityFor("factory");

describe("the copy of the runners page", () => {
  // #854-T70
  it("has a sentence of its own for every error code of the routes, and none is the generic one", () => {
    for (const code of RUNNER_FLEET_ERROR_CODES) {
      const sentence = describeRunnerFleetFailure(factory, { code });
      expect(sentence, code).not.toBe(GENERIC_FAILURE);
      expect(sentence.length, code).toBeGreaterThan(10);
    }
  });

  // #854-T70
  it("names the maximum when the workspace holds the most tokens and never puts a value of the answer in a sentence", () => {
    expect(
      describeRunnerFleetFailure(factory, {
        code: "RUNNER_FLEET_TOKEN_LIMIT_REACHED",
        maximum: 20,
      }),
    ).toContain("20");
    expect(
      describeRunnerFleetFailure(factory, {
        code: "RUNNER_FLEET_NOT_FOUND",
        message: "<script>alert(1)</script>",
      } as never),
    ).not.toContain("<script>");
  });

  // #854-T70
  it("falls back to the transport sentences and the generic one for a code it does not know", () => {
    expect(
      describeRunnerFleetFailure(factory, { code: "NETWORK_ERROR" }),
    ).toContain("could not be reached");
    expect(describeRunnerFleetFailure(factory, { code: "WHATEVER" })).toBe(
      GENERIC_FAILURE,
    );
  });

  // #854-T71
  it("has a word for every state and the command that registers a runner with a token", () => {
    expect(Object.keys(STATUS_COPY).sort()).toEqual([
      "offline",
      "online",
      "update_needed",
    ]);
    expect(registerCommand("crt_abc")).toBe(
      "factory-runner register --token crt_abc",
    );
  });
});
