// SPDX-License-Identifier: LicenseRef-Proprietary

// The ticket mirror in the webhook handler (#923): which events reach it, what the delivery is answered, and that a failure of the mirror
// never costs a review or a workflow its start. The handler is wired to the real GitHub provider (the events are read by it) and to
// recording fakes for everything behind it.
import { describe, expect, it, vi } from "vitest";
import {
  webhookDelivery,
  webhookFixture,
} from "../../../fakes/github/webhooks.ts";
import { fakeGithubAppClient } from "../integrations/providers/github-app/fake-client.ts";
import { loadGithubAppConfig } from "../integrations/providers/github-app/config.ts";
import { createGithubAppProvider } from "../integrations/providers/github-app/provider.ts";
import type { TrackerChange } from "../integrations/types.ts";
import { fakeIntegration } from "../test-support/fake-integration-provider.ts";
import {
  TEST_WEBHOOK_SECRET,
  testGithubAppEnv,
} from "../test-support/github-app.ts";
import type { TrackerMirror } from "../tracker/mirror.ts";
import {
  createGithubAppWebhookHandler,
  type WorkflowStarter,
} from "./github-app-handler.ts";

const integration = fakeIntegration({
  id: "integration-1",
  workspaceId: "w-1",
  externalId: "4242",
});

function setup(
  options: {
    mirror?: TrackerMirror | undefined;
    workflows?: WorkflowStarter | undefined;
  } = {},
) {
  const provider = createGithubAppProvider({
    config: loadGithubAppConfig(testGithubAppEnv()),
    client: fakeGithubAppClient({}),
  });
  const completed: string[] = [];
  const released: string[] = [];
  const logs: string[] = [];
  const handler = createGithubAppWebhookHandler({
    registry: { resolve: () => provider } as never,
    integrations: { findByExternalId: async () => integration },
    deliveries: {
      claim: async () => ({ status: "claimed", token: "claim-1" }),
      complete: async (_id: string, _token: string, outcome: string) => {
        completed.push(outcome);
      },
      release: async (id: string) => {
        released.push(id);
      },
    } as never,
    sync: { handleInstallationChange: async () => ({ outcome: "unclaimed" }) } as never,
    workspace: () => ({
      projects: { hasActiveProject: async () => true },
      settingsFor: async () => undefined,
      intake: {} as never,
      ...(options.mirror === undefined ? {} : { tracker: options.mirror }),
      ...(options.workflows === undefined ? {} : { workflows: options.workflows }),
    }),
    automatic: {},
    logger: {
      info: (line: string) => logs.push(line),
      error: (line: string) => logs.push(line),
    },
  });
  const send = async (event: string, payload: unknown) => {
    const response = await handler(
      webhookDelivery({ event, payload, secret: TEST_WEBHOOK_SECRET }),
    );
    return {
      status: response.status,
      body: (await response.json()) as { outcome?: string; error?: string },
    };
  };
  return { send, completed, released, logs };
}

/** A mirror that records what it is given and answers `outcome`. */
function mirror(outcome: "updated" | "not_mirrored" = "updated") {
  const changes: TrackerChange[] = [];
  const port: TrackerMirror = {
    apply: async (_integration, change) => {
      changes.push(change);
      return outcome;
    },
  };
  return { changes, port };
}

describe("the events only the ticket mirror reads", () => {
  // #923-T44
  it.each([
    ["sub_issues", "sub_issues.sub_issue_added", "parent_changed"],
    ["projects_v2_item", "projects_v2_item.edited", "board_status_changed"],
    ["check_suite", "check_suite.completed", "checks_changed"],
  ])("%s updates the mirror and is answered tracker_updated", async (event, fixture, kind) => {
    const recorded = mirror();
    const { send, completed } = setup({ mirror: recorded.port });

    const answer = await send(event, webhookFixture(fixture));

    expect(answer).toEqual({ status: 202, body: { status: "accepted", outcome: "tracker_updated" } });
    expect(recorded.changes.map((change) => change.kind)).toEqual([kind]);
    expect(completed).toEqual(["tracker_updated"]);
  });

  // #923-T45
  it("answers ignored when the mirror takes nothing from the delivery", async () => {
    const { send } = setup({ mirror: mirror("not_mirrored").port });

    expect(await send("check_suite", webhookFixture("check_suite.completed"))).toMatchObject({
      status: 202,
      body: { outcome: "ignored" },
    });
    expect(
      await send("check_suite", webhookFixture("check_suite.completed.no-pull-request")),
    ).toMatchObject({ body: { outcome: "ignored" } });
  });

  // #923-T46
  it("is ignored by a server that has no mirror", async () => {
    const { send } = setup();

    expect(await send("check_suite", webhookFixture("check_suite.completed"))).toMatchObject({
      status: 202,
      body: { outcome: "ignored" },
    });
  });

  // #923-T47
  it("fails the delivery when the mirror cannot be written, so that GitHub can redeliver it", async () => {
    const { send, released, completed, logs } = setup({
      mirror: {
        apply: async () => {
          throw Object.assign(new Error("connection string with secret"), { code: "ECONNRESET" });
        },
      },
    });

    const answer = await send("check_suite", webhookFixture("check_suite.completed"));

    expect(answer).toEqual({ status: 503, body: { error: "WEBHOOK_PROCESSING_FAILED" } });
    expect(released).toHaveLength(1);
    expect(completed).toEqual([]);
    expect(logs.join("\n")).toContain("ECONNRESET");
    expect(logs.join("\n")).not.toContain("secret");
  });

  // #923-T48
  it("is not an event of an installation that is switched off", async () => {
    const recorded = mirror();
    const provider = createGithubAppProvider({
      config: loadGithubAppConfig(testGithubAppEnv()),
      client: fakeGithubAppClient({}),
    });
    const handler = createGithubAppWebhookHandler({
      registry: { resolve: () => provider } as never,
      integrations: { findByExternalId: async () => ({ ...integration, status: "disabled" }) },
      deliveries: {
        claim: async () => ({ status: "claimed", token: "t" }),
        complete: async () => undefined,
        release: async () => undefined,
      } as never,
      sync: { handleInstallationChange: async () => ({ outcome: "unclaimed" }) } as never,
      workspace: () => ({
        projects: { hasActiveProject: async () => true },
        settingsFor: async () => undefined,
        intake: {} as never,
        tracker: recorded.port,
      }),
      automatic: {},
      logger: { info: () => undefined, error: () => undefined },
    });

    const response = await handler(
      webhookDelivery({
        event: "check_suite",
        payload: webhookFixture("check_suite.completed"),
        secret: TEST_WEBHOOK_SECRET,
      }),
    );

    expect((await response.json()) as { outcome: string }).toMatchObject({ outcome: "integration_disabled" });
    expect(recorded.changes).toEqual([]);
  });
});

describe("the events the ticket mirror shares with the reviews and the workflows", () => {
  // #923-T49
  it("writes the issue of an action that starts nothing, and answers tracker_updated for it", async () => {
    const recorded = mirror();
    const { send } = setup({ mirror: recorded.port });

    const answer = await send("issues", webhookFixture("issues.edited.mirror"));

    expect(answer.body.outcome).toBe("tracker_updated");
    expect(recorded.changes).toMatchObject([{ kind: "item_changed", item: { number: 12 } }]);
  });

  // #923-T50
  it("still starts the workflows of a label that the mirror has also heard", async () => {
    const recorded = mirror();
    const start = vi.fn(async () => ({ matched: 1, started: 1, existing: 0, skipped: 0, busy: 0 }));
    const { send } = setup({ mirror: recorded.port, workflows: { start } });

    const answer = await send("issues", {
      ...webhookFixture("issues.edited.mirror"),
      action: "labeled",
      label: { name: "ready for agent" },
    });

    expect(answer.body.outcome).toBe("workflow_runs_started");
    expect(start).toHaveBeenCalledTimes(1);
    expect(recorded.changes).toHaveLength(1);
  });

  // #923-T51
  it("never lets a failure of the mirror stop what else the delivery does", async () => {
    const start = vi.fn(async () => ({ matched: 1, started: 1, existing: 0, skipped: 0, busy: 0 }));
    const { send, logs } = setup({
      mirror: { apply: async () => { throw new Error("database down"); } },
      workflows: { start },
    });

    const labeled = await send("issues", {
      ...webhookFixture("issues.edited.mirror"),
      action: "labeled",
      label: { name: "ready for agent" },
    });
    const edited = await send("issues", webhookFixture("issues.edited.mirror"));

    expect(labeled.body.outcome).toBe("workflow_runs_started");
    expect(edited).toMatchObject({ status: 202, body: { outcome: "ignored" } });
    expect(logs.filter((line) => line.includes("ticket mirror could not be updated"))).toHaveLength(2);
  });

  // #923-T52
  it("leaves a payload the mirror cannot read to what else the delivery does", async () => {
    const recorded = mirror();
    const { send, logs } = setup({ mirror: recorded.port });

    // The payloads written for the reviews are reduced to what they read: no node id, no time of the last change.
    const answer = await send("issues", webhookFixture("issues.opened"));

    expect(answer.status).toBe(202);
    expect(recorded.changes).toEqual([]);
    expect(logs.join("\n")).toContain("the ticket mirror takes nothing from it");
  });

  // #923-T53
  it("takes a pull request into the mirror and still hands it to the review policy", async () => {
    const recorded = mirror();
    const { send } = setup({ mirror: recorded.port });

    const answer = await send(
      "pull_request",
      webhookFixture("pull_request.synchronize.mirror"),
    );

    expect(recorded.changes).toMatchObject([
      { kind: "item_changed", resetChecks: true, item: { number: 7, kind: "pull_request" } },
    ]);
    // The project has no settings in this setup: the review path ran after the mirror and said so.
    expect(answer.body.outcome).toBe("project_not_active");
  });
});
