// SPDX-License-Identifier: LicenseRef-Proprietary

// What a customer's runner is handed depends on its manifest (#973): a turn goes only to a runner with an entry that has the harness, the auth and the model
// the turn asks for, and the pairing of the rings lists the same runners as the claim takes (one rule, `accessRule`). A later announcement replaces the
// last one, so an entry that was withdrawn no longer matches. Against a real Postgres with the harness of the runner API.
import { sql } from "kysely";
import { describe, expect, it } from "vitest";
import { createRunnerCredentialsRepository } from "../db/repositories/runner-credentials-repository.ts";
import { createRunnerDispatchesRepository } from "../db/repositories/runner-dispatches-repository.ts";
import {
  accessMatches,
  customerAccess,
  demandOfTurn,
  type HarnessAccess,
} from "../runner-identity/access.ts";
import {
  mintDeliverySecret,
  sealDeliverySecret,
} from "../runner-identity/delivery.ts";
import { manifestFromText } from "../runner-identity/announcement.ts";
import { customerRunnerId } from "../runner-identity/tokens.ts";
import { OPENCODE_ACCESS } from "../test-support/runner-access.ts";
import {
  startRunnerApiHarness,
  TEST_APP_SECRET,
} from "../test-support/runner-api-harness.ts";
import type { ClaimResponse } from "./contract.ts";

const FEATURES = [
  "cost_limit",
  "operator_cost_limit",
  "dynamic_cost_policy",
  "implementer_profile",
  "implementer_environment",
  "implementer_result",
  "implementer_resume",
  "implementer_start_branch",
];
const ENV = { id: "env-runner", name: "My box", labels: ["box"] };
const PROFILE = {
  id: "p-1",
  name: "claude",
  version: 1,
  instructions: "",
  canPush: true,
};
const OWN = { provider: "anthropic", model: "claude-sonnet-5-5" };
const OPUS = { provider: "claude-code", model: "opus" };

const claude = (models?: string[]): HarnessAccess => ({
  harness: "claude-code",
  version: "2.1.311",
  auth: "subscription",
  ...(models === undefined ? {} : { models }),
});
const manifestOf = (...entries: HarnessAccess[]) => ({
  harnesses: [...OPENCODE_ACCESS, ...entries],
  capabilities: [],
});

async function start() {
  return startRunnerApiHarness({ implementer: true, llmKey: null });
}
type Harness = Awaited<ReturnType<typeof start>>;

const claimOf = (credential: string) => ({
  token: credential,
  engines: ["implementer"],
  features: FEATURES,
});

/** A runner of the box that announced a webhook, so the rings see it. */
async function runner(h: Harness, manifest: ReturnType<typeof manifestOf>) {
  const made = await h.registerRunner({ labels: ["box"], manifest });
  await createRunnerCredentialsRepository(h.db, {
    now: h.clock.now,
  }).setDelivery(made.runnerId, {
    mode: "webhook",
    url: "https://box.example.test/dispatch",
    rotateSecret: false,
    mintKey: () => {
      const key = mintDeliverySecret();
      return {
        ...key,
        sealed: sealDeliverySecret(TEST_APP_SECRET, made.runnerId, key.secret),
      };
    },
  });
  return made;
}

describe("the manifest of a runner and the claim", () => {
  // #973-T01
  it("hands a turn for claude-code, subscription and opus only to a runner announcing that entry", async () => {
    const h = await start();
    const plain = await h.registerRunner({
      labels: ["box"],
      manifest: manifestOf(),
    });
    const sonnetOnly = await h.registerRunner({
      labels: ["box"],
      manifest: manifestOf(claude(["sonnet"])),
    });
    const onKey = await h.registerRunner({
      labels: ["box"],
      manifest: manifestOf({ ...claude(["opus"]), auth: "local-key" }),
    });
    const capable = await h.registerRunner({
      labels: ["box"],
      manifest: manifestOf(claude(["haiku", "opus", "sonnet"])),
    });
    const turn = await h.enqueueTurn({
      modelChoice: OPUS,
      runnerEnvironment: ENV,
      profile: { ...PROFILE, harness: "claude-code" },
    });

    for (const refused of [plain, sonnetOnly, onKey])
      expect((await h.claim(claimOf(refused.credential))).status).toBe(204);
    expect(await h.queue.get(turn.job.id)).toMatchObject({ status: "queued" });
    const taken = await h.claim(claimOf(capable.credential));

    expect(taken.status).toBe(200);
    expect(((await taken.json()) as ClaimResponse).job.id).toBe(turn.job.id);
  });

  // #973-T01
  it("hands a turn on the workspace's own key to a runner that announces OpenCode on a key of the app, whatever else it announces", async () => {
    const h = await start();
    const withClaude = await h.registerRunner({
      labels: ["box"],
      manifest: manifestOf(claude()),
    });
    const turn = await h.enqueueTurn({
      modelChoice: OWN,
      runnerEnvironment: ENV,
    });

    // The claim of the queue: the model of a turn on the workspace's key needs a key and a price book that this test has no use for.
    const claimed = await h.queue.claimNext(
      customerRunnerId(withClaude.runnerId),
      ["implementer"],
      {
        customerRunner: {
          workspaceId: h.workspaceId,
          labels: ["box"],
          access: manifestOf(claude()).harnesses,
        },
      },
    );

    expect(claimed?.job.id).toBe(turn.job.id);
  });

  // #973-T03
  it("uses the last announcement: an entry the runner withdrew no longer matches, and one it announces again does", async () => {
    const h = await start();
    const box = await h.registerRunner({
      labels: ["box"],
      manifest: manifestOf(claude(["opus"])),
    });
    const credentials = createRunnerCredentialsRepository(h.db, {
      now: h.clock.now,
    });
    const announce = (manifest: ReturnType<typeof manifestOf>) =>
      credentials.announce(box.runnerId, {
        labels: ["box"],
        baseVersion: "1.0.0",
        manifest,
        limits: {},
      });
    const turn = await h.enqueueTurn({
      modelChoice: OPUS,
      runnerEnvironment: ENV,
      profile: { ...PROFILE, harness: "claude-code" },
    });

    // All its subscriptions are rate limited: it leaves the entry out, and the turn stays queued for it.
    expect(await announce(manifestOf())).toBe(true);
    expect((await h.claim(claimOf(box.credential))).status).toBe(204);
    expect(await h.queue.get(turn.job.id)).toMatchObject({ status: "queued" });

    expect(await announce(manifestOf(claude(["opus"])))).toBe(true);
    expect((await h.claim(claimOf(box.credential))).status).toBe(200);
  });

  // #973-T01
  it("never hands the platform's Dispatcher a turn that asks for a subscription, and still hands it a hosted turn on a catalog entry or a key of the app", async () => {
    const h = await start();
    const subscription = await h.enqueueTurn({
      modelChoice: OPUS,
      profile: { ...PROFILE, harness: "claude-code" },
    });

    const none = await h.claim({
      engines: ["implementer", "opencode", "pr-agent"],
      features: FEATURES,
    });

    expect(none.status).toBe(204);
    expect(await h.queue.get(subscription.job.id)).toMatchObject({
      status: "queued",
    });
    const own = await h.enqueueTurn({ modelChoice: OWN });
    const claimed = await h.queue.claimNext("runner-a", ["implementer"]);
    expect(claimed?.job.id).toBe(own.job.id);
  });
});

describe("the claim and the pairing of the rings", () => {
  const SCENARIOS: [string, ReturnType<typeof manifestOf>][] = [
    ["opencode alone", manifestOf()],
    ["claude code with any model", manifestOf(claude())],
    ["claude code with opus", manifestOf(claude(["opus"]))],
    ["claude code with sonnet only", manifestOf(claude(["sonnet"]))],
    [
      "claude code on a key of the device",
      manifestOf({ ...claude(["opus"]), auth: "local-key" }),
    ],
  ];
  const TURNS = [
    ["a subscription turn on opus", OPUS, "claude-code"],
    ["a turn on the workspace's key", OWN, "opencode"],
  ] as const;

  // #973-T01
  it.each(
    SCENARIOS.flatMap(([manifest, announced]) =>
      TURNS.map(([turn, choice, harness]) => ({
        manifest,
        announced,
        turn,
        choice,
        harness,
      })),
    ),
  )(
    "list a runner for $turn exactly when the claim takes it: $manifest",
    async ({ announced, choice, harness }) => {
      const h = await start();
      const box = await runner(h, announced);
      const turn = await h.enqueueTurn({
        modelChoice: choice,
        runnerEnvironment: ENV,
        profile: { ...PROFILE, harness },
      });

      const listed = (
        await createRunnerDispatchesRepository(h.db).listDue(
          h.clock.now(),
          10,
          {
            jobId: turn.job.id,
          },
        )
      ).map((pair) => pair.runnerId);
      const claimed = await h.queue.claimNext(
        customerRunnerId(box.runnerId),
        ["implementer"],
        {
          customerRunner: {
            workspaceId: h.workspaceId,
            labels: ["box"],
            access: announced.harnesses,
          },
        },
      );

      const expected = accessMatches(
        announced.harnesses,
        demandOfTurn({ harness, modelChoice: choice }),
      );
      expect({
        listed: listed.includes(box.runnerId),
        claimed: claimed?.job.id === turn.job.id,
      }).toEqual({ listed: expected, claimed: expected });
    },
  );
});

const MANAGED_OPENCODE: HarnessAccess = {
  harness: "opencode",
  version: "1.19.0",
  auth: "managed",
};
const CATALOG = { entryId: "entry-1" };

describe("the manifest as the rings and the claim read it", () => {
  const listed = async (h: Harness, jobId: string) =>
    (
      await createRunnerDispatchesRepository(h.db).listDue(h.clock.now(), 10, {
        jobId,
      })
    ).map((pair) => pair.runnerId);

  /**
   * The claim of the queue for a runner, with the entries of its stored manifest as the API reads them (`manifestFromText`). The model of a turn on the
   * workspace's own key needs a key and a price book that this test has no use for, so the API call is not made.
   */
  const claimAs = async (h: Harness, runnerId: string) => {
    const { rows } = await sql<{ manifest: string }>`
      select manifest from runners where id = ${runnerId}`.execute(h.db);
    return h.queue.claimNext(customerRunnerId(runnerId), ["implementer"], {
      customerRunner: {
        workspaceId: h.workspaceId,
        labels: ["box"],
        access: customerAccess(
          manifestFromText(rows[0]?.manifest ?? "").harnesses,
        ),
      },
    });
  };

  // #973-T04
  it("reads the old map form in the rings as the claim does: ready entries only, OpenCode on a key of the app, Claude Code on a subscription", async () => {
    const h = await start();
    const box = await runner(h, manifestOf());
    await sql`update runners set manifest = ${JSON.stringify({
      harnesses: {
        opencode: { version: "1.19.0", ready: true },
        "claude-code": { version: "2.1.311", ready: true },
        "custom/idle": { version: "0.1", ready: false },
      },
      capabilities: [],
    })} where id = ${box.runnerId}`.execute(h.db);
    const own = await h.enqueueTurn({
      modelChoice: OWN,
      runnerEnvironment: ENV,
    });
    const opus = await h.enqueueTurn({
      modelChoice: OPUS,
      runnerEnvironment: ENV,
      profile: { ...PROFILE, harness: "claude-code" },
    });

    expect(await listed(h, own.job.id)).toEqual([box.runnerId]);
    expect(await listed(h, opus.job.id)).toEqual([box.runnerId]);
    const claimed = [
      (await claimAs(h, box.runnerId))?.job.id,
      (await claimAs(h, box.runnerId))?.job.id,
    ];
    expect(claimed.sort()).toEqual([own.job.id, opus.job.id].sort());
  });

  // #973-T01
  it("lists and claims the other runners when one runner's stored manifest is no JSON", async () => {
    const h = await start();
    const broken = await runner(h, manifestOf());
    const good = await runner(h, manifestOf());
    await sql`update runners set manifest = 'not json {' where id = ${broken.runnerId}`.execute(
      h.db,
    );
    const turn = await h.enqueueTurn({
      modelChoice: OWN,
      runnerEnvironment: ENV,
    });

    expect(await listed(h, turn.job.id)).toEqual([good.runnerId]);
    // A manifest that reads as none is no runner: it takes nothing, and the other one still takes the turn.
    expect((await h.claim(claimOf(broken.credential))).status).toBe(204);
    expect(await claimAs(h, broken.runnerId)).toBeNull();
    expect((await claimAs(h, good.runnerId))?.job.id).toBe(turn.job.id);
  });

  // #973-T01
  it("lists and claims the other turns when one turn's stored model choice is no JSON", async () => {
    const h = await start();
    const box = await runner(h, manifestOf());
    const broken = await h.enqueueTurn({
      modelChoice: OWN,
      runnerEnvironment: ENV,
    });
    const good = await h.enqueueTurn({
      modelChoice: OWN,
      runnerEnvironment: ENV,
    });
    await sql`update implementer_turns set model_choice = 'not json {' where job_id = ${broken.job.id}`.execute(
      h.db,
    );

    const pairs = await createRunnerDispatchesRepository(h.db).listDue(
      h.clock.now(),
      10,
    );
    expect(pairs.map((pair) => [pair.jobId, pair.runnerId])).toEqual([
      [good.job.id, box.runnerId],
    ]);
    expect((await claimAs(h, box.runnerId))?.job.id).toBe(good.job.id);
    expect(await h.queue.get(broken.job.id)).toMatchObject({
      status: "queued",
    });
  });

  it("does not hand the platform's Dispatcher a turn whose stored model choice is no JSON, and still hands it the next one", async () => {
    const h = await start();
    const broken = await h.enqueueTurn({ modelChoice: CATALOG });
    const good = await h.enqueueTurn({ modelChoice: CATALOG });
    await sql`update implementer_turns set model_choice = 'not json {' where job_id = ${broken.job.id}`.execute(
      h.db,
    );

    const claimed = await h.queue.claimNext("runner-a", ["implementer"]);

    expect(claimed?.job.id).toBe(good.job.id);
  });

  // #973-T02
  it("never hands a customer's runner a managed turn, whatever its stored manifest says, and issues no key", async () => {
    const h = await start();
    // A row written by hand: the registration refuses `managed`, the table does not.
    const handWritten = await runner(h, manifestOf(MANAGED_OPENCODE));
    const turn = await h.enqueueTurn({
      modelChoice: CATALOG,
      runnerEnvironment: ENV,
    });

    expect((await h.claim(claimOf(handWritten.credential))).status).toBe(204);
    expect(await claimAs(h, handWritten.runnerId)).toBeNull();
    expect(await h.queue.get(turn.job.id)).toMatchObject({ status: "queued" });
    expect(await listed(h, turn.job.id)).toEqual([]);
    // Even a claim that is handed the managed entry directly (past the stored manifest) takes nothing.
    expect(
      await h.queue.claimNext(
        customerRunnerId(handWritten.runnerId),
        ["implementer"],
        {
          customerRunner: {
            workspaceId: h.workspaceId,
            labels: ["box"],
            access: [MANAGED_OPENCODE],
          },
        },
      ),
    ).toBeNull();
    expect(await h.queue.get(turn.job.id)).toMatchObject({ status: "queued" });
  });
});
