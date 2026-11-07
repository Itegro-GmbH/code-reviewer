// SPDX-License-Identifier: LicenseRef-Proprietary

// The plan page file (#282) with the wiring the running server uses: the database opened at start, the workspace
// access of the person in the address and the real view. Only the session lookup is replaced (it needs Next.js's
// request scope). The page is rendered to markup, which is what a browser first gets: the numbers are in it, the
// navigation lists the page only for a workspace with entitlements, and a workspace the person does not belong to is
// the page of a path that does not exist.
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionLookup } from "../../auth/session-user.ts";
import { createInstanceSettingsRepository } from "../../db/repositories/instance-settings-repository.ts";
import { createWorkspaceEntitlementsRepository } from "../../db/repositories/workspace-entitlements-repository.ts";
import { closeDatabase, getDatabase } from "../../db/startup.ts";
import { signedInMember } from "../../test-support/session-lookup.ts";
import { openRouteTestDatabase } from "../../test-support/test-database.ts";
import { createUsageSeeder } from "../../test-support/usage-seed.ts";
import {
  addWorkspace,
  defaultWorkspaceId,
} from "../../test-support/workspaces.ts";
import type { EntitlementsData } from "../../workspaces/entitlements.ts";

const session = vi.hoisted(() => ({
  currentLookup: vi.fn<() => Promise<SessionLookup>>(),
}));
vi.mock("@/auth/session", () => ({ currentLookup: session.currentLookup }));
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  usePathname: () => "/w/default/settings/plan",
  useRouter: () => ({ refresh: () => undefined, replace: () => undefined }),
}));

import PlanSettingsPage from "../../app/(app)/w/[workspace]/settings/plan/page.tsx";

const ENTITLEMENTS: EntitlementsData = {
  planLabel: "Team",
  keyMode: "managed",
  limits: {
    diffRunsPerPeriod: 5,
    dynamicRunsPerPeriod: 2,
    managedCostLimitMicroUsd: 10_000_000,
    ownKeyCostLimitMicroUsd: null,
  },
  periodStart: "2026-10-01T00:00:00.000Z",
  suspended: false,
  suspensionCode: null,
};

async function start(role: "member" | "admin" | "owner" = "member") {
  await openRouteTestDatabase();
  const db = getDatabase();
  const workspaceId = await defaultWorkspaceId(db);
  session.currentLookup.mockResolvedValue(
    await signedInMember(db, { workspaceId, role }),
  );
  return { db, workspaceId };
}

async function html(workspace = "default"): Promise<string> {
  const element = await PlanSettingsPage({
    params: Promise.resolve({ workspace }),
  } as Parameters<typeof PlanSettingsPage>[0]);
  return renderToStaticMarkup(element);
}

afterEach(async () => {
  await closeDatabase();
});

describe("the plan page file", () => {
  // #282-T01
  it("says that no limits apply for a workspace without entitlements, and the navigation has no Plan entry", async () => {
    await start();

    const markup = await html();

    expect(markup).toContain("No limits apply to this workspace.");
    expect(markup).not.toContain(">Plan</a>");
  });

  // #282-T02, #282-T04
  it("shows the counts and the percentage of a workspace with limits, and lists the page in the navigation", async () => {
    const { db, workspaceId } = await start();
    await createWorkspaceEntitlementsRepository(db, workspaceId).put(
      ENTITLEMENTS,
      null,
    );
    const seeder = createUsageSeeder(db);
    for (const costMicroUsd of [3_000_000, 3_200_000])
      await seeder.seed({
        workspaceId,
        reservedAt: "2026-10-05T10:00:00.000Z",
        keyMode: "managed",
        costMicroUsd,
      });

    const markup = await html();

    expect(markup).toContain("2 of 5");
    expect(markup).toContain("0 of 2");
    expect(markup).toContain("62 % of the usage limit used");
    expect(markup).toContain(">Plan</a>");
    expect(markup).not.toMatch(/6200000|10000000|6\.2|\$|USD/);
  });

  // #361 (plan page)
  it("shows the percentage of the own-key cost limit, with the unknown runs apart and no amount, for a workspace on its own key", async () => {
    const { db, workspaceId } = await start();
    await createWorkspaceEntitlementsRepository(db, workspaceId).put(
      {
        ...ENTITLEMENTS,
        keyMode: "own",
        limits: {
          ...ENTITLEMENTS.limits,
          managedCostLimitMicroUsd: null,
          ownKeyCostLimitMicroUsd: 10_000_000,
        },
      },
      null,
    );
    const seeder = createUsageSeeder(db);
    for (const costMicroUsd of [3_000_000, 3_200_000, null])
      await seeder.seed({
        workspaceId,
        reservedAt: "2026-10-05T10:00:00.000Z",
        keyMode: "own",
        costMicroUsd,
      });

    const markup = await html();

    expect(markup).toContain("62 % of the usage limit used");
    expect(markup).toContain("1 finished review could not be measured");
    expect(markup).toContain("not exact");
    expect(markup).not.toContain("billed via code-review.com");
    expect(markup).not.toMatch(/6200000|10000000|6\.2|\$|USD/);
  });

  // #282-T06
  it("shows the pause notice and no reason", async () => {
    const { db, workspaceId } = await start();
    await createWorkspaceEntitlementsRepository(db, workspaceId).put(
      { ...ENTITLEMENTS, suspended: true, suspensionCode: "overdue" },
      null,
    );

    const markup = await html();

    expect(markup).toContain("Reviews are paused for this workspace.");
    expect(markup).not.toContain("overdue");
  });

  it("offers Manage plan to an Admin while the instance has a plan page, and not to a Member", async () => {
    const { db, workspaceId } = await start("admin");
    await createWorkspaceEntitlementsRepository(db, workspaceId).put(
      ENTITLEMENTS,
      null,
    );

    expect(await html()).not.toContain("Manage plan");

    await createInstanceSettingsRepository(db).set(
      "plan_management_url",
      "https://plans.example.com/manage",
      null,
    );
    const asAdmin = await html();
    expect(asAdmin).toContain("Manage plan");
    expect(asAdmin).toContain('action="/api/w/default/plan-handoff"');
    expect(asAdmin).not.toContain("plans.example.com");

    session.currentLookup.mockResolvedValue(
      await signedInMember(db, {
        id: "plain-member",
        workspaceId,
        role: "member",
      }),
    );
    expect(await html()).not.toContain("Manage plan");
  });

  // #282-T07
  it("is the page of a path that does not exist for a person of another workspace", async () => {
    const { db } = await start();
    const otherId = await addWorkspace(db, "other");
    await createWorkspaceEntitlementsRepository(db, otherId).put(
      ENTITLEMENTS,
      null,
    );

    for (const workspace of ["other", "no-such-workspace"])
      await expect(html(workspace)).rejects.toMatchObject({
        digest: expect.stringContaining("404"),
      });
  });
});
