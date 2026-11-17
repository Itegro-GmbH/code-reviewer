// SPDX-License-Identifier: LicenseRef-Proprietary

// The ticket provider is not the git provider (#1035): a ticket action acts through the provider the ticket source of the run's project
// names, with the text key of the ticket. A second provider that is not GitHub is a fake here (Jira comes with the later issues of the epic).
import { describe, expect, it, vi } from "vitest";
import { readTicketSource } from "../db/repositories/projects-repository.ts";
import type { Integration, RepoRef } from "../integrations/types.ts";
import {
  TicketProviderError,
  createTicketProviderRegistry,
  type TicketProvider,
  type TicketScope,
} from "../integrations/ticket-provider.ts";
import { TICKET_PROVIDERS as SOURCE_PROVIDERS } from "../integrations/types.ts";
import {
  TICKET_PROVIDERS as REFERENCE_PROVIDERS,
  formatTicketRef,
  parseTicketRef,
} from "../workflows/ticket-ref.ts";
import type { ActionCall } from "./connectors.ts";
import { ConnectorError } from "./connectors.ts";
import { createGithubConnectors } from "./github-connectors.ts";
import { createTicketTargetResolver } from "./ticket-target.ts";

const integration = {
  id: "int-1",
  workspaceId: "w1",
} as unknown as Integration;
const container: RepoRef = {
  integrationId: "int-1",
  externalId: "PROJ",
  fullName: "PROJ",
  url: "https://acme.example/projects/PROJ",
};
const scope: TicketScope = { integration, repo: container };

function call(inputs: Record<string, unknown>): ActionCall {
  return {
    workspaceId: "w1",
    runId: "r1",
    stepId: "step",
    repository: { id: "repo-1", fullName: "acme/widgets" },
    baseBranch: "main",
    inputs,
    idempotencyKey: "wf-r1-1",
    stepCreatedAt: "2026-11-14T10:00:00.000Z",
    signal: new AbortController().signal,
  };
}

/** A ticket provider that is not GitHub: every call is recorded, and its keys look like `PROJ-123`. */
function fakeProvider(id: string, keys: RegExp = /^[A-Z]+-\d+$/) {
  const commentOnTicket = vi.fn<NonNullable<TicketProvider["commentOnTicket"]>>(
    async () => ({
      url: "https://acme.example/projects/PROJ/issues/PROJ-123#c1",
      existing: false,
      id: "c1",
    }),
  );
  const changeTicketLabels = vi.fn<
    NonNullable<TicketProvider["changeTicketLabels"]>
  >(async (_scope, _key, change) => ({ labels: [...change.add] }));
  const setTicketStatus = vi.fn<NonNullable<TicketProvider["setTicketStatus"]>>(
    async (_scope, _key, move) => ({ kind: "moved", status: move.status }),
  );
  const provider: TicketProvider = {
    id,
    isTicketKey: (key) => keys.test(key),
    commentOnTicket,
    changeTicketLabels,
    setTicketStatus,
  };
  return { provider, commentOnTicket, changeTicketLabels, setTicketStatus };
}

function wire(source: string | undefined) {
  const fake = fakeProvider("fake");
  const github = fakeProvider("github", /^\d+$/);
  const gitTarget = vi.fn(async () => undefined);
  const connectors = createGithubConnectors({
    targetOf: gitTarget,
    projectBoard: async () => "PVT_board",
    ticketTargetOf: createTicketTargetResolver({
      tickets: createTicketProviderRegistry([fake.provider, github.provider]),
      sourceProviderOf: async () => source,
      scopeOf: async () => scope,
    }),
  });
  const connector = (name: string) => {
    const found = connectors.find((candidate) => candidate.name === name);
    if (found === undefined) throw new Error(`no connector ${name}`);
    return found;
  };
  return { fake, github, gitTarget, connector };
}

describe("the ticket actions of a run whose project source names another provider", () => {
  // #1035-T03
  it("reach that provider with the text key, and never the git provider of the run's repository", async () => {
    const { fake, github, gitTarget, connector } = wire("fake");

    const comment = await connector("ticket.comment").run(
      call({ ticket: "PROJ-123", body: "On it." }),
    );
    const labels = await connector("ticket.labels").run(
      call({ ticket: "PROJ-123", add: ["agent working"] }),
    );
    const status = await connector("ticket.setStatus").run(
      call({ ticket: "PROJ-123", board: "1", status: "In review" }),
    );

    expect(fake.commentOnTicket).toHaveBeenCalledWith(
      scope,
      "PROJ-123",
      expect.stringContaining("On it."),
      expect.objectContaining({ marker: "<!-- wf-r1-1 -->" }),
    );
    expect(fake.changeTicketLabels).toHaveBeenCalledWith(
      scope,
      "PROJ-123",
      { add: ["agent working"], remove: [] },
      expect.any(AbortSignal),
    );
    expect(fake.setTicketStatus).toHaveBeenCalledWith(
      scope,
      "PROJ-123",
      { board: "1", status: "In review" },
      expect.any(AbortSignal),
    );
    expect(comment).toMatchObject({ existing: false });
    expect(labels).toEqual({ labels: ["agent working"] });
    expect(status).toEqual({ status: "In review" });
    expect(github.commentOnTicket).not.toHaveBeenCalled();
    expect(gitTarget).not.toHaveBeenCalled();
  });

  // #1035-T03
  it("refuses a key that the provider says cannot name one of its tickets, before it is asked anything", async () => {
    const { fake, connector } = wire("fake");

    await expect(
      connector("ticket.comment").run(call({ ticket: "x", body: "b" })),
    ).rejects.toMatchObject({ name: "ActionInputError" });
    expect(fake.commentOnTicket).not.toHaveBeenCalled();
  });

  // #1035-T03
  it("find no target when the source names a provider nobody registered", async () => {
    const { connector } = wire("nobody");

    const error = await connector("ticket.comment")
      .run(call({ ticket: "PROJ-1", body: "b" }))
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ConnectorError);
    expect((error as ConnectorError).code).toBe("github_not_found");
  });
});

describe("the ticket actions of a provider whose statuses are no board columns (Jira, #1040)", () => {
  function boardless(
    move: NonNullable<TicketProvider["setTicketStatus"]> = async (
      _scope,
      _key,
      to,
    ) => ({ kind: "moved", status: to.status }),
  ) {
    const setTicketStatus = vi.fn(move);
    const comment = vi.fn<NonNullable<TicketProvider["commentOnTicket"]>>(
      async () => ({ url: "", existing: false }),
    );
    const provider: TicketProvider = {
      id: "boardless",
      boardless: true,
      isTicketKey: (key) => /^[A-Z]+-\d+$/.test(key),
      setTicketStatus,
      commentOnTicket: comment,
    };
    const connectors = createGithubConnectors({
      targetOf: async () => undefined,
      // The project has no board: a provider with boards would refuse the step for it.
      projectBoard: async () => undefined,
      ticketTargetOf: createTicketTargetResolver({
        tickets: createTicketProviderRegistry([provider]),
        sourceProviderOf: async () => "boardless",
        scopeOf: async () => ({
          ...scope,
          jira: { connectionId: "c1", projectKey: "PROJ" },
        }),
      }),
    });
    const connector = (name: string) => {
      const found = connectors.find((candidate) => candidate.name === name);
      if (found === undefined) throw new Error(`no connector ${name}`);
      return found;
    };
    return { connector, setTicketStatus, comment };
  }

  // #1040-T01
  it("moves a ticket without any board of the project and hands no board to the provider", async () => {
    const { connector, setTicketStatus } = boardless();

    expect(
      await connector("ticket.setStatus").run(
        call({ ticket: "PROJ-1", status: "In Progress" }),
      ),
    ).toEqual({ status: "In Progress" });

    expect(setTicketStatus).toHaveBeenCalledWith(
      expect.objectContaining({ jira: expect.anything() }),
      "PROJ-1",
      { status: "In Progress" },
      expect.any(AbortSignal),
    );
  });

  // #1040-T01
  it("ends a status no transition leads to, a status the workflow lacks and a missing ticket with their own codes", async () => {
    const reachable = boardless(async () => ({
      kind: "status_unreachable",
      reachable: ["In Progress", "Done"],
    }));
    const error = await reachable
      .connector("ticket.setStatus")
      .run(call({ ticket: "PROJ-1", status: "In Review" }))
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ConnectorError);
    expect((error as ConnectorError).code).toBe("ticket_status_unreachable");
    expect((error as ConnectorError).message).toContain("In Progress, Done");

    const unknown = boardless(async () => ({
      kind: "status_unknown",
      available: ["To Do", "Done"],
    }));
    const unknownError = await unknown
      .connector("ticket.setStatus")
      .run(call({ ticket: "PROJ-1", status: "Blocked" }))
      .catch((caught: unknown) => caught);
    expect((unknownError as ConnectorError).code).toBe("ticket_status_unknown");
    expect((unknownError as ConnectorError).message).toContain(
      "workflow of the Jira project",
    );

    const missing = boardless(async () => ({ kind: "issue_not_found" }));
    const missingError = await missing
      .connector("ticket.setStatus")
      .run(call({ ticket: "PROJ-1", status: "Done" }))
      .catch((caught: unknown) => caught);
    expect((missingError as ConnectorError).code).toBe("ticket_not_found");
  });

  // #1040-T01
  it("turns the failures of a provider into step codes with text of ours, never the platform's", async () => {
    for (const code of [
      "ticket_not_found",
      "ticket_forbidden",
      "ticket_connection_broken",
      "ticket_unavailable",
      "ticket_rejected",
    ] as const) {
      const { connector, comment } = boardless();
      comment.mockRejectedValueOnce(
        new TicketProviderError(code, "Our words."),
      );
      const error = await connector("ticket.comment")
        .run(call({ ticket: "PROJ-1", body: "b" }))
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ConnectorError);
      expect((error as ConnectorError).code).toBe(code);
      expect((error as ConnectorError).message).toContain("Our words.");
    }
  });

  // #1040-T01
  it("takes the address of the comment of the provider's own site, and none that is not an http(s) address", async () => {
    const { connector, comment } = boardless();
    comment.mockResolvedValueOnce({
      url: "https://acme.atlassian.net/browse/PROJ-1?focusedCommentId=1",
      existing: false,
    });
    expect(
      await connector("ticket.comment").run(
        call({ ticket: "PROJ-1", body: "b" }),
      ),
    ).toMatchObject({
      url: "https://acme.atlassian.net/browse/PROJ-1?focusedCommentId=1",
    });
    for (const url of [
      "javascript:alert(1)",
      "https://u:p@x.test/",
      "nonsense",
    ]) {
      comment.mockResolvedValueOnce({ url, existing: false });
      expect(
        await connector("ticket.comment").run(
          call({ ticket: "PROJ-1", body: "b" }),
        ),
      ).toMatchObject({ url: "" });
    }
  });
});

describe("the ticket actions of a run whose project source cannot write (a provider without those methods)", () => {
  /** A read-only provider, as the Jira one is: it can read a ticket and has no comment, label or status method. */
  function readOnly() {
    const provider: TicketProvider = {
      id: "readonly",
      isTicketKey: (key) => /^[A-Z]+-\d+$/.test(key),
      readTicket: async () => null,
    };
    const connectors = createGithubConnectors({
      targetOf: async () => undefined,
      projectBoard: async () => "PVT_board",
      ticketTargetOf: createTicketTargetResolver({
        tickets: createTicketProviderRegistry([provider]),
        sourceProviderOf: async () => "readonly",
        scopeOf: async () => scope,
      }),
    });
    return (name: string) => {
      const found = connectors.find((candidate) => candidate.name === name);
      if (found === undefined) throw new Error(`no connector ${name}`);
      return found;
    };
  }

  // #1039
  it("end with ticket_provider_unsupported, not with a GitHub code, and name the source", async () => {
    const connector = readOnly();
    for (const [name, inputs] of [
      ["ticket.comment", { ticket: "PROJ-1", body: "b" }],
      ["ticket.labels", { ticket: "PROJ-1", add: ["x"] }],
      ["ticket.setStatus", { ticket: "PROJ-1", board: "1", status: "Done" }],
    ] as const) {
      const error = await connector(name)
        .run(call(inputs))
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ConnectorError);
      expect((error as ConnectorError).code).toBe(
        "ticket_provider_unsupported",
      );
      expect((error as ConnectorError).message).toContain("readonly");
    }
  });
});

describe("the ticket actions of a run whose project names no provider", () => {
  // #1035-T01
  it("act through GitHub with the number of the issue as the text key, as before", async () => {
    const { fake, github, connector } = wire(undefined);

    await connector("ticket.comment").run(call({ ticket: 15, body: "On it." }));

    expect(github.commentOnTicket).toHaveBeenCalledWith(
      scope,
      "15",
      expect.stringContaining("On it."),
      expect.anything(),
    );
    expect(fake.commentOnTicket).not.toHaveBeenCalled();
  });
});

describe("a ticket reference", () => {
  // #1035-T03
  it("names a registered provider, and the provider list is a parameter", () => {
    expect(parseTicketRef("fake:PROJ#PROJ-123")).toMatchObject({
      ok: false,
      problem: { reason: "provider" },
    });
    const parsed = parseTicketRef("fake:PROJ#PROJ-123", ["github", "fake"]);
    expect(parsed).toEqual({
      ok: true,
      ref: { provider: "fake", repo: "PROJ", key: "PROJ-123" },
    });
    if (parsed.ok)
      expect(formatTicketRef(parsed.ref)).toBe("fake:PROJ#PROJ-123");
  });

  // #1035-T01
  it("keeps the form of a GitHub ticket: the key is the number as text", () => {
    expect(parseTicketRef("github:acme/widgets#15")).toEqual({
      ok: true,
      ref: { provider: "github", repo: "acme/widgets", key: "15" },
    });
    expect(
      formatTicketRef({ provider: "github", repo: "acme/widgets", key: "15" }),
    ).toBe("github:acme/widgets#15");
  });
});

describe("the ticket source of a project", () => {
  const stored = JSON.stringify({
    provider: "fake",
    repositoryId: "ignored",
    board: null,
  });

  // #1035-T03
  it("names a provider of the list it is read with, and reads as GitHub's default for one that is not", () => {
    const warn = vi.fn();

    expect(
      readTicketSource(stored, "repo-1", "p-1", warn, ["github", "fake"]),
    ).toEqual({ provider: "fake", repositoryId: "repo-1", board: null });
    expect(warn).not.toHaveBeenCalled();
    expect(readTicketSource(stored, "repo-1", "p-1", warn)).toEqual({
      provider: "github",
      repositoryId: "repo-1",
      board: null,
    });
    expect(warn).toHaveBeenCalledOnce();
  });
});

describe("the list of ticket providers", () => {
  // #1035-T01
  it("is the same for a ticket reference and for a project's ticket source, and names GitHub and Jira", () => {
    expect([...REFERENCE_PROVIDERS]).toEqual([...SOURCE_PROVIDERS]);
    expect([...SOURCE_PROVIDERS]).toEqual(["github", "jira"]);
  });
});
