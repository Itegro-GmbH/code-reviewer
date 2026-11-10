// SPDX-License-Identifier: LicenseRef-Proprietary

// The access `managed` at the door of a customer's runner (#973): the platform's keys are the platform identity's, so a customer's runner that
// announces an entry with `auth: managed` is refused with 422 and a stable code, at registration and in an announcement, and nothing is stored.
// Every other source of access is taken, the old map form too. The check is the identity's, not the text's.
import { describe, expect, it, vi } from "vitest";
import type { RunnerCredentialsRepository } from "../db/repositories/runner-credentials-repository.ts";
import type { StoredRunner } from "../db/repositories/runners-repository.ts";
import {
  newRegistrationToken,
  newRunnerCredential,
} from "../runner-identity/tokens.ts";
import { createRunnerRegistrationApi } from "./registration.ts";

const RUNNER: StoredRunner = {
  id: "r-1",
  workspaceId: "w-1",
  name: "box",
  labels: ["linux"],
  baseVersion: "1.0.0",
  manifest: { harnesses: [], capabilities: [] },
  limits: {},
  createdAt: "2026-11-10T08:00:00.000Z",
  lastSeenAt: "2026-11-10T08:00:00.000Z",
  revokedAt: null,
};

function start() {
  const credentials = {
    redeem: vi.fn(async () => ({ ok: true as const, runner: RUNNER })),
    authenticate: vi.fn(async () => RUNNER),
    announce: vi.fn(async () => true),
    setDelivery: vi.fn(async () => ({ mode: "poll" as const })),
    renew: vi.fn(async () => true),
  } satisfies RunnerCredentialsRepository;
  const api = createRunnerRegistrationApi({
    credentials,
    settings: () => ({ minBaseVersion: null }),
    logger: { info: () => {}, error: () => {} },
    mintDeliveryKey: () => {
      throw new Error("no delivery in this test");
    },
  });
  return { api, credentials };
}

const OPENCODE = { harness: "opencode", version: "1.19.0", auth: "app-key" };

function announce(harnesses: unknown) {
  return new Request("http://app.test/api/runners/v1/self", {
    method: "PUT",
    headers: {
      authorization: `Bearer ${newRunnerCredential()}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      labels: ["linux"],
      baseVersion: "1.0.0",
      manifest: { harnesses },
    }),
  });
}

function register(harnesses: unknown) {
  return new Request("http://app.test/api/runners/v1/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      token: newRegistrationToken(),
      name: "box",
      labels: ["linux"],
      baseVersion: "1.0.0",
      manifest: { harnesses },
    }),
  });
}

describe("the access a customer's runner announces", () => {
  // #973-T02
  it("is refused with 422 RUNNER_ACCESS_RESERVED when an entry claims managed, and nothing is stored", async () => {
    const { api, credentials } = start();
    const harnesses = [OPENCODE, { ...OPENCODE, auth: "managed" }];

    const announced = await api.announce(announce(harnesses));
    const registered = await api.register(register(harnesses));

    for (const response of [announced, registered]) {
      expect(response.status).toBe(422);
      expect(await response.json()).toMatchObject({
        error: {
          code: "RUNNER_ACCESS_RESERVED",
          fields: [{ field: "manifest.harnesses[1].auth", code: "reserved" }],
        },
      });
    }
    expect(credentials.announce).not.toHaveBeenCalled();
    expect(credentials.redeem).not.toHaveBeenCalled();
  });

  // #973-T02
  it("is taken when it is a key of the app, a key of the device or a subscription, with or without models", async () => {
    const { api, credentials } = start();
    const harnesses = [
      OPENCODE,
      {
        harness: "opencode",
        version: "1.19.0",
        auth: "local-key",
        models: ["gpt-5"],
      },
      { harness: "claude-code", version: "2.1.311", auth: "subscription" },
    ];

    expect((await api.announce(announce(harnesses))).status).toBe(200);
    expect((await api.register(register(harnesses))).status).toBe(201);
    expect(credentials.announce).toHaveBeenCalledWith(
      "r-1",
      expect.objectContaining({
        manifest: {
          harnesses: [OPENCODE, { ...harnesses[1] }, { ...harnesses[2] }],
          capabilities: [],
        },
      }),
    );
  });

  // #973-T04
  it("takes the old map form, and stores it as the list", async () => {
    const { api, credentials } = start();

    const response = await api.announce(
      announce({
        opencode: { version: "1.19.0", ready: true },
        "claude-code": { version: "2.1.311", ready: true },
      }),
    );

    expect(response.status).toBe(200);
    expect(credentials.announce).toHaveBeenCalledWith(
      "r-1",
      expect.objectContaining({
        manifest: {
          harnesses: [
            OPENCODE,
            {
              harness: "claude-code",
              version: "2.1.311",
              auth: "subscription",
            },
          ],
          capabilities: [],
        },
      }),
    );
  });

  // #973-T02
  it("answers a form error with 400 before the reserved check, so a malformed body keeps its own answer", async () => {
    const { api } = start();

    const response = await api.announce(
      announce([{ ...OPENCODE, auth: "managed" }, { harness: "opencode" }]),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: "RUNNER_REQUEST_INVALID" },
    });
  });
});
