// SPDX-License-Identifier: LicenseRef-Proprietary

// The lane conversion of release A (#1105, ADR 0007) against a real Postgres: lanes with a profile and an environment get a new version with
// the values inline, written by the validator of a save; a lane that cannot be converted keeps its version and is listed; a dry run writes
// nothing; a second run changes nothing; runs and older versions are never touched; and a workspace never sees another's data.
import { describe, expect, it } from "vitest";
import type { Kysely } from "kysely";
import { createImplementerEnvironmentsRepository } from "../db/repositories/implementer-environments-repository.ts";
import { createNamedRunnersRepository } from "../db/repositories/named-runners-repository.ts";
import { createProfilesRepository } from "../db/repositories/profiles-repository.ts";
import { createProjectsRepository } from "../db/repositories/projects-repository.ts";
import {
  createRunnerCredentialsRepository,
  type NewRunner,
} from "../db/repositories/runner-credentials-repository.ts";
import { createRunnersRepository } from "../db/repositories/runners-repository.ts";
import { createWorkflowsRepository } from "../db/repositories/workflows-repository.ts";
import type { Database } from "../db/schema.ts";
import { seedImplementerRepository } from "../test-support/implementer.ts";
import { createTestDatabase } from "../test-support/test-database.ts";
import { addUser } from "../test-support/workspace-deletion-fixture.ts";
import {
  addWorkspace,
  defaultWorkspaceId,
} from "../test-support/workspaces.ts";
import { runLaneConversionCommand } from "./cli.ts";
import { CONVERSION_CHANGE_DESCRIPTION } from "./convert.ts";
import { LaneConversionError, runLaneConversion } from "./run.ts";

/**
 * The database with a hook on its first select that `match` recognises (the node of the query as JSON): `before` runs when the query is
 * built and may throw (the query then fails), `after` runs once the query has its result and before the caller sees it. It is how a test
 * makes somebody else act, or the database fail, at one exact moment of the run.
 */
function hooked(
  db: Kysely<Database>,
  hook: {
    match: (node: string) => boolean;
    before?: () => void;
    after?: () => Promise<void>;
  },
): Kysely<Database> {
  let fired = false;
  const marked = new Set<string>();
  return db.withPlugin({
    transformQuery({ node, queryId }) {
      if (
        !fired &&
        node.kind === "SelectQueryNode" &&
        hook.match(JSON.stringify(node))
      ) {
        fired = true;
        marked.add(queryId.queryId);
        hook.before?.();
      }
      return node;
    },
    async transformResult({ result, queryId }) {
      if (marked.has(queryId.queryId)) await hook.after?.();
      return result;
    },
  });
}

const OWN_KEY_MODEL = { provider: "openai", model: "gpt-5" };
const MANAGED_MODEL = { entryId: "entry-1" };

const profileContent = (extra: Record<string, unknown> = {}) => ({
  description: "Writes the change.",
  model: MANAGED_MODEL,
  instructions: "Be careful.",
  costLimitCents: 700,
  canPush: true,
  defaultResult: null,
  ...extra,
});

const oldLane = (
  name: string,
  agent: Record<string, unknown> = {},
): Record<string, unknown> => ({
  version: 1,
  name,
  description: "A lane.",
  triggers: [{ id: "manual", kind: "manual", steps: [] }],
  steps: [
    {
      id: "implement",
      kind: "agent",
      profile: "implementer",
      instruction: "Do it.",
      ...agent,
    },
  ],
});

let tokens = 0;
/** A self-hosted runner with the labels, registered as a person would. */
async function registerRunner(
  db: Kysely<Database>,
  workspaceId: string,
  name: string,
  labels: string[],
): Promise<string> {
  const options = { now: () => new Date("2026-11-21T10:00:00.000Z") };
  const hash = `token-${++tokens}`;
  await createRunnersRepository(db, workspaceId, options).createToken(
    {
      tokenHash: hash,
      createdBy: "u-1",
      expiresAt: new Date("2026-11-21T11:00:00.000Z"),
    },
    20,
  );
  const runner: NewRunner = {
    name,
    labels,
    baseVersion: "1.2.0",
    manifest: { harnesses: [], capabilities: [] },
    limits: {},
    credentialHash: `credential-${tokens}`,
  };
  const registered = await createRunnerCredentialsRepository(
    db,
    options,
  ).redeem(hash, runner);
  if (registered === undefined || !("runner" in registered))
    throw new Error("registering the runner failed");
  return (registered as { runner: { id: string } }).runner.id;
}

async function setup() {
  const { db, url } = await createTestDatabase();
  await addUser(db, "u-1");
  await addUser(db, "u-author");
  const idA = await defaultWorkspaceId(db);
  const idB = await addWorkspace(db, "other");
  const seededA = await seedImplementerRepository(db, idA, "a");
  const seededB = await seedImplementerRepository(db, idB, "b");
  const projectA = (
    await createProjectsRepository(db, idA).get(seededA.repositoryId)
  )?.id as string;
  const projectB = (
    await createProjectsRepository(db, idB).get(seededB.repositoryId)
  )?.id as string;
  const nodeA = await createImplementerEnvironmentsRepository(db, idA).create(
    {
      name: "node",
      vcpus: 4,
      setupScript: "npm ci",
      network: { mode: "list", hosts: ["registry.npmjs.org"] },
      createdBy: "u-1",
    },
    50,
  );
  if (!nodeA.ok) throw new Error("environment");
  const tinyA = await createImplementerEnvironmentsRepository(db, idA).create(
    { name: "tiny", vcpus: 2, setupScript: "", createdBy: "u-1" },
    50,
  );
  if (!tinyA.ok) throw new Error("environment");
  const nodeB = await createImplementerEnvironmentsRepository(db, idB).create(
    { name: "node", vcpus: 8, setupScript: "", createdBy: "u-1" },
    50,
  );
  if (!nodeB.ok) throw new Error("environment");
  const profilesA = createProfilesRepository(db, idA);
  await profilesA.create(
    {
      name: "implementer",
      content: profileContent({ environmentId: nodeA.environment.id }),
      createdBy: "u-1",
    },
    100,
  );
  await createProfilesRepository(db, idB).create(
    {
      name: "implementer",
      content: profileContent({ environmentId: nodeB.environment.id }),
      createdBy: "u-1",
    },
    100,
  );
  return {
    db,
    url,
    idA,
    idB,
    projectA,
    projectB,
    nodeA: nodeA.environment,
    tinyA: tinyA.environment,
    profilesA,
    workflowsA: createWorkflowsRepository(db, idA),
    workflowsB: createWorkflowsRepository(db, idB),
    runnersA: createNamedRunnersRepository(db, idA),
    runnersB: createNamedRunnersRepository(db, idB),
  };
}

type World = Awaited<ReturnType<typeof setup>>;

async function addLane(
  workflows: ReturnType<typeof createWorkflowsRepository>,
  projectId: string | undefined,
  document: Record<string, unknown>,
  author = "u-author",
) {
  const created = await workflows.create(
    {
      name: document.name as string,
      document: JSON.stringify(document),
      createdBy: author,
      ...(projectId === undefined ? {} : { projectId }),
    },
    100,
  );
  if (!created.ok) throw new Error("lane");
  return created.workflow.id;
}

const hostedId = async (w: World, vcpus: number): Promise<string> =>
  (await w.runnersA.list()).find(
    (runner) => runner.kind === "hosted" && runner.vcpus === vcpus,
  )?.id as string;

describe("the lane conversion against Postgres", () => {
  // #1105-T300
  it("writes a new version with the profile values and the hosted runner inline, by the author of the replaced version, and leaves the old version as saved", async () => {
    const w = await setup();
    const original = oldLane("Issue to PR");
    const id = await addLane(w.workflowsA, w.projectA, original);

    const report = await runLaneConversion({
      db: w.db,
      dryRun: false,
      workspaceId: w.idA,
    });

    expect(report.notConverted).toEqual([]);
    expect(report.lanes).toMatchObject([
      { laneId: id, outcome: "converted", version: 2, steps: 1 },
    ]);
    const found = await w.workflowsA.get(id);
    expect(found?.workflow.version).toBe(2);
    expect(found?.current.createdBy).toBe("u-author");
    expect(found?.current.changeDescription).toBe(
      CONVERSION_CHANGE_DESCRIPTION,
    );
    expect(JSON.parse(found?.current.document ?? "")).toEqual({
      ...original,
      steps: [
        {
          id: "implement",
          description: "Writes the change.",
          kind: "agent",
          harness: "opencode",
          model: MANAGED_MODEL,
          canPush: true,
          instructions: "Be careful.",
          runner: await hostedId(w, 4),
          setupScript: "npm ci",
          network: { mode: "list", hosts: ["registry.npmjs.org"] },
          instruction: "Do it.",
        },
      ],
    });
    expect((await w.workflowsA.getVersion(id, 1))?.document).toBe(
      JSON.stringify(original),
    );
  });

  // #1105-T301
  it("is idempotent: a second run skips the converted lane and writes no version", async () => {
    const w = await setup();
    const id = await addLane(w.workflowsA, w.projectA, oldLane("Lane"));
    await runLaneConversion({ db: w.db, dryRun: false });

    const again = await runLaneConversion({ db: w.db, dryRun: false });

    expect(again.lanes.map((lane) => lane.outcome)).toEqual(["already_inline"]);
    expect(again.counts.converted).toBe(0);
    expect((await w.workflowsA.get(id))?.workflow.version).toBe(2);
    expect(await w.workflowsA.listVersions(id)).toHaveLength(2);
  });

  // #1105-T302
  it("reports a dry run and writes nothing", async () => {
    const w = await setup();
    const id = await addLane(w.workflowsA, w.projectA, oldLane("Lane"));
    const orphan = await addLane(w.workflowsA, undefined, oldLane("Orphan"));

    const report = await runLaneConversion({ db: w.db, dryRun: true });

    expect(report.dryRun).toBe(true);
    expect(report.lanes.find((lane) => lane.laneId === id)).toMatchObject({
      outcome: "would_convert",
      version: 2,
    });
    expect(report.lanes.find((lane) => lane.laneId === orphan)?.outcome).toBe(
      "would_archive_without_project",
    );
    expect((await w.workflowsA.get(id))?.workflow.version).toBe(1);
    expect((await w.workflowsA.get(orphan))?.workflow.archivedAt).toBeNull();
  });

  // #1105-T303
  it("lists a lane whose profile is archived, with its reason, and keeps its version", async () => {
    const w = await setup();
    const id = await addLane(
      w.workflowsA,
      w.projectA,
      oldLane("Lane", { profile: "gone" }),
    );
    const gone = await w.profilesA.create(
      { name: "gone", content: profileContent(), createdBy: "u-1" },
      100,
    );
    if (!gone.ok) throw new Error("profile");
    await w.profilesA.archive(gone.profile.id, 100);

    const report = await runLaneConversion({
      db: w.db,
      dryRun: false,
      workspaceId: w.idA,
    });

    expect(report.notConverted).toMatchObject([
      {
        laneId: id,
        workspaceId: w.idA,
        reasons: [{ code: "profile_archived", stepId: "implement" }],
      },
    ]);
    expect((await w.workflowsA.get(id))?.workflow.version).toBe(1);
  });

  // #1105-T304
  it("writes the default result of the profile into a step that declared none", async () => {
    const w = await setup();
    const schema = {
      type: "object",
      required: ["summary"],
      properties: { summary: { type: "string" } },
    };
    await w.profilesA.create(
      {
        name: "reporter",
        content: profileContent({
          environmentId: w.nodeA.id,
          defaultResult: JSON.stringify(schema),
        }),
        createdBy: "u-1",
      },
      100,
    );
    const id = await addLane(
      w.workflowsA,
      w.projectA,
      oldLane("Lane", { profile: "reporter@1" }),
    );

    await runLaneConversion({ db: w.db, dryRun: false, workspaceId: w.idA });

    const document = JSON.parse(
      (await w.workflowsA.get(id))?.current.document ?? "",
    ) as { steps: { result?: unknown; costLimitCents?: unknown }[] };
    expect(document.steps[0]?.result).toEqual(schema);
    expect(document.steps[0]).not.toHaveProperty("costLimitCents");
  });

  // #1105-T305
  it("lists a lane whose environment has a size no hosted runner offers", async () => {
    const w = await setup();
    await w.db
      .updateTable("implementer_environments")
      .set({ vcpus: 1 })
      .where("id", "=", w.tinyA.id)
      .execute();
    await w.profilesA.create(
      {
        name: "tiny",
        content: profileContent({ environmentId: w.tinyA.id }),
        createdBy: "u-1",
      },
      100,
    );
    const id = await addLane(
      w.workflowsA,
      w.projectA,
      oldLane("Lane", { profile: "tiny" }),
    );

    const report = await runLaneConversion({
      db: w.db,
      dryRun: false,
      workspaceId: w.idA,
    });

    expect(report.notConverted).toMatchObject([
      {
        laneId: id,
        reasons: [{ code: "environment_size_unsupported" }],
      },
    ]);
  });

  describe("an environment of a runner", () => {
    async function runnerLane(w: World, profileName: string) {
      const env = await createImplementerEnvironmentsRepository(
        w.db,
        w.idA,
      ).create(
        {
          kind: "runner",
          name: "devbox",
          labels: ["devbox"],
          createdBy: "u-1",
        },
        50,
      );
      if (!env.ok) throw new Error("environment");
      await w.profilesA.create(
        {
          name: profileName,
          content: profileContent({
            environmentId: env.environment.id,
            model: OWN_KEY_MODEL,
          }),
          createdBy: "u-1",
        },
        100,
      );
      return addLane(
        w.workflowsA,
        w.projectA,
        oldLane("Lane", { profile: profileName }),
      );
    }

    // #1105-T306
    it("becomes the one self-hosted runner that has all the labels", async () => {
      const w = await setup();
      const id = await runnerLane(w, "devbox-profile");
      const runnerId = await registerRunner(w.db, w.idA, "DevBox", [
        "devbox",
        "linux",
      ]);
      await registerRunner(w.db, w.idA, "Other", ["linux"]);

      const report = await runLaneConversion({
        db: w.db,
        dryRun: false,
        workspaceId: w.idA,
      });

      expect(report.notConverted).toEqual([]);
      const document = JSON.parse(
        (await w.workflowsA.get(id))?.current.document ?? "",
      ) as { steps: Record<string, unknown>[] };
      expect(document.steps[0]).toMatchObject({
        runner: runnerId,
        model: OWN_KEY_MODEL,
      });
      expect(document.steps[0]).not.toHaveProperty("setupScript");
    });

    // #1105-T307
    it("lists the lane with its candidates when several runners match, and with none when none does", async () => {
      const w = await setup();
      const id = await runnerLane(w, "devbox-profile");
      const none = await runLaneConversion({
        db: w.db,
        dryRun: false,
        workspaceId: w.idA,
      });
      const first = await registerRunner(w.db, w.idA, "DevBox A", ["devbox"]);
      const second = await registerRunner(w.db, w.idA, "DevBox B", ["devbox"]);
      const several = await runLaneConversion({
        db: w.db,
        dryRun: false,
        workspaceId: w.idA,
      });

      expect(none.notConverted[0]?.reasons).toMatchObject([
        { code: "runner_none_match", candidates: [] },
      ]);
      expect(several.notConverted[0]?.reasons).toMatchObject([
        {
          code: "runner_several_match",
          candidates: expect.arrayContaining([
            { id: first, name: "DevBox A" },
            { id: second, name: "DevBox B" },
          ]) as unknown[],
        },
      ]);
      expect((await w.workflowsA.get(id))?.workflow.version).toBe(1);
    });

    // #1105-T308
    it("is listed with the validator's issue codes when the converted step does not pass: a managed model on a runner", async () => {
      const w = await setup();
      const env = await createImplementerEnvironmentsRepository(
        w.db,
        w.idA,
      ).create(
        {
          kind: "runner",
          name: "devbox",
          labels: ["devbox"],
          createdBy: "u-1",
        },
        50,
      );
      if (!env.ok) throw new Error("environment");
      await w.profilesA.create(
        {
          name: "managed-on-runner",
          // A managed model on a runner: the old pair was refused when the profile was saved, the data may still say it.
          content: profileContent({ environmentId: env.environment.id }),
          createdBy: "u-1",
        },
        100,
      );
      await registerRunner(w.db, w.idA, "DevBox", ["devbox"]);
      const id = await addLane(
        w.workflowsA,
        w.projectA,
        oldLane("Lane", { profile: "managed-on-runner" }),
      );

      const report = await runLaneConversion({
        db: w.db,
        dryRun: false,
        workspaceId: w.idA,
      });

      expect(report.notConverted).toMatchObject([
        {
          laneId: id,
          reasons: [
            {
              code: "validation_failed",
              issues: [{ code: "runner_needs_own_key" }],
            },
          ],
        },
      ]);
      expect((await w.workflowsA.get(id))?.workflow.version).toBe(1);
    });
  });

  // #1105-T311
  it('converts the lane the built-in "Issue to PR" used to be: a loop of an implementer that continues its session and a reviewer that may not push, and the result passes the validator', async () => {
    const w = await setup();
    await w.profilesA.create(
      {
        name: "reviewer",
        content: profileContent({
          environmentId: w.nodeA.id,
          canPush: false,
          instructions: "",
          description: "",
        }),
        createdBy: "u-1",
      },
      100,
    );
    const document = {
      version: 1,
      name: "Issue to PR",
      description: "Implement, review, fix.",
      triggers: [{ id: "manual", kind: "manual", steps: [] }],
      steps: [
        {
          id: "fix",
          kind: "loop",
          maxRounds: 3,
          body: [
            {
              id: "implement",
              kind: "agent",
              profile: "implementer@1",
              environment: "node",
              session: { continue: "implement" },
              instruction: {
                first: "Do it.",
                next: "Fix {{previous.review.findings}}",
              },
              result: {
                type: "object",
                required: ["summary"],
                properties: { summary: { type: "string" } },
              },
            },
            {
              id: "review",
              kind: "agent",
              profile: "reviewer@1",
              environment: "node",
              session: "new",
              branch: "{{implement.branch}}",
              instruction: "Review {{implement.branch}}.",
              result: {
                type: "object",
                required: ["findings"],
                properties: {
                  findings: {
                    type: "array",
                    maxItems: 20,
                    items: { type: "string" },
                  },
                },
              },
            },
          ],
          until: { empty: "{{review.findings}}" },
        },
      ],
    };
    const id = await addLane(w.workflowsA, w.projectA, document);

    const report = await runLaneConversion({
      db: w.db,
      dryRun: false,
      workspaceId: w.idA,
    });

    expect(report.notConverted).toEqual([]);
    expect(report.lanes).toMatchObject([
      { laneId: id, outcome: "converted", steps: 2 },
    ]);
    const body = (
      JSON.parse((await w.workflowsA.get(id))?.current.document ?? "") as {
        steps: { body: Record<string, unknown>[] }[];
      }
    ).steps[0]?.body;
    expect(body?.[0]).toMatchObject({
      canPush: true,
      runner: await hostedId(w, 4),
      session: { continue: "implement" },
    });
    expect(body?.[1]).toMatchObject({
      canPush: false,
      runner: await hostedId(w, 4),
      branch: "{{implement.branch}}",
    });
    expect(body?.[1]).not.toHaveProperty("instructions");
  });

  // #1105-T309
  it("archives a lane without a project and lists it, and leaves archived lanes alone", async () => {
    const w = await setup();
    const orphan = await addLane(w.workflowsA, undefined, oldLane("Orphan"));
    const archived = await addLane(
      w.workflowsA,
      w.projectA,
      oldLane("Archived"),
    );
    await w.workflowsA.archive(archived, 100);

    const report = await runLaneConversion({
      db: w.db,
      dryRun: false,
      workspaceId: w.idA,
    });

    expect(report.archivedWithoutProject).toMatchObject([
      { laneId: orphan, outcome: "archived_without_project" },
    ]);
    expect(report.notConverted).toEqual([]);
    expect(
      (await w.workflowsA.get(orphan))?.workflow.archivedAt,
    ).not.toBeNull();
    expect((await w.workflowsA.get(archived))?.workflow.version).toBe(1);
    expect(report.lanes.map((lane) => lane.laneId)).not.toContain(archived);
  });

  // #1105-T310
  it("keeps each workspace to its own profiles, environments and runners", async () => {
    const w = await setup();
    const a = await addLane(w.workflowsA, w.projectA, oldLane("Lane"));
    const b = await addLane(w.workflowsB, w.projectB, oldLane("Lane"));

    await runLaneConversion({ db: w.db, dryRun: false });

    const stepA = (
      JSON.parse((await w.workflowsA.get(a))?.current.document ?? "") as {
        steps: { runner: string }[];
      }
    ).steps[0];
    const stepB = (
      JSON.parse((await w.workflowsB.get(b))?.current.document ?? "") as {
        steps: { runner: string }[];
      }
    ).steps[0];
    const hostedB = (await w.runnersB.list()).find(
      (runner) => runner.kind === "hosted" && runner.vcpus === 8,
    );
    expect(stepA?.runner).toBe(await hostedId(w, 4));
    expect(stepB?.runner).toBe(hostedB?.id);
    expect(stepA?.runner).not.toBe(stepB?.runner);
  });

  // #1105-T340
  it("lists a lane that somebody saved while it was converted as version_conflict, keeps the rival's version and writes nothing over it", async () => {
    const w = await setup();
    const id = await addLane(w.workflowsA, w.projectA, oldLane("Lane"));
    const rival = oldLane("Lane", { instruction: "Rival." });
    const db = hooked(w.db, {
      // The environments are read after the lane was read and before it is saved.
      match: (node) => node.includes('"name":"implementer_environments"'),
      after: async () => {
        await w.workflowsA.saveVersion(
          id,
          {
            name: "Lane",
            document: JSON.stringify(rival),
            createdBy: "u-author",
            changeDescription: "A person saved",
          },
          500,
        );
      },
    });

    const report = await runLaneConversion({
      db,
      dryRun: false,
      workspaceId: w.idA,
    });

    expect(report.notConverted).toMatchObject([
      { laneId: id, reasons: [{ code: "version_conflict" }] },
    ]);
    expect(report.counts.converted).toBe(0);
    const found = await w.workflowsA.get(id);
    expect(found?.workflow.version).toBe(2);
    expect(JSON.parse(found?.current.document ?? "")).toEqual(rival);
  });

  // #1105-T341
  it("lists a lane that holds the most versions it may as version_limit_reached and keeps it as it is", async () => {
    const w = await setup();
    const document = oldLane("Lane");
    const id = await addLane(w.workflowsA, w.projectA, document);
    for (let version = 2; version <= 500; version += 1)
      await w.workflowsA.saveVersion(
        id,
        {
          name: "Lane",
          document: JSON.stringify(document),
          createdBy: "u-author",
        },
        500,
      );

    const report = await runLaneConversion({
      db: w.db,
      dryRun: false,
      workspaceId: w.idA,
    });

    expect(report.notConverted).toMatchObject([
      { laneId: id, reasons: [{ code: "version_limit_reached" }] },
    ]);
    expect((await w.workflowsA.get(id))?.workflow.version).toBe(500);
  }, 60_000);

  // #1105-T342
  it("lists a lane whose stored document is not JSON as document_unreadable and keeps it", async () => {
    const w = await setup();
    const created = await w.workflowsA.create(
      {
        name: "Broken",
        document: "this is not json",
        createdBy: "u-author",
        projectId: w.projectA,
      },
      100,
    );
    if (!created.ok) throw new Error("lane");

    const report = await runLaneConversion({
      db: w.db,
      dryRun: false,
      workspaceId: w.idA,
    });

    expect(report.notConverted).toMatchObject([
      {
        laneId: created.workflow.id,
        reasons: [{ code: "document_unreadable" }],
      },
    ]);
    expect(
      (await w.workflowsA.get(created.workflow.id))?.workflow.version,
    ).toBe(1);
  });

  // #1105-T343
  it("reports a lane that was archived while the run was going as lane_gone, not as already inline, and does not touch it", async () => {
    const w = await setup();
    await addLane(w.workflowsA, w.projectA, oldLane("Stays"));
    const gone = await addLane(w.workflowsA, w.projectA, oldLane("Gone"));
    const db = hooked(w.db, {
      // The first read of the lanes is the list; the lane goes right after it.
      match: (node) => node.includes('"name":"workflows"'),
      after: async () => {
        await w.workflowsA.archive(gone, 100);
      },
    });

    const report = await runLaneConversion({
      db,
      dryRun: false,
      workspaceId: w.idA,
    });

    expect(report.gone).toMatchObject([{ laneId: gone, outcome: "lane_gone" }]);
    expect(report.counts).toMatchObject({
      converted: 1,
      lane_gone: 1,
      already_inline: 0,
    });
    expect((await w.workflowsA.get(gone))?.workflow.version).toBe(1);
  });

  // #1105-T344
  it("keeps the report of the workspaces already written when another workspace fails, lists the failure, and writes a line for each lane as it is done", async () => {
    const w = await setup();
    const [first, second] = [w.idA, w.idB].sort() as [string, string];
    const laneOf = (id: string) => (id === w.idA ? w.workflowsA : w.workflowsB);
    const projectOf = (id: string) => (id === w.idA ? w.projectA : w.projectB);
    const written = await addLane(
      laneOf(first),
      projectOf(first),
      oldLane("Written"),
    );
    const lost = await addLane(
      laneOf(second),
      projectOf(second),
      oldLane("Lost"),
    );
    const db = hooked(w.db, {
      match: (node) =>
        node.includes('"name":"workflows"') && node.includes(second),
      before: () => {
        throw Object.assign(new Error("connection lost to postgres://secret"), {
          code: "08006",
        });
      },
    });
    const lines: string[] = [];
    const warned: string[] = [];

    const report = await runLaneConversion({
      db,
      dryRun: false,
      progress: (line) => lines.push(line),
      warn: (line) => warned.push(line),
    });

    expect(report.complete).toBe(true);
    expect(report.workspaceFailures).toMatchObject([
      { workspaceId: second, code: "08006" },
    ]);
    expect(report.lanes).toMatchObject([
      { laneId: written, outcome: "converted" },
    ]);
    expect(lines.join("\n")).toContain(`converted workspace ${first}`);
    expect((await laneOf(first).get(written))?.workflow.version).toBe(2);
    expect((await laneOf(second).get(lost))?.workflow.version).toBe(1);
    expect(JSON.stringify([report, warned])).not.toContain("secret");
  });

  // #1105-T345
  it("ends early with what was done when the failure is outside the handling of a workspace: the report says so", async () => {
    const w = await setup();
    const [first, second] = [w.idA, w.idB].sort() as [string, string];
    const laneOf = (id: string) => (id === w.idA ? w.workflowsA : w.workflowsB);
    const projectOf = (id: string) => (id === w.idA ? w.projectA : w.projectB);
    const written = await addLane(
      laneOf(first),
      projectOf(first),
      oldLane("Written"),
    );
    const db = hooked(w.db, {
      match: (node) =>
        node.includes('"name":"workflows"') && node.includes(second),
      before: () => {
        throw Object.assign(new Error("down"), { code: "08006" });
      },
    });

    // The note of the failed workspace cannot be written: the run itself fails, and its report must survive.
    const report = await runLaneConversion({
      db,
      dryRun: false,
      warn: () => {
        throw new Error("stderr is closed");
      },
    });

    expect(report.complete).toBe(false);
    expect(report.aborted).toMatchObject({ code: "Error" });
    expect(report.workspacesReached).toBe(2);
    expect(report.lanes).toMatchObject([
      { laneId: written, outcome: "converted" },
    ]);
  });

  // #1105-T346
  it("refuses a workspace that does not exist, and a run over one workspace says that it covered only that one", async () => {
    const w = await setup();
    await addLane(w.workflowsA, w.projectA, oldLane("Lane"));

    await expect(
      runLaneConversion({ db: w.db, dryRun: false, workspaceId: "typo" }),
    ).rejects.toMatchObject({
      code: "LANE_CONVERSION_WORKSPACE_NOT_FOUND",
    });
    await expect(
      runLaneConversion({ db: w.db, dryRun: false, workspaceId: "typo" }),
    ).rejects.toBeInstanceOf(LaneConversionError);
    const report = await runLaneConversion({
      db: w.db,
      dryRun: false,
      workspaceId: w.idA,
    });
    expect(report.scope).toEqual({ kind: "workspace", workspaceId: w.idA });
    expect(report.workspaces).toBe(1);
  });

  // #1105-T347
  it("lists every converted step whose model was not checked, and warns for each lane archived without a project", async () => {
    const w = await setup();
    const id = await addLane(w.workflowsA, w.projectA, oldLane("Lane"));
    const orphan = await addLane(w.workflowsA, undefined, oldLane("Orphan"));

    const report = await runLaneConversion({
      db: w.db,
      dryRun: false,
      workspaceId: w.idA,
    });

    const lane = report.lanes.find((entry) => entry.laneId === id);
    expect(lane?.warnings).toMatchObject([
      { code: "model_unchecked", stepId: "implement" },
    ]);
    expect(lane?.warnings[0]?.message).toContain("catalog entry entry-1");
    expect(
      report.lanes.find((entry) => entry.laneId === orphan)?.warnings,
    ).toMatchObject([{ code: "archived_without_project" }]);
    expect(report.warned.map((entry) => entry.laneId).sort()).toEqual(
      [id, orphan].sort(),
    );
  });

  // #1105-T348
  it("reads the environments again for each lane, so a change made while the run goes is seen by the next lane", async () => {
    const w = await setup();
    const first = await addLane(
      w.workflowsA,
      w.projectA,
      oldLane("A first", { profile: "implementer" }),
    );
    const second = await addLane(
      w.workflowsA,
      w.projectA,
      oldLane("B second", { profile: "implementer" }),
    );
    const db = hooked(w.db, {
      match: (node) => node.includes('"name":"implementer_environments"'),
      after: async () => {
        // After the first lane read the environments: the environment's size changes from 4 to 2 vCPU.
        await w.db
          .updateTable("implementer_environments")
          .set({ vcpus: 2 })
          .where("id", "=", w.nodeA.id)
          .execute();
      },
    });

    await runLaneConversion({ db, dryRun: false, workspaceId: w.idA });

    const runnerOf = async (id: string) =>
      (
        JSON.parse((await w.workflowsA.get(id))?.current.document ?? "") as {
          steps: { runner: string }[];
        }
      ).steps[0]?.runner;
    expect(await runnerOf(first)).toBe(await hostedId(w, 4));
    expect(await runnerOf(second)).toBe(await hostedId(w, 2));
  });

  describe("pnpm lanes:convert", () => {
    const recorder = () => {
      const out: string[] = [];
      const err: string[] = [];
      return {
        out,
        err,
        io: {
          out: (l: string) => out.push(l),
          err: (l: string) => err.push(l),
        },
      };
    };

    // #1105-T320
    it("exits 2 and names the lane while the list of release A is not empty, and 0 once it is", async () => {
      const w = await setup();
      const stuck = await addLane(
        w.workflowsA,
        w.projectA,
        oldLane("Stuck", { profile: "nobody" }),
      );
      const first = recorder();

      const exit = await runLaneConversionCommand(
        { DATABASE_URL_MIGRATE: w.url },
        ["--dry-run"],
        first.io,
      );

      expect(exit).toBe(2);
      expect(first.err).toEqual([]);
      expect(first.out.join("\n")).toContain(stuck);
      expect(first.out.join("\n")).toContain("profile_missing");
      expect(first.out.join("\n")).toContain("DRY RUN");
      expect(first.out.join("\n")).not.toContain(w.url);
      await w.workflowsA.archive(stuck, 100);
      const second = recorder();
      expect(
        await runLaneConversionCommand(
          { DATABASE_URL_MIGRATE: w.url },
          ["--json"],
          second.io,
        ),
      ).toBe(0);
      expect(JSON.parse(second.out.join("\n"))).toMatchObject({
        dryRun: false,
        notConverted: [],
      });
    });

    // #1105-T322
    it("exits 3 on a dry run with lanes that would be converted, writes nothing, and never says the list is empty", async () => {
      const w = await setup();
      const id = await addLane(w.workflowsA, w.projectA, oldLane("Lane"));
      const orphan = await addLane(w.workflowsA, undefined, oldLane("Orphan"));
      const run = recorder();

      const exit = await runLaneConversionCommand(
        { DATABASE_URL_MIGRATE: w.url },
        ["--dry-run"],
        run.io,
      );

      expect(exit).toBe(3);
      expect(run.out.join("\n")).toContain("DRY RUN");
      expect(run.out.join("\n")).toContain("would convert");
      expect(run.out.join("\n")).not.toContain(
        "The list of release A is empty",
      );
      expect((await w.workflowsA.get(id))?.workflow.version).toBe(1);
      expect((await w.workflowsA.get(orphan))?.workflow.archivedAt).toBeNull();
      expect(await w.workflowsA.listVersions(id)).toHaveLength(1);
    });

    // #1105-T323
    it("with --workspace: a known workspace is covered alone and says so, an unknown one is an error that touches nothing", async () => {
      const w = await setup();
      const a = await addLane(w.workflowsA, w.projectA, oldLane("Lane"));
      const b = await addLane(w.workflowsB, w.projectB, oldLane("Lane"));
      const known = recorder();

      const exit = await runLaneConversionCommand(
        { DATABASE_URL_MIGRATE: w.url },
        ["--workspace", w.idA, "--json"],
        known.io,
      );

      expect(exit).toBe(0);
      expect(JSON.parse(known.out.join("\n"))).toMatchObject({
        scope: { kind: "workspace", workspaceId: w.idA },
        workspaces: 1,
        counts: { converted: 1 },
      });
      expect((await w.workflowsA.get(a))?.workflow.version).toBe(2);
      expect((await w.workflowsB.get(b))?.workflow.version).toBe(1);
      // The line of the lane went to stderr, so stdout stayed one JSON document.
      expect(known.err.join("\n")).toContain("converted workspace");

      const text = recorder();
      expect(
        await runLaneConversionCommand(
          { DATABASE_URL_MIGRATE: w.url },
          ["--workspace", w.idB],
          text.io,
        ),
      ).toBe(0);
      expect(text.out.join("\n")).toContain(`ONLY workspace ${w.idB}`);
      expect(text.out.join("\n")).not.toContain(
        "The list of release A is empty",
      );

      const unknown = recorder();
      expect(
        await runLaneConversionCommand(
          { DATABASE_URL_MIGRATE: w.url },
          ["--workspace", "typo"],
          unknown.io,
        ),
      ).toBe(1);
      expect(unknown.err.join("\n")).toContain(
        "LANE_CONVERSION_WORKSPACE_NOT_FOUND",
      );
      expect(unknown.out).toEqual([]);
    });

    // #1105-T321
    it("refuses a flag it does not know and a missing database", async () => {
      const bad = recorder();
      expect(await runLaneConversionCommand({}, ["--nope"], bad.io)).toBe(1);
      expect(bad.err.join("\n")).toContain("LANE_CONVERSION_USAGE");
      const missing = recorder();
      expect(await runLaneConversionCommand({}, [], missing.io)).toBe(1);
      expect(missing.err.join("\n")).toContain("DATABASE_CONFIG_INVALID");
    });
  });
});
