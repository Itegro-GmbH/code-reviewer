// SPDX-License-Identifier: LicenseRef-Proprietary

// The ticket provider is not the git provider (#1035): a ticket action acts through the provider the ticket source of the run's project
// names, with the text key of the ticket. A second provider that is not GitHub is a fake here (Jira comes with the later issues of the epic).
import { describe, expect, it, vi } from "vitest";
import { readTicketSource } from "../db/repositories/projects-repository.ts";
import type { Integration, RepoRef } from "../integrations/types.ts";
import {
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
