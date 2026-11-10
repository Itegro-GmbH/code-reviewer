// SPDX-License-Identifier: LicenseRef-Proprietary

// The delivery a dispatcher announces at registration and in `PUT /self` (#972): checked, stored through the repository, and answered with
// what the app holds; the secret the app minted is in the answer that minted it and nowhere else.
import { describe, expect, it, vi } from "vitest";
import type {
  DeliveryChange,
  RunnerCredentialsRepository,
  StoredDelivery,
} from "../db/repositories/runner-credentials-repository.ts";
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
  manifest: { harnesses: {}, capabilities: [] },
  limits: {},
  createdAt: "2026-11-10T08:00:00.000Z",
  lastSeenAt: "2026-11-10T08:00:00.000Z",
  revokedAt: null,
};
const SECRET = `crw_${"A".repeat(43)}`;
const URL = "https://dispatcher.example.com/dispatch";

function start(stored: StoredDelivery | undefined = undefined) {
  const credentials = {
    redeem: vi.fn(async () => ({ ok: true as const, runner: RUNNER })),
    authenticate: vi.fn(async () => RUNNER),
    announce: vi.fn(async () => true),
    setDelivery: vi.fn(
      async (_id: string, change: DeliveryChange): Promise<StoredDelivery> =>
        stored ??
        (change.mode === "poll"
          ? { mode: "poll" }
          : {
              mode: "webhook",
              url: change.url,
              keyId: "d-0123abcd",
              secret: SECRET,
            }),
    ),
    renew: vi.fn(async () => true),
  } satisfies RunnerCredentialsRepository;
  const mintDeliveryKey = vi.fn((runnerId: string) => ({
    keyId: "d-0123abcd",
    secret: SECRET,
    sealed: `sealed-for-${runnerId}`,
  }));
  const api = createRunnerRegistrationApi({
    credentials,
    settings: () => ({ minBaseVersion: null }),
    logger: { info: () => {}, error: () => {} },
    mintDeliveryKey,
  });
  return { api, credentials, mintDeliveryKey };
}

const announce = (delivery?: unknown) =>
  new Request("http://app.test/api/runners/v1/self", {
    method: "PUT",
    headers: {
      authorization: `Bearer ${newRunnerCredential()}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      labels: ["linux"],
      baseVersion: "1.0.0",
      ...(delivery === undefined ? {} : { delivery }),
    }),
  });

const register = (delivery?: unknown) =>
  new Request("http://app.test/api/runners/v1/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      token: newRegistrationToken(),
      name: "box",
      labels: ["linux"],
      baseVersion: "1.0.0",
      ...(delivery === undefined ? {} : { delivery }),
    }),
  });

describe("the delivery in PUT /self", () => {
  // #972-T04
  it("is polling when the body names none: the app stores poll and the answer has no delivery", async () => {
    const { api, credentials } = start();

    const response = await api.announce(announce());

    expect(response.status).toBe(200);
    expect(credentials.setDelivery).toHaveBeenCalledWith("r-1", {
      mode: "poll",
    });
    expect(await response.json()).not.toHaveProperty("delivery");
  });

  it("stores a webhook with its address and shows the secret the app made, once, in that answer", async () => {
    const { api, credentials, mintDeliveryKey } = start();

    const response = await api.announce(
      announce({ mode: "webhook", url: URL }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      version: 1,
      runnerId: "r-1",
      delivery: {
        mode: "webhook",
        url: URL,
        keyId: "d-0123abcd",
        secret: SECRET,
      },
    });
    const change = credentials.setDelivery.mock.calls[0]?.[1];
    expect(change).toMatchObject({
      mode: "webhook",
      url: URL,
      rotateSecret: false,
    });
    // The key is made only when the repository asks for it (there is none yet, or a new one is wanted).
    expect(mintDeliveryKey).not.toHaveBeenCalled();
    if (change?.mode === "webhook")
      expect(change.mintKey().secret).toBe(SECRET);
    expect(mintDeliveryKey).toHaveBeenCalledWith("r-1");
  });

  it("does not show the secret again when the runner announces the same webhook once more", async () => {
    const { api } = start({ mode: "webhook", url: URL, keyId: "d-0123abcd" });

    const response = await api.announce(
      announce({ mode: "webhook", url: URL }),
    );

    const answered = (await response.json()) as {
      delivery: Record<string, unknown>;
    };
    expect(answered.delivery).toEqual({
      mode: "webhook",
      url: URL,
      keyId: "d-0123abcd",
    });
  });

  it("asks for a new secret on rotateSecret", async () => {
    const { api, credentials } = start();

    await api.announce(
      announce({ mode: "webhook", url: URL, rotateSecret: true }),
    );

    expect(credentials.setDelivery.mock.calls[0]?.[1]).toMatchObject({
      rotateSecret: true,
    });
  });

  it("refuses a delivery that does not fit, naming the field and not the value, and stores nothing", async () => {
    const { api, credentials } = start();

    for (const [delivery, field] of [
      [{ mode: "webhook" }, "delivery.url"],
      [{ mode: "push" }, "delivery.mode"],
      [
        { mode: "webhook", url: "http://169.254.169.254/dispatch" },
        "delivery.url",
      ],
      [
        { mode: "webhook", url: "https://printer.local/dispatch" },
        "delivery.url",
      ],
      [
        { mode: "webhook", url: URL, rotateSecret: "yes" },
        "delivery.rotateSecret",
      ],
      ["webhook", "delivery"],
    ] as const) {
      const response = await api.announce(announce(delivery));
      expect(response.status).toBe(400);
      const body = (await response.json()) as {
        error: { code: string; fields: { field: string }[] };
      };
      expect(body.error.code).toBe("RUNNER_REQUEST_INVALID");
      expect(body.error.fields.map((f) => f.field)).toContain(field);
      expect(JSON.stringify(body)).not.toContain("169.254");
    }
    expect(credentials.announce).not.toHaveBeenCalled();
    expect(credentials.setDelivery).not.toHaveBeenCalled();
  });

  it("is a 401, like every call, for a runner revoked between the two statements", async () => {
    const { api, credentials } = start();
    credentials.setDelivery.mockResolvedValueOnce(undefined as never);

    const response = await api.announce(
      announce({ mode: "webhook", url: URL }),
    );

    expect(response.status).toBe(401);
  });
});

describe("the delivery in POST /register", () => {
  it("makes the secret with the runner, bound to the id the runner will have, and shows it once in the answer of the registration", async () => {
    const { api, credentials, mintDeliveryKey } = start();

    const response = await api.register(
      register({ mode: "webhook", url: URL }),
    );

    expect(response.status).toBe(201);
    const [, newRunner] = credentials.redeem.mock.calls[0] as unknown as [
      string,
      { id: string; delivery: { url: string; key: { sealed: string } } },
    ];
    expect(mintDeliveryKey).toHaveBeenCalledWith(newRunner.id);
    expect(newRunner.delivery).toMatchObject({
      url: URL,
      key: { sealed: `sealed-for-${newRunner.id}` },
    });
    const answered = (await response.json()) as Record<string, unknown>;
    expect(answered.delivery).toEqual({
      mode: "webhook",
      url: URL,
      keyId: "d-0123abcd",
      secret: SECRET,
    });
    // What the database keeps is not in the answer.
    expect(JSON.stringify(answered)).not.toContain("sealed-for-");
  });

  it("makes no key for a runner that polls", async () => {
    const { api, mintDeliveryKey } = start();

    const response = await api.register(register());

    expect(response.status).toBe(201);
    expect(mintDeliveryKey).not.toHaveBeenCalled();
    expect(await response.json()).not.toHaveProperty("delivery");
  });

  it("refuses a bad delivery before the token is used", async () => {
    const { api, credentials } = start();

    const response = await api.register(
      register({ mode: "webhook", url: "ftp://example.com/dispatch" }),
    );

    expect(response.status).toBe(400);
    expect(credentials.redeem).not.toHaveBeenCalled();
  });
});
