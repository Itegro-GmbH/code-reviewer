// SPDX-License-Identifier: LicenseRef-Proprietary

// #920: a comment `/answer` on an issue, as GitHub delivers it, answers the question a run waits for. A real Postgres database, the handler
// of the webhook route with a signed delivery, the real engine and Implementer queue, and the fake GitHub. Comments on issues were ignored
// before; the cases here are the ones that must stay ignored and the one that answers.
import { describe, expect, it } from "vitest";
import { webhookFixture } from "../../../fakes/github/webhooks.ts";
import { sha } from "../test-support/jobs.ts";
import {
  SUMMARY_RESULT,
  startEngineHarness,
  type EngineHarness,
} from "../test-support/workflow-engine-harness.ts";
import { parseStepAsk } from "./ask.ts";
import { createTicketAnswers } from "./ticket-answers.ts";

const TICKET = {
  number: 7,
  title: "Add widget caching",
  body: "Rebuilt on every request.",
  url: "https://github.test/acme/widgets/issues/7",
  labels: ["enhancement"],
  assignees: [],
  type: "",
};

const QUESTION = {
  question: "Retry which failures?",
  options: ["Network errors", "Network errors and 5xx answers"],
};

const DOCUMENT = {
  version: 1,
  name: "Asks",
  triggers: [
    {
      id: "manual",
      kind: "manual",
      input: {
        type: "object",
        required: ["ticket"],
        properties: { ticket: { type: "ticket" } },
      },
    },
  ],
  steps: [
    {
      id: "plan",
      kind: "agent",
      profile: "worker",
      environment: "Python",
      instruction: "Plan {{trigger.ticket.title}}.",
      result: SUMMARY_RESULT,
    },
  ],
};

async function waitingRun() {
  const app = await startEngineHarness({
    tickets: { "acme/widgets#7": TICKET },
  });
  const kicked: string[] = [];
  app.h.setTicketAnswers(
    createTicketAnswers({
      async activeRepository(repo) {
        const found = await app.h.repositories.findByExternalId(
          repo.integrationId,
          repo.externalId,
        );
        return found?.active === true ? { id: found.id } : undefined;
      },
      listWaiting: (repositoryId) => app.runs.listWaiting(repositoryId, 20),
      listSteps: (runId) => app.runs.listSteps(runId),
      engine: app.engine,
      kick: (runId) => void kicked.push(runId),
    }),
  );
  app.h.fake.setCollaboratorPermission("acme/widgets", "bob", "write");
  const workflow = await app.saveWorkflow(DOCUMENT);
  const { run } = await app.start(workflow.id, {
    trigger: "manual",
    input: { ticket: "github:acme/widgets#7" },
  });
  await app.engine.advance(run.id);
  // The agent pushed its branch before it asked: the turn that goes on starts from its tip.
  app.h.fake.addBranch("acme/widgets", `workflow/${run.id}/plan`, sha("c"));
  const jobId = await app.finishTurn({ agentAsk: QUESTION, costUsd: 0.5 });
  await app.engine.jobEnded(jobId);
  return { app, kicked, runId: run.id };
}

/** A delivery of a comment on issue 7, by `bob` unless the payload says otherwise. */
function comment(
  body: string,
  changes: Record<string, Record<string, unknown>> = {},
) {
  const payload = webhookFixture("issue_comment.created.on-issue") as Record<
    string,
    Record<string, unknown>
  >;
  return {
    ...payload,
    ...changes,
    comment: { ...payload.comment, body, ...changes.comment },
  };
}

async function outcomeOf(response: Response): Promise<unknown> {
  expect(response.status).toBe(202);
  return ((await response.json()) as { outcome: string }).outcome;
}

async function statusOf(app: EngineHarness, runId: string) {
  return (await app.stateOf(runId)).run.status;
}

describe("the webhook: a comment /answer on an issue", () => {
  // #920-T140
  it("answers the question of the run that waits on that issue, as the commenter, and the delivery stays claimed", async () => {
    const { app, kicked, runId } = await waitingRun();
    expect(await statusOf(app, runId)).toBe("waiting");

    const response = await app.h.deliver("issue_comment.created.on-issue", {
      deliveryId: "delivery-1",
      payload: comment("/answer 2 and log it"),
    });

    expect(await outcomeOf(response)).toBe("ticket_answered");
    const { run, steps } = await app.stateOf(runId);
    expect(run.status).toBe("running");
    expect(parseStepAsk(steps[0]?.ask ?? null)).toMatchObject({
      state: "answered",
      answer: {
        text: "Network errors and 5xx answers\n\nand log it",
        choice: 2,
        by: "bob",
        via: "comment",
      },
    });
    expect(kicked).toEqual([runId]);
    // The turn that goes on starts when the engine is kicked.
    await app.engine.advance(runId);
    expect(await app.waitingJobs()).toHaveLength(1);
    // A redelivery of the same comment is a duplicate: nothing is answered twice.
    const again = await app.h.deliver("issue_comment.created.on-issue", {
      deliveryId: "delivery-1",
      payload: comment("/answer 2 and log it"),
    });
    expect(await outcomeOf(again)).toBe("duplicate");
  });

  // #920-T141
  it("is ignored from a commenter without write access: the question stays open", async () => {
    const { app, kicked, runId } = await waitingRun();
    app.h.fake.setCollaboratorPermission("acme/widgets", "bob", "read");

    const response = await app.h.deliver("issue_comment.created.on-issue", {
      deliveryId: "delivery-1",
      payload: comment("/answer 1"),
    });

    expect(await outcomeOf(response)).toBe("ignored");
    expect(await statusOf(app, runId)).toBe("waiting");
    expect(kicked).toEqual([]);
  });

  // #920-T142
  it("is ignored from a commenter whose association cannot have write access, and from a bot", async () => {
    const { app, runId } = await waitingRun();

    for (const [id, changes] of [
      ["delivery-1", { comment: { author_association: "NONE" } }],
      ["delivery-2", { sender: { type: "Bot", login: "acme[bot]", id: 9 } }],
    ] as const) {
      const response = await app.h.deliver("issue_comment.created.on-issue", {
        deliveryId: id,
        payload: comment("/answer 1", changes),
      });
      expect(await outcomeOf(response)).toBe("ignored");
    }
    expect(await statusOf(app, runId)).toBe("waiting");
  });

  // #920-T143
  it("takes no answer from a comment on another issue and none from an ordinary comment, and the claim is free for a later try", async () => {
    const { app, runId } = await waitingRun();

    const elsewhere = await app.h.deliver("issue_comment.created.on-issue", {
      deliveryId: "delivery-1",
      payload: comment("/answer 1", {
        issue: { number: 8, state: "open", title: "Other" },
      }),
    });
    const ordinary = await app.h.deliver("issue_comment.created.on-issue", {
      deliveryId: "delivery-2",
      payload: comment("thanks!"),
    });

    expect(await outcomeOf(elsewhere)).toBe("no_answer_taken");
    expect(await outcomeOf(ordinary)).toBe("ignored");
    expect(await statusOf(app, runId)).toBe("waiting");
    // Not a success that stays claimed: the same delivery can be tried again.
    const retry = await app.h.deliver("issue_comment.created.on-issue", {
      deliveryId: "delivery-1",
      payload: comment("/answer 1", {
        issue: { number: 8, state: "open", title: "Other" },
      }),
    });
    expect(await outcomeOf(retry)).toBe("no_answer_taken");
  });

  // #920-T144
  it("is not taken twice: the second answer finds the question answered", async () => {
    const { app, runId } = await waitingRun();
    await app.h.deliver("issue_comment.created.on-issue", {
      deliveryId: "delivery-1",
      payload: comment("/answer 1"),
    });

    const second = await app.h.deliver("issue_comment.created.on-issue", {
      deliveryId: "delivery-2",
      payload: comment("/answer 2"),
    });

    expect(await outcomeOf(second)).toBe("no_answer_taken");
    expect(
      parseStepAsk((await app.stateOf(runId)).steps[0]?.ask ?? null),
    ).toMatchObject({ answer: { choice: 1 } });
  });

  // #920-T145
  it("refuses an option the question does not have and keeps waiting", async () => {
    const { app, runId } = await waitingRun();

    const response = await app.h.deliver("issue_comment.created.on-issue", {
      deliveryId: "delivery-1",
      payload: comment("/answer 2"),
    });
    const taken = await app.h.deliver("issue_comment.created.on-issue", {
      deliveryId: "delivery-2",
      payload: comment("/answer 5"),
    });

    expect(await outcomeOf(response)).toBe("ticket_answered");
    // `/answer 5` on a question with two options is a free text, and the run was answered already by the first.
    expect(await outcomeOf(taken)).toBe("no_answer_taken");
    expect(await statusOf(app, runId)).toBe("running");
  });
});
