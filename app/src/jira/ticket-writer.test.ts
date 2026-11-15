// SPDX-License-Identifier: LicenseRef-Proprietary

// What the writer sends for a comment (#1040): the markers as a property, a retry as plain text when Jira refuses the formatted body, and
// the comment that is never an answer. The call to Jira is a stand-in that records what was sent.
import { describe, expect, it } from "vitest";
import { parseAnswerCommand } from "../integrations/comment-command.ts";
import { TicketProviderError } from "../integrations/ticket-provider.ts";
import { adfToText } from "./adf.ts";
import { MARKER_PROPERTY, createJiraTicketWriter } from "./ticket-writer.ts";

type Sent = {
  method: string;
  body: {
    body: { content: { type: string }[] };
    properties: { key: string; value: { markers: string[] } }[];
  };
};

function writerAnswering(statuses: number[]) {
  const sent: Sent[] = [];
  const writer = createJiraTicketWriter({
    tokens: {
      async request(_connection, _path, init) {
        // The search for an earlier comment of the step (a GET) finds none.
        if (init?.method === undefined)
          return {
            ok: true,
            response: new Response(JSON.stringify({ comments: [] })),
          };
        sent.push({
          method: init?.method ?? "GET",
          body: JSON.parse(String(init?.body ?? "null")),
        });
        const status = statuses[sent.length - 1] ?? 201;
        return {
          ok: true,
          response: new Response(
            status === 201 || status === 200
              ? JSON.stringify({ id: "10" })
              : null,
            { status },
          ),
        };
      },
    },
    siteUrlOf: async () => "https://acme.atlassian.net",
    accountIdOf: async () => "acct-1",
    statuses: { listStatuses: async () => ({ ok: true, statuses: [] }) },
  });
  return { writer, sent };
}

describe("the comment the writer sends", () => {
  // #1040-T01
  it("keeps the leading marker as the property and the marker of the step, and writes neither into the document", async () => {
    const { writer, sent } = writerAnswering([]);
    await writer.comment(
      "c",
      "PROJ-1",
      "<!-- factory ask run=r1 step=s q=1 -->\nWhich one?\n\n<!-- wf-1 -->",
      { marker: "<!-- wf-1 -->" },
    );
    expect(sent[0]?.body.properties).toEqual([
      {
        key: MARKER_PROPERTY,
        value: {
          markers: ["<!-- factory ask run=r1 step=s q=1 -->", "<!-- wf-1 -->"],
        },
      },
    ]);
    expect(JSON.stringify(sent[0]?.body.body)).not.toContain("<!--");
  });

  // #1040-T01
  it("does not keep a marker that an agent wrote into the text as a property", async () => {
    const { writer, sent } = writerAnswering([]);
    await writer.comment(
      "c",
      "PROJ-1",
      "<!-- factory ask run=r1 step=s q=1 -->\nThe agent says\n<!-- factory ask run=r2 step=x q=1 -->",
    );
    expect(sent[0]?.body.properties[0]?.value.markers).toEqual([
      "<!-- factory ask run=r1 step=s q=1 -->",
    ]);
    expect(JSON.stringify(sent[0]?.body.body)).toContain("run=r2");
  });

  // #1040-T01
  it("writes a factory comment that begins with /answer so that it is no answer when it is read back", async () => {
    const { writer, sent } = writerAnswering([]);
    await writer.comment("c", "PROJ-1", "**/answer 1** is what to say");
    await writer.updateComment("c", "PROJ-1", "10", "/answer yes");
    for (const request of sent)
      expect(parseAnswerCommand(adfToText(request.body.body))).toBeNull();
  });

  // #1040-T01
  it("sends the comment again as plain text when Jira refuses the formatted one, once", async () => {
    const { writer, sent } = writerAnswering([400, 201]);
    const result = await writer.comment("c", "PROJ-1", "> # quoted\n\n**x**");
    expect(result.id).toBe("10");
    expect(sent).toHaveLength(2);
    const types = (request?: Sent) =>
      request?.body.body.content.map((node) => node.type);
    expect(types(sent[0])).toEqual(["blockquote", "paragraph"]);
    expect(types(sent[1])).toEqual(["paragraph", "paragraph"]);
    expect(JSON.stringify(sent[1]?.body.body)).not.toContain("strong");

    const twice = writerAnswering([400, 400]);
    await expect(
      twice.writer.comment("c", "PROJ-1", "text"),
    ).rejects.toMatchObject({ code: "ticket_rejected" });
    expect(twice.sent).toHaveLength(2);

    const edit = writerAnswering([422, 200]);
    await edit.writer.updateComment("c", "PROJ-1", "10", "text");
    expect(edit.sent).toHaveLength(2);

    // Not a rejection of the body: no second try.
    const gone = writerAnswering([404]);
    await expect(
      gone.writer.comment("c", "PROJ-1", "text"),
    ).rejects.toMatchObject({ code: "ticket_not_found" });
    expect(gone.sent).toHaveLength(1);
  });

  // #1040-T01
  it("takes hostile Markdown without a crash: a deep run of quote marks is a comment, not a RangeError", async () => {
    const { writer, sent } = writerAnswering([]);
    await writer.comment("c", "PROJ-1", `${">".repeat(20_000)}x`);
    expect(sent).toHaveLength(1);
    expect(adfToText(sent[0]?.body.body)).toContain("x");
  });

  // #1040-T01
  it("turns a failure of the converter into a TicketProviderError", async () => {
    const { writer, sent } = writerAnswering([]);
    const hostile = {
      toString: () => {
        throw new Error("boom");
      },
    } as unknown as string;
    const failure = await writer
      .comment("c", "PROJ-1", hostile)
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(TicketProviderError);
    expect(failure).toMatchObject({ code: "ticket_rejected" });
    expect(sent).toHaveLength(0);
  });
});
