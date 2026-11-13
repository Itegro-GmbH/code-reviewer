// SPDX-License-Identifier: LicenseRef-Proprietary

// Holds the app to contracts/runner-registration.v1.json (#854): the examples of the file are valid, and the app's own reading of an
// announcement gives the verdict of the file on a set of good and bad bodies. The runner holds the same file in
// runner/tests/contract/test_runner_registration_contract.py.
import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  createContractValidator,
  CONTRACTS_DIRECTORY,
  readExamples,
} from "../test-support/runner-contract.ts";
import { checkAnnouncement } from "./announcement.ts";
import { checkDelivery } from "./delivery.ts";
import { RUNNER_API_ERROR_CODES } from "../runner-api/contract.ts";
import { readContract } from "../test-support/runner-contract.ts";

const FILE = "runner-registration.v1.json";
const contract = createContractValidator(FILE);
const examples = readExamples("examples/runner-registration");

const BODIES = [
  "AnnounceRequest",
  "AnnounceResponse",
  "CredentialResponse",
  "RegisterRequest",
  "RegisterResponse",
];

describe("the runner registration contract", () => {
  // #854-T60
  it("has exactly one example for each body, and each is valid", () => {
    expect(examples.map((example) => example.definition).sort()).toEqual(
      BODIES,
    );
    for (const example of examples) {
      const verdict = contract.check(example.definition, example.document);
      expect({ [example.definition]: verdict }).toEqual({
        [example.definition]: { valid: true, errors: "" },
      });
    }
    expect(readdirSync(CONTRACTS_DIRECTORY)).toContain(FILE);
  });

  // #854-T61
  it("gives the verdict the app's reading of an announcement gives", () => {
    const opencode = {
      harness: "opencode",
      version: "1.19.0",
      auth: "app-key",
    };
    const claude = {
      harness: "claude-code",
      version: "2.1.311",
      auth: "subscription",
    };
    const base = {
      labels: ["linux"],
      baseVersion: "1.0.0",
      manifest: {
        harnesses: { opencode: { version: "1.19.0", ready: true } },
        capabilities: ["agent-docker"],
      },
      limits: { cpus: 4 },
    };
    const bodies: unknown[] = [
      base,
      { labels: [], baseVersion: "0.0.1" },
      { ...base, labels: ["two words"] },
      { ...base, labels: Array.from({ length: 21 }, (_, i) => `l${i}`) },
      { ...base, baseVersion: "1.0" },
      { ...base, baseVersion: "1.0.0-rc.1" },
      { ...base, baseVersion: "v1.0.0" },
      { labels: ["a"] },
      { baseVersion: "1.0.0" },
      {
        ...base,
        manifest: { harnesses: { OpenCode: { version: "1", ready: true } } },
      },
      {
        ...base,
        manifest: {
          harnesses: { "custom/x-y": { version: "1", ready: false } },
        },
      },
      { ...base, manifest: { harnesses: { opencode: { version: "1" } } } },
      { ...base, manifest: { capabilities: ["agent docker"] } },
      // #973: the list form
      { ...base, manifest: { harnesses: [opencode] } },
      { ...base, manifest: { harnesses: [opencode, claude] } },
      {
        ...base,
        manifest: { harnesses: [opencode, { ...claude, models: ["a"] }] },
      },
      {
        ...base,
        manifest: {
          harnesses: [{ ...opencode, auth: "local-key", models: ["gpt-5"] }],
        },
      },
      { ...base, manifest: { harnesses: [{ ...opencode, auth: "managed" }] } },
      { ...base, manifest: { harnesses: [{ ...opencode, auth: "token" }] } },
      { ...base, manifest: { harnesses: [{ ...opencode, auth: undefined }] } },
      {
        ...base,
        manifest: { harnesses: [{ ...opencode, version: undefined }] },
      },
      { ...base, manifest: { harnesses: [{ ...opencode, models: ["a"] }] } },
      { ...base, manifest: { harnesses: [{ ...claude, models: [] }] } },
      {
        ...base,
        manifest: { harnesses: [{ ...claude, models: ["bad model"] }] },
      },
      {
        ...base,
        manifest: {
          harnesses: [
            {
              ...claude,
              models: Array.from({ length: 65 }, (_, i) => `m${String(i)}`),
            },
          ],
        },
      },
      {
        ...base,
        manifest: {
          harnesses: Array.from({ length: 17 }, (_, i) => ({
            ...opencode,
            harness: `h${String(i)}`,
          })),
        },
      },
      { ...base, manifest: { harnesses: ["opencode"] } },
      { ...base, limits: { cpus: 0 } },
      { ...base, limits: { memoryMb: 1.5 } },
    ];

    for (const body of bodies) {
      const file = contract.check("RunnerAnnouncement", body).valid;
      expect({ body, app: checkAnnouncement(body).ok }).toEqual({
        body,
        app: file,
      });
    }
  });

  // #972-T04
  it("gives the verdict the app's reading of a delivery gives, and holds its example", () => {
    const url = "https://dispatcher.example.com/dispatch";
    const bodies: unknown[] = [
      { mode: "poll" },
      { mode: "webhook", url },
      { mode: "webhook", url, rotateSecret: true },
      { mode: "webhook", url, rotateSecret: "yes" },
      { mode: "webhook" },
      { mode: "webhook", url: 5 },
      { mode: "push", url },
      {},
    ];

    for (const body of bodies) {
      const file = contract.check("DeliveryAnnouncement", body).valid;
      expect({ body, app: checkDelivery(body).ok }).toEqual({
        body,
        app: file,
      });
    }
    expect(
      contract.check("RunnerAnnouncement", {
        labels: ["linux"],
        baseVersion: "1.0.0",
        delivery: { mode: "webhook", url },
      }).valid,
    ).toBe(true);
    const response = examples.find(
      (example) => example.definition === "AnnounceResponse",
    );
    expect(response?.document).toMatchObject({
      delivery: { mode: "webhook", secret: expect.stringMatching(/^crw_/) },
    });
  });

  // #973-T04
  it("is looser than the app in one place: the same harness and auth twice, which a schema cannot say", () => {
    const entry = { harness: "opencode", version: "1.19.0", auth: "app-key" };
    const twice = {
      labels: [],
      baseVersion: "1.0.0",
      manifest: { harnesses: [entry, entry] },
    };

    expect(contract.check("RunnerAnnouncement", twice).valid).toBe(true);
    expect(checkAnnouncement(twice).ok).toBe(false);
  });

  // #854-T63
  it("is stricter than the app in the two places where the app forgives: capital letters in a label and a repeated capability", () => {
    const labels = { labels: ["Upper"], baseVersion: "1.0.0" };
    const twice = {
      labels: [],
      baseVersion: "1.0.0",
      manifest: { capabilities: ["a", "a"] },
    };

    expect(contract.check("RunnerAnnouncement", labels).valid).toBe(false);
    expect(checkAnnouncement(labels)).toMatchObject({
      ok: true,
      value: { labels: ["upper"] },
    });
    expect(contract.check("RunnerAnnouncement", twice).valid).toBe(false);
    expect(checkAnnouncement(twice)).toMatchObject({
      ok: true,
      value: { manifest: { capabilities: ["a"] } },
    });
    // #973: and a repeated model of an entry
    const models = {
      labels: [],
      baseVersion: "1.0.0",
      manifest: {
        harnesses: [
          {
            harness: "claude-code",
            version: "2.1.311",
            auth: "subscription",
            models: ["opus", "opus"],
          },
        ],
      },
    };
    expect(contract.check("RunnerAnnouncement", models).valid).toBe(false);
    expect(checkAnnouncement(models)).toMatchObject({
      ok: true,
      value: { manifest: { harnesses: [{ models: ["opus"] }] } },
    });
  });

  // #854-T62
  it("names the new error codes of the runner API, and the app answers with exactly its list", () => {
    const listed = readContract().$defs.ApiErrorCode?.enum ?? [];

    expect([...RUNNER_API_ERROR_CODES].sort()).toEqual([...listed].sort());
    expect(listed).toContain("RUNNER_REGISTRATION_TOKEN_INVALID");
    expect(listed).toContain("RUNNER_UPDATE_NEEDED");
  });
});
