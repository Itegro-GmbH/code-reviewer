// SPDX-License-Identifier: LicenseRef-Proprietary

// The delivery of a customer's dispatcher against a real Postgres (#972): the secret is made by the app, shown once and kept encrypted, a second
// announcement keeps it, a rotation replaces it, `poll` drops it, and a revoked runner changes nothing.
import { describe, expect, it } from "vitest";
import { createRunnerCredentialsRepository } from "../db/repositories/runner-credentials-repository.ts";
import { createRunnersRepository } from "../db/repositories/runners-repository.ts";
import { hashSecret, newRegistrationToken } from "../runner-identity/tokens.ts";
import { openDeliverySecret } from "../runner-identity/delivery.ts";
import {
  mintDeliverySecret,
  sealDeliverySecret,
} from "../runner-identity/delivery.ts";
import {
  startRunnerApiHarness,
  TEST_APP_SECRET,
} from "../test-support/runner-api-harness.ts";
import { createRunnerRegistrationApi } from "./registration.ts";

const URL = "https://dispatcher.example.com/dispatch";

async function start() {
  const h = await startRunnerApiHarness();
  const runner = await h.registerRunner();
  const api = createRunnerRegistrationApi({
    credentials: createRunnerCredentialsRepository(h.db, { now: h.clock.now }),
    settings: () => ({ minBaseVersion: null }),
    logger: { info: () => {}, error: () => {} },
    mintDeliveryKey: (runnerId) => {
      const key = mintDeliverySecret();
      return {
        ...key,
        sealed: sealDeliverySecret(TEST_APP_SECRET, runnerId, key.secret),
      };
    },
  });
  const announce = async (delivery?: unknown) => {
    const response = await api.announce(
      new Request("http://app.test/api/runners/v1/self", {
        method: "PUT",
        headers: {
          authorization: `Bearer ${runner.credential}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          labels: ["linux"],
          baseVersion: "1.0.0",
          ...(delivery === undefined ? {} : { delivery }),
        }),
      }),
    );
    return {
      status: response.status,
      body: (await response.json()) as {
        delivery?: {
          mode: string;
          url?: string;
          keyId?: string;
          secret?: string;
        };
      },
    };
  };
  const row = () =>
    h.db
      .selectFrom("runners")
      .select([
        "delivery_mode",
        "delivery_url",
        "delivery_key_id",
        "delivery_secret",
      ])
      .where("id", "=", runner.runnerId)
      .executeTakeFirstOrThrow();
  return { h, runner, announce, row, api };
}

describe("the delivery of a runner in the database", () => {
  // #972-T04
  it("is poll for a runner that announced none, with no address, key or secret", async () => {
    const { announce, row } = await start();

    const { status, body } = await announce();

    expect(status).toBe(200);
    expect(body.delivery).toBeUndefined();
    expect(await row()).toEqual({
      delivery_mode: "poll",
      delivery_url: null,
      delivery_key_id: null,
      delivery_secret: null,
    });
  });

  // #972-T06
  it("makes a secret for a webhook, shows it once and keeps it only encrypted and bound to the runner", async () => {
    const { runner, announce, row } = await start();

    const { body } = await announce({ mode: "webhook", url: URL });

    const secret = body.delivery?.secret;
    expect(secret).toMatch(/^crw_[A-Za-z0-9_-]{43}$/);
    const stored = await row();
    expect(stored).toMatchObject({
      delivery_mode: "webhook",
      delivery_url: URL,
      delivery_key_id: body.delivery?.keyId,
    });
    expect(stored.delivery_secret).not.toContain(secret as string);
    expect(
      openDeliverySecret(
        TEST_APP_SECRET,
        runner.runnerId,
        stored.delivery_secret as string,
      ),
    ).toBe(secret);
    // Bound to its runner: the same text under another runner's id does not open.
    expect(() =>
      openDeliverySecret(
        TEST_APP_SECRET,
        "another-runner",
        stored.delivery_secret as string,
      ),
    ).toThrow();
  });

  it("keeps the secret and the key when the same webhook is announced again, and shows no secret", async () => {
    const { announce, row } = await start();
    await announce({ mode: "webhook", url: URL });
    const first = await row();

    const { body } = await announce({ mode: "webhook", url: URL });

    expect(body.delivery).toEqual({
      mode: "webhook",
      url: URL,
      keyId: first.delivery_key_id,
    });
    expect(await row()).toEqual(first);
  });

  it("keeps the secret when only the address changes, and replaces it on rotateSecret", async () => {
    const { announce, row } = await start();
    await announce({ mode: "webhook", url: URL });
    const first = await row();

    const moved = await announce({
      mode: "webhook",
      url: "https://elsewhere.example.com/dispatch",
    });
    expect(moved.body.delivery?.secret).toBeUndefined();
    expect(await row()).toMatchObject({
      delivery_url: "https://elsewhere.example.com/dispatch",
      delivery_key_id: first.delivery_key_id,
      delivery_secret: first.delivery_secret,
    });

    const rotated = await announce({
      mode: "webhook",
      url: URL,
      rotateSecret: true,
    });
    expect(rotated.body.delivery?.secret).toMatch(/^crw_/);
    const after = await row();
    expect(after.delivery_secret).not.toBe(first.delivery_secret);
    expect(after.delivery_key_id).not.toBe(first.delivery_key_id);
  });

  it("drops the address, the key and the secret when the runner goes back to polling", async () => {
    const { announce, row } = await start();
    await announce({ mode: "webhook", url: URL });

    await announce({ mode: "poll" });

    expect(await row()).toEqual({
      delivery_mode: "poll",
      delivery_url: null,
      delivery_key_id: null,
      delivery_secret: null,
    });
  });

  it("changes nothing for a runner that was revoked: 401", async () => {
    const { h, runner, announce, row } = await start();
    await h.db
      .updateTable("runners")
      .set({ revoked_at: "2026-11-10T00:00:00.000Z" })
      .where("id", "=", runner.runnerId)
      .execute();

    const { status } = await announce({ mode: "webhook", url: URL });

    expect(status).toBe(401);
    expect((await row()).delivery_mode).toBe("poll");
  });

  it("is made at registration with the runner, bound to the id it gets, and shown once in that answer", async () => {
    const { h, api } = await start();
    const token = newRegistrationToken();
    const made = await createRunnersRepository(h.db, h.workspaceId, {
      now: h.clock.now,
    }).createToken(
      {
        tokenHash: hashSecret(token),
        createdBy: "fleet-user",
        expiresAt: new Date(h.clock.now().getTime() + 3_600_000),
      },
      20,
    );
    expect(made.ok).toBe(true);

    const response = await api.register(
      new Request("http://app.test/api/runners/v1/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          token,
          name: "dispatcher",
          labels: ["linux"],
          baseVersion: "1.0.0",
          delivery: { mode: "webhook", url: URL },
        }),
      }),
    );

    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      runnerId: string;
      delivery: { keyId: string; secret: string };
    };
    const stored = await h.db
      .selectFrom("runners")
      .select(["delivery_mode", "delivery_key_id", "delivery_secret"])
      .where("id", "=", body.runnerId)
      .executeTakeFirstOrThrow();
    expect(stored).toMatchObject({
      delivery_mode: "webhook",
      delivery_key_id: body.delivery.keyId,
    });
    expect(
      openDeliverySecret(
        TEST_APP_SECRET,
        body.runnerId,
        stored.delivery_secret as string,
      ),
    ).toBe(body.delivery.secret);
  });
});
