// SPDX-License-Identifier: LicenseRef-Proprietary

// What the factory pages journey (e2e/factory, #951) does to the factory app besides clicking: sign in as the instance admin, put
// the mirror of the tickets and a run that waits for an answer into the database through the app's own repositories
// (src/test-support/e2e-factory-child.ts), and the lane the journey starts and edits.
import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { expect, type APIRequestContext, type Page } from "@playwright/test";
import { e2eEnv } from "./e2e-env";

const run = promisify(execFile);
const CHILD = resolve(process.cwd(), "src/test-support/e2e-factory-child.ts");

async function factoryCommand<T>(command: string, input: unknown): Promise<T> {
  const { stdout } = await run(
    process.execPath,
    [
      "--no-warnings",
      "--conditions=react-server",
      CHILD,
      command,
      e2eEnv.factoryDatabaseUrl,
      JSON.stringify(input),
    ],
    // A child that hangs fails the journey with its own message instead of the test's timeout.
    { cwd: process.cwd(), timeout: 60_000 },
  );
  return JSON.parse(stdout.trim().split("\n").at(-1) ?? "null") as T;
}

/** The id the app gave the repository when it was synced from GitHub (the address of its project). */
export async function repositoryIdOf(repository: string): Promise<string> {
  return (await factoryCommand<{ id: string }>("repository", { repository }))
    .id;
}

export type MirroredTicket = {
  number: number;
  title: string;
  body?: string;
  labels?: string[];
  type?: string;
};

/** Puts tickets into the mirror, as the sync of the ticket source would, and marks the mirror as read. */
export async function mirrorTickets(
  repository: string,
  tickets: MirroredTicket[],
): Promise<void> {
  await factoryCommand("tickets", { repository, tickets });
}

/** A run of `workflowId` that waits for an answer to a question about the ticket, as a turn of an agent that asked leaves it. */
export async function seedWaitingRun(input: {
  repository: string;
  workflowId: string;
  ticket: number;
  question: string;
  options: string[];
  context: string;
}): Promise<string> {
  const { runId } = await factoryCommand<{ runId: string }>("waiting-run", {
    ...input,
    email: e2eEnv.adminEmail,
  });
  return runId;
}

/** Puts an issue into the fake GitHub: the start of a lane and the answer to a question read and write the ticket there. */
export async function addGithubIssue(
  request: APIRequestContext,
  repository: string,
  issue: { number: number; title: string; body?: string; labels?: string[] },
): Promise<void> {
  const response = await request.post(`${e2eEnv.githubUrl}/__fake/issues`, {
    data: { repository, issue },
  });
  expect(response.status(), await response.text()).toBe(201);
}

/** Signs in as the instance admin through the route of the sign-in form; the cookies of the context hold the session. */
export async function signInAsFactoryAdmin(
  client: Pick<Page, "request"> | APIRequestContext,
): Promise<void> {
  const api = "request" in client ? client.request : client;
  const signedIn = await api.post("/api/auth/sign-in/email", {
    data: { email: e2eEnv.adminEmail, password: e2eEnv.adminPassword },
  });
  expect(signedIn.status(), await signedIn.text()).toBe(200);
}

/** The lane of the journey: started by hand on a ticket, it writes one comment on it. Saved in the project through the route. */
export const LANE_DOCUMENT = {
  version: 1,
  name: "Comment on the issue",
  description: "Writes a short note on the issue it is started on.",
  triggers: [
    {
      id: "manual",
      kind: "manual",
      input: {
        type: "object",
        required: ["ticket"],
        properties: {
          ticket: {
            type: "ticket",
            description: "The ticket to write on, like github:owner/repo#128.",
          },
        },
      },
      steps: [],
    },
  ],
  steps: [
    {
      id: "note",
      kind: "action",
      connector: "ticket.comment",
      ticket: "{{trigger.ticket}}",
      body: "A lane of the factory looked at this issue.",
    },
  ],
} as const;
