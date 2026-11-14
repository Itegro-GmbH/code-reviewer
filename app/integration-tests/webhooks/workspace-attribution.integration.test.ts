// SPDX-License-Identifier: LicenseRef-Proprietary

// A webhook delivery is handled in the workspace its installation is linked to: the handler looks the
// integration up by the installation id (in any workspace) and asks for the collaborators of the
// workspace that integration names.
import { describe, expect, it, vi } from "vitest";
import {
  webhookDelivery,
  webhookFixture,
} from "../../../fakes/github/webhooks.ts";
import { createIntegrationRegistry } from "../../src/integrations/registry.ts";
import { TEST_WEBHOOK_SECRET } from "../../src/test-support/github-app.ts";
import { startWebhookHarness } from "../../src/test-support/webhook-harness.ts";
import { createGithubAppWebhookHandler } from "../../src/webhooks/github-app-handler.ts";

describe("the workspace of a delivery", () => {
  it("is the workspace of the integration the installation id belongs to", async () => {
    const h = await startWebhookHarness();
    const integration = await h.seedInstallation();
    const workspace = vi.fn(() => ({
      projects: h.projects,
      settingsFor: h.settingsFor,
      intake: h.intake,
    }));
    const handler = createGithubAppWebhookHandler({
      registry: createIntegrationRegistry({ github_app: h.provider }),
      tickets: h.tickets,
      integrations: h.directory,
      deliveries: h.deliveries,
      sync: h.sync,
      workspace,
      automatic: h.automatic,
      logger: {
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      },
    });

    const response = await handler(
      webhookDelivery({
        event: "pull_request",
        payload: webhookFixture("pull_request.opened"),
        secret: TEST_WEBHOOK_SECRET,
      }),
    );

    expect(response.status).toBe(202);
    expect(integration.workspaceId).toBe(h.workspaceId);
    expect(workspace).toHaveBeenCalledWith(h.workspaceId);
    expect(h.intake.triggers).toHaveLength(1);
  });

  it("is not asked for when the installation is unknown", async () => {
    const h = await startWebhookHarness();
    const workspace = vi.fn();
    const handler = createGithubAppWebhookHandler({
      registry: createIntegrationRegistry({ github_app: h.provider }),
      tickets: h.tickets,
      integrations: h.directory,
      deliveries: h.deliveries,
      sync: h.sync,
      workspace,
      automatic: h.automatic,
      logger: {
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      },
    });

    const response = await handler(
      webhookDelivery({
        event: "pull_request",
        payload: webhookFixture("pull_request.opened"),
        secret: TEST_WEBHOOK_SECRET,
      }),
    );

    expect(response.status).toBe(202);
    expect(workspace).not.toHaveBeenCalled();
  });
});
