// SPDX-License-Identifier: LicenseRef-Proprietary

// A program the Playwright journey of the factory (e2e/factory) runs (node runs this file directly, TypeScript types are stripped;
// `--conditions=react-server` lets `server-only` pass) to put into the app under test what a lane and GitHub would have written by
// now: the mirror of the tickets and a run that waits for an answer. It goes through the real repositories on the app's database and
// never writes rows by hand; the app is a separate process with the same database open, so the pages read it through their own
// queries. The project and the lane are made through the routes of the app, as a person does.
//
//   repository   <db> <json>   {repository: "owner/name"}                 -> {id} (the id the app gave it when it was synced)
//   tickets      <db> <json>   {repository: "owner/name", tickets: [{number, title, body?, labels?, type?, assignees?}]}
//   waiting-run  <db> <json>   {repository, workflowId, ticket, question, options?, context?, email}   -> {runId}
//
// Every command prints one JSON line.
import { openPostgresDatabase } from "../db/postgres.ts";
import { createRepositoriesRepository } from "../db/repositories/repositories-repository.ts";
import { createTrackerRepository } from "../db/repositories/tracker-repository.ts";
import { createWorkflowRunsRepository } from "../db/repositories/workflow-runs-repository.ts";
import { serializeAsk } from "../workflow-runs/ask.ts";
import { formatTicketRef } from "../workflows/ticket-ref.ts";
import { defaultWorkspaceId } from "./workspaces.ts";

const [command, databaseUrl, argument] = process.argv.slice(2);
if (!command || !databaseUrl || !argument)
  throw new Error("Usage: e2e-factory-child.ts <command> <db> <json>");

const input = JSON.parse(argument) as Record<string, unknown>;
const db = openPostgresDatabase({ url: databaseUrl, poolMax: 2 });
try {
  const workspaceId = await defaultWorkspaceId(db);
  const fullName = String(input.repository);
  const repository = (
    await createRepositoriesRepository(db, workspaceId).list()
  ).find((candidate) => candidate.fullName === fullName);
  if (repository === undefined) throw new Error(`No repository ${fullName}.`);

  if (command === "repository") {
    console.log(JSON.stringify({ id: repository.id }));
  } else if (command === "tickets") {
    const tracker = createTrackerRepository(db, workspaceId);
    const at = new Date().toISOString();
    const tickets = input.tickets as Array<{
      number: number;
      title: string;
      body?: string;
      labels?: string[];
      type?: string;
      assignees?: string[];
    }>;
    for (const ticket of tickets)
      await tracker.upsertItem(repository.id, {
        provider: "github",
        repo: fullName,
        number: ticket.number,
        nodeId: `I_e2e_${String(ticket.number)}`,
        kind: "issue",
        state: "open",
        stateReason: null,
        type: ticket.type ?? null,
        title: ticket.title,
        bodyExcerpt: ticket.body ?? "",
        labels: (ticket.labels ?? []).map((name) => ({
          name,
          color: "ededed",
        })),
        assignees: (ticket.assignees ?? []).map((login) => ({ login })),
        closes: [],
        updatedAt: at,
      });
    // The mirror counts as read: the page shows the rows and not "the first read is still going on".
    await tracker.saveSyncState(repository.id, { lastFullSyncAt: at });
    console.log(JSON.stringify({ written: tickets.length }));
  } else if (command === "waiting-run") {
    const user = await db
      .selectFrom("users")
      .select("id")
      .where("email", "=", String(input.email))
      .executeTakeFirst();
    if (user === undefined) throw new Error("No such account.");
    const runs = createWorkflowRunsRepository(db, workspaceId);
    const ticket = formatTicketRef({
      provider: "github",
      repo: fullName,
      number: Number(input.ticket),
    });
    const created = await runs.createRun({
      workflowId: String(input.workflowId),
      workflowVersion: 1,
      repositoryId: repository.id,
      baseBranch: "main",
      triggerInput: JSON.stringify({ ticket }),
      budgetMicroUsd: 20_000_000,
      clientRequestId: `e2e-factory-${String(input.ticket)}`,
      createdBy: user.id,
      actorLogin: "factory-journey",
      ticketRef: ticket,
    });
    if (created.status !== "created") throw new Error("The run exists.");
    const runId = created.run.id;
    // What the engine does for an agent step whose turn ends with a question: the step is written, taken, and then waits with it.
    const step = await runs.lockRun(runId, (lock) =>
      lock.addStep({
        position: 0,
        stepId: "work",
        kind: "agent",
        round: 1,
        profile: null,
        capMicroUsd: null,
      }),
    );
    if (step === undefined) throw new Error("The run vanished.");
    if ((await runs.claimStep(step.id)) === undefined)
      throw new Error("The step was not taken.");
    const asked = await runs.lockRun(runId, (lock) =>
      lock.askStep(
        step.id,
        serializeAsk({
          question: String(input.question),
          ...(Array.isArray(input.options)
            ? { options: input.options as string[] }
            : {}),
          ...(typeof input.context === "string"
            ? { context: input.context }
            : {}),
          n: 1,
          state: "open",
          askedAt: new Date().toISOString(),
        }),
        { costMicroUsd: 1_500_000, costBasis: "reported" },
      ),
    );
    if (asked === undefined) throw new Error("The step does not wait.");
    console.log(JSON.stringify({ runId }));
  } else {
    throw new Error(`Unknown command: ${command}`);
  }
} finally {
  await db.destroy();
}
