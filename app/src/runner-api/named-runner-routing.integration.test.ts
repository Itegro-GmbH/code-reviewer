// SPDX-License-Identifier: LicenseRef-Proprietary

// A job of a lane step reaches ONE concrete self-hosted runner (#1105, ADR 0007, decision 10) against a real Postgres: the job requires the
// reserved label `cr:runner:<id>`, which only the credential of that runner carries (derived from its row, never from what it announced),
// so another runner of the workspace with the same labels, the platform identity and a runner of another workspace never take it, and the
// doorbell rings the named runner alone. A hosted runner's turn stays a hosted job of its size.
import { describe, expect, it } from "vitest";
import { OPENCODE_ACCESS } from "../test-support/runner-access.ts";
import { createRunnerCredentialsRepository } from "../db/repositories/runner-credentials-repository.ts";
import { createRunnerDispatchesRepository } from "../db/repositories/runner-dispatches-repository.ts";
import {
  mintDeliverySecret,
  sealDeliverySecret,
} from "../runner-identity/delivery.ts";
import {
  startRunnerApiHarness,
  TEST_APP_SECRET,
} from "../test-support/runner-api-harness.ts";
import { addWorkspace } from "../test-support/workspaces.ts";
import { runnerLabel } from "../runner-identity/labels.ts";
import { customerRunnerId } from "../runner-identity/tokens.ts";

async function start() {
  return startRunnerApiHarness({ implementer: true, llmKey: null });
}
type Harness = Awaited<ReturnType<typeof start>>;

/** The claim of a customer's runner as `claim.ts` makes it: its own labels and its own id. */
async function claimAs(
  h: Harness,
  runner: { runnerId: string },
  labels: string[] = ["linux"],
  workspaceId: string = h.workspaceId,
) {
  const claimed = await h.queue.claimNext(
    customerRunnerId(runner.runnerId),
    ["implementer"],
    {
      customerRunner: {
        runnerId: runner.runnerId,
        workspaceId,
        labels,
        access: OPENCODE_ACCESS,
      },
    },
  );
  return claimed === null ? null : claimed.job.id;
}

const OWN = { provider: "anthropic", model: "claude-sonnet-5-5" } as const;

/** The copy a step that names a self-hosted runner writes into its turn (`copyRunner`). */
const turnOn = (h: Harness, runner: { runnerId: string }) =>
  h.enqueueTurn({
    modelChoice: OWN,
    runnerEnvironment: {
      id: runner.runnerId,
      name: "DevBox",
      labels: [runnerLabel(runner.runnerId)],
    },
  });

async function webhookRunner(h: Harness, name: string, workspaceId?: string) {
  const runner = await h.registerRunner({
    labels: ["linux"],
    ...(workspaceId === undefined ? {} : { workspaceId }),
  });
  const stored = await createRunnerCredentialsRepository(h.db, {
    now: h.clock.now,
  }).setDelivery(runner.runnerId, {
    mode: "webhook",
    url: `https://${name}.example.test/dispatch`,
    rotateSecret: false,
    mintKey: () => {
      const key = mintDeliverySecret();
      return {
        ...key,
        sealed: sealDeliverySecret(
          TEST_APP_SECRET,
          runner.runnerId,
          key.secret,
        ),
      };
    },
  });
  if (stored?.mode !== "webhook") throw new Error("delivery not stored");
  return runner;
}

describe("a job of a step that names a self-hosted runner", () => {
  // #1105-R80
  it("requires only that runner's label, and no label of its environment", async () => {
    const h = await start();
    const devbox = await h.registerRunner();
    const turn = await turnOn(h, devbox);

    expect(
      await h.db
        .selectFrom("jobs")
        .select("required_labels")
        .where("id", "=", turn.job.id)
        .executeTakeFirstOrThrow(),
    ).toEqual({ required_labels: `cr:runner:${devbox.runnerId}` });
  });

  // #1105-R81
  it("goes to the named runner and to no other runner of the workspace, whatever its labels", async () => {
    const h = await start();
    const devbox = await h.registerRunner({ labels: ["linux"] });
    const twin = await h.registerRunner({ labels: ["linux"] });
    const turn = await turnOn(h, devbox);

    expect(await claimAs(h, twin)).toBeNull();
    expect(await h.queue.get(turn.job.id)).toMatchObject({ status: "queued" });
    expect(await claimAs(h, devbox)).toBe(turn.job.id);
    expect(await h.queue.get(turn.job.id)).toMatchObject({
      status: "running",
      runnerId: customerRunnerId(devbox.runnerId),
    });
  });

  // #1105-R82
  it("is not taken by a runner that has no such credential even when it claims with the label spelled out: the label is the credential's, never the runner's", async () => {
    const h = await start();
    const devbox = await h.registerRunner();
    const liar = await h.registerRunner();
    await turnOn(h, devbox);

    // The claim drops every `cr:` label a runner announced and adds the one of its own id.
    expect(
      await claimAs(h, liar, ["linux", runnerLabel(devbox.runnerId)]),
    ).toBeNull();
  });

  // #1105-R83
  it("is never taken by the platform identity or a runner of another workspace", async () => {
    const h = await start();
    const other = await addWorkspace(h.db, "other");
    const devbox = await h.registerRunner();
    const foreign = await h.registerRunner({ workspaceId: other });
    const turn = await turnOn(h, devbox);

    expect(await claimAs(h, foreign, ["linux"], other)).toBeNull();
    // The shared token (the Dispatcher's claim, a poll, a claim by id) never takes a runner turn.
    const polled = await h.queue.claimNext("dispatcher", ["implementer"]);
    expect(polled).toBeNull();
    expect(await h.queue.get(turn.job.id)).toMatchObject({ status: "queued" });
  });

  // #1105-R84
  it("rings the named runner's doorbell and no other dispatcher's", async () => {
    const h = await start();
    const devbox = await webhookRunner(h, "devbox");
    const twin = await webhookRunner(h, "twin");
    const turn = await turnOn(h, devbox);

    const due = await createRunnerDispatchesRepository(h.db).listDue(
      h.clock.now(),
      50,
    );

    expect(due.map((pair) => [pair.jobId, pair.runnerId])).toEqual([
      [turn.job.id, devbox.runnerId],
    ]);
    expect(due.map((pair) => pair.runnerId)).not.toContain(twin.runnerId);
  });
});

describe("a job of a step that names a hosted runner", () => {
  // #1105-R85
  it("is a hosted job of the size of its type: the platform takes it, no runner does", async () => {
    const h = await start();
    const devbox = await h.registerRunner();
    const turn = await h.enqueueTurn({
      environment: {
        id: "hosted-4",
        name: "Vercel Sandbox 4 vCPU",
        vcpus: 4,
        setupScript: "",
      },
    });

    expect(
      await h.db
        .selectFrom("jobs")
        .select("required_labels")
        .where("id", "=", turn.job.id)
        .executeTakeFirstOrThrow(),
    ).toEqual({ required_labels: "cr:managed\ncr:size-4" });
    expect(await claimAs(h, devbox)).toBeNull();
  });
});
