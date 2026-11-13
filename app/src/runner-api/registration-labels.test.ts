// SPDX-License-Identifier: LicenseRef-Proprietary

// The reserved namespace `cr:` at the door of a customer's runner (#971): the registration and the announcement of labels refuse a
// label of the platform with 422 and a stable code, and take every other label. The check is the identity's, not the text's: a customer's
// runner is never the platform, so there is no spelling that gets through.
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

function announce(labels: unknown) {
  return new Request("http://app.test/api/runners/v1/self", {
    method: "PUT",
    headers: {
      authorization: `Bearer ${newRunnerCredential()}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ labels, baseVersion: "1.0.0" }),
  });
}

function register(labels: unknown) {
  return new Request("http://app.test/api/runners/v1/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      token: newRegistrationToken(),
      name: "box",
      labels,
      baseVersion: "1.0.0",
    }),
  });
}

describe("the labels a customer's runner announces", () => {
  // #971-T01
  it("are refused with 422 RUNNER_LABEL_RESERVED when one is in the namespace of the platform, and nothing is stored", async () => {
    const { api, credentials } = start();

    const response = await api.announce(announce(["linux", "cr:managed"]));

    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      error: {
        code: "RUNNER_LABEL_RESERVED",
        fields: [{ field: "labels[1]", code: "reserved" }],
      },
    });
    expect(credentials.announce).not.toHaveBeenCalled();
  });

  // #971-T01
  it("are refused whatever the spelling of the reserved label, and at registration too", async () => {
    const { api, credentials } = start();

    for (const label of ["CR:managed", "cr:size-2", "cr:anything-new"]) {
      expect((await api.announce(announce([label]))).status).toBe(422);
      const registered = await api.register(register([label]));
      expect(registered.status).toBe(422);
      expect(await registered.json()).toMatchObject({
        error: { code: "RUNNER_LABEL_RESERVED" },
      });
    }
    expect(credentials.announce).not.toHaveBeenCalled();
    expect(credentials.redeem).not.toHaveBeenCalled();
  });

  // #971-T01
  it("are taken when they are the customer's own, such as linux and gpu", async () => {
    const { api, credentials } = start();

    const announced = await api.announce(announce(["linux", "gpu"]));
    const registered = await api.register(register(["linux", "gpu"]));

    expect(announced.status).toBe(200);
    expect(registered.status).toBe(201);
    expect(credentials.announce).toHaveBeenCalledWith(
      "r-1",
      expect.objectContaining({ labels: ["gpu", "linux"] }),
    );
  });

  // #971-T01
  it("answer a form error with 400 before the reserved check, so a malformed body keeps its own answer", async () => {
    const { api } = start();

    const response = await api.announce(announce(["cr:managed", "two words"]));

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: "RUNNER_REQUEST_INVALID" },
    });
  });
});
