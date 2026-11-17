// SPDX-License-Identifier: LicenseRef-Proprietary

// @vitest-environment jsdom
// The MCP page (#1050), with a stand-in for the routes: the list with address, transport, header NAMES with a mask, the last test and its
// tools; adding a server with a header secret (tested at once, the secret only on its way to the route); keeping a stored header on an edit;
// removing after a confirmation, and the refusal that names the lanes; read only for a member; and the sentence of every refusal.
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { CapabilitiesProvider } from "../../capabilities/context.tsx";
import { ProductIdentityProvider } from "../../product-identity/context.tsx";
import { identityFor } from "../../product-identity/identities.ts";
import type { RequestResult } from "../../ui/json-request.ts";
import type { McpServerView } from "../service.ts";
import type { McpApi, McpServerForm } from "./api.ts";
import { McpPanel } from "./mcp-panel.tsx";

afterEach(cleanup);

const ok = <T,>(data: T): RequestResult<T> => ({ ok: true, data });
const refused = (
  status: number,
  code: string,
  details?: Record<string, unknown>,
): RequestResult<never> => ({
  ok: false,
  status,
  code,
  issues: [],
  ...(details === undefined ? {} : { details }),
});

const TOOLS = {
  serverName: "Fake Issues",
  serverVersion: "1.2.3",
  protocolVersion: "2025-06-18",
  tools: [{ name: "search_issues", description: "Search the issues." }],
  truncated: false,
};

const LINEAR: McpServerView = {
  id: "s1",
  name: "Linear",
  transport: "streamable-http",
  url: "https://mcp.linear.example/mcp",
  auth: "header",
  headers: ["Authorization", "X-Team"],
  revision: 1,
  status: "ok",
  testedAt: "2026-11-17T09:00:00.000Z",
  testErrorCode: null,
  tools: TOOLS,
  createdAt: "2026-11-17T08:00:00.000Z",
  updatedAt: "2026-11-17T09:00:00.000Z",
};
const BROKEN: McpServerView = {
  ...LINEAR,
  id: "s2",
  name: "Docs",
  auth: "none",
  headers: [],
  status: "failed",
  testErrorCode: "mcp_test_unauthorized",
  tools: null,
};

function fakeApi(
  servers: McpServerView[] = [LINEAR, BROKEN],
  overrides: Partial<McpApi> = {},
) {
  const sent: McpServerForm[] = [];
  const removed: string[] = [];
  const api: McpApi = {
    list: async () => ok({ servers }),
    create: async (form) => {
      sent.push(form);
      return ok({
        server: {
          ...LINEAR,
          id: "s3",
          name: form.name,
          url: form.url,
          transport: form.transport,
          auth: form.auth.kind,
          headers:
            form.auth.kind === "header"
              ? form.auth.headers.map((header) => header.name)
              : [],
          status: "untested" as const,
          testedAt: null,
          tools: null,
        },
      });
    },
    update: async (id, form) => {
      sent.push(form);
      return ok({ server: { ...LINEAR, id, name: form.name, revision: 2 } });
    },
    remove: async (id) => {
      removed.push(id);
      return ok({ removed: true as const });
    },
    test: async (id) =>
      ok({
        server: { ...LINEAR, id, name: id === "s3" ? "New one" : LINEAR.name },
      }),
    ...overrides,
  };
  return { api, sent, removed };
}

function show(api: McpApi, canManage: boolean) {
  return render(
    <CapabilitiesProvider capabilities={["review", "implementer"]}>
      <ProductIdentityProvider product={identityFor("factory")}>
        <McpPanel workspaceSlug="acme" canManage={canManage} api={api} />
      </ProductIdentityProvider>
    </CapabilitiesProvider>,
  );
}

describe("the list of MCP servers", () => {
  // #1050-T01
  it("shows address, transport, header names with a mask, the last test and the tools of each server, and no value", async () => {
    show(fakeApi().api, true);

    const linear = (
      await screen.findByRole("heading", { name: "Linear" })
    ).closest("li") as HTMLElement;
    expect(
      within(linear).getByText("https://mcp.linear.example/mcp"),
    ).toBeTruthy();
    expect(within(linear).getByText("Streamable HTTP")).toBeTruthy();
    expect(within(linear).getByText(/Authorization:/)).toBeTruthy();
    expect(within(linear).getByText(/X-Team:/)).toBeTruthy();
    expect(within(linear).getAllByLabelText("masked value")).toHaveLength(2);
    expect(
      within(linear).getByText(/Connected\. Tested 2026-11-17 09:00 UTC/),
    ).toBeTruthy();
    expect(
      within(linear).getByText(/1 tool · Server Fake Issues 1\.2\.3/),
    ).toBeTruthy();
    expect(within(linear).getByText("search_issues")).toBeTruthy();
    const docs = screen
      .getByRole("heading", { name: "Docs" })
      .closest("li") as HTMLElement;
    expect(within(docs).getByText(/refused the credentials/)).toBeTruthy();
  });

  // #1050-T01
  it("shows a member the list and no way to add, test, change or remove", async () => {
    show(fakeApi().api, false);

    await screen.findByText("Linear");
    for (const name of [
      /add mcp server/i,
      /^test connection/i,
      /^edit/i,
      /^remove/i,
    ])
      expect(screen.queryByRole("button", { name })).toBeNull();
  });

  it("says so when there is no server, and offers to try again when the list cannot be loaded", async () => {
    show(fakeApi([]).api, true);
    expect(await screen.findByText(/No MCP server yet/)).toBeTruthy();
    cleanup();

    let attempts = 0;
    show(
      fakeApi([LINEAR], {
        list: async () => {
          attempts += 1;
          return attempts === 1
            ? refused(500, "UNEXPECTED_RESPONSE")
            : ok({ servers: [LINEAR] });
        },
      }).api,
      true,
    );
    await userEvent.click(
      await screen.findByRole("button", { name: /try again/i }),
    );
    expect(await screen.findByText("Linear")).toBeTruthy();
  });
});

describe("adding a server", () => {
  // #1050-T01
  it("sends the header secret to the route, tests the new server at once and shows its tools", async () => {
    const user = userEvent.setup();
    const { api, sent } = fakeApi([]);
    show(api, true);

    await user.click(
      await screen.findByRole("button", { name: /add mcp server/i }),
    );
    await user.type(screen.getByLabelText("Name"), "New one");
    await user.type(
      screen.getByLabelText("Address"),
      "https://mcp.example.com/mcp",
    );
    await user.type(
      screen.getByLabelText("Header value"),
      "Bearer fake-secret",
    );
    await user.click(screen.getByRole("button", { name: "Save" }));

    const card = (
      await screen.findByRole("heading", { name: "New one" })
    ).closest("li") as HTMLElement;
    expect(sent).toEqual([
      {
        name: "New one",
        transport: "streamable-http",
        url: "https://mcp.example.com/mcp",
        auth: {
          kind: "header",
          headers: [{ name: "Authorization", value: "Bearer fake-secret" }],
        },
      },
    ]);
    expect(await within(card).findByText(/Connected\./)).toBeTruthy();
    // The secret is not on the page once it was sent.
    expect(document.body.textContent).not.toContain("fake-secret");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  // #1050-T02
  it("shows the refusal of an address at the field, in a sentence of our own", async () => {
    const user = userEvent.setup();
    const { api } = fakeApi([], {
      create: async () => refused(422, "mcp_url_private"),
    });
    show(api, true);

    await user.click(
      await screen.findByRole("button", { name: /add mcp server/i }),
    );
    await user.type(screen.getByLabelText("Name"), "Local");
    await user.type(screen.getByLabelText("Address"), "https://10.0.0.5/mcp");
    await user.type(screen.getByLabelText("Header value"), "x");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(
      await screen.findByText(
        /names this machine or a private or internal network/,
      ),
    ).toBeTruthy();
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("offers no authentication kind that is not available yet", async () => {
    const user = userEvent.setup();
    show(fakeApi([]).api, true);

    await user.click(
      await screen.findByRole("button", { name: /add mcp server/i }),
    );

    expect(
      (screen.getByRole("option", { name: /OAuth/ }) as HTMLOptionElement)
        .disabled,
    ).toBe(true);
  });
});

describe("changing a server", () => {
  // #1050-T01
  it("keeps a stored header when its value is left empty, and never loads the value into the form", async () => {
    const user = userEvent.setup();
    const { api, sent } = fakeApi();
    show(api, true);

    await user.click(
      await screen.findByRole("button", { name: "Edit Linear" }),
    );
    const values = screen.getAllByLabelText(
      "Header value",
    ) as HTMLInputElement[];
    expect(values.map((input) => input.value)).toEqual(["", ""]);
    expect(values[0]?.placeholder).toMatch(/Leave empty to keep it/);
    await user.clear(screen.getByLabelText("Name"));
    await user.type(screen.getByLabelText("Name"), "Linear 2");
    await user.type(values[1] as HTMLInputElement, "new-value");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(
      await screen.findByRole("heading", { name: "Linear 2" }),
    ).toBeTruthy();
    expect(sent[0]).toMatchObject({
      name: "Linear 2",
      revision: 1,
      auth: {
        kind: "header",
        headers: [
          { name: "Authorization", keep: true },
          { name: "X-Team", value: "new-value" },
        ],
      },
    });
  });

  it("asks for a value again when the name of a stored header is changed", async () => {
    const user = userEvent.setup();
    const { api, sent } = fakeApi();
    show(api, true);

    await user.click(
      await screen.findByRole("button", { name: "Edit Linear" }),
    );
    const names = screen.getAllByLabelText("Header name");
    await user.clear(names[0] as HTMLElement);
    await user.type(names[0] as HTMLElement, "X-Api-Key");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await screen.findByRole("heading", { name: "Linear" });
    expect(sent[0]?.auth).toMatchObject({
      headers: [
        { name: "X-Api-Key", value: "" },
        { name: "X-Team", keep: true },
      ],
    });
  });
});

describe("testing and removing a server", () => {
  // #1050-T01
  it("tests the connection and shows what the server answered, or the sentence of the failure", async () => {
    const user = userEvent.setup();
    const { api } = fakeApi([BROKEN], {
      test: async () =>
        ok({
          server: {
            ...BROKEN,
            status: "failed" as const,
            testErrorCode: "mcp_test_timeout",
          },
        }),
    });
    show(api, true);

    await user.click(
      await screen.findByRole("button", { name: "Test connection Docs" }),
    );

    expect(await screen.findByText(/did not answer in time/)).toBeTruthy();
  });

  it("says the limit when too many tests were made", async () => {
    const user = userEvent.setup();
    const { api } = fakeApi([LINEAR], {
      test: async () => refused(429, "rate_limited"),
    });
    show(api, true);

    await user.click(
      await screen.findByRole("button", { name: "Test connection Linear" }),
    );

    expect(await screen.findByText(/Too many connection tests/)).toBeTruthy();
  });

  it("removes a server after a confirmation", async () => {
    const user = userEvent.setup();
    const { api, removed } = fakeApi();
    show(api, true);

    await user.click(
      await screen.findByRole("button", { name: "Remove Docs" }),
    );
    expect(removed).toEqual([]);
    await user.click(screen.getByRole("button", { name: "Remove" }));

    expect(removed).toEqual(["s2"]);
    expect(screen.queryByRole("heading", { name: "Docs" })).toBeNull();
    expect(await screen.findByText("The server was removed.")).toBeTruthy();
  });

  // #1050-T03
  it("keeps a server a lane uses and names the lane and its project", async () => {
    const user = userEvent.setup();
    const { api } = fakeApi([LINEAR], {
      remove: async () =>
        refused(409, "mcp_server_in_use", {
          lanes: [{ id: "l1", name: "Triage", projectName: "acme/app" }],
        }),
    });
    show(api, true);

    await user.click(
      await screen.findByRole("button", { name: "Remove Linear" }),
    );
    await user.click(screen.getByRole("button", { name: "Remove" }));

    expect(
      await screen.findByText(
        /A lane still uses this server: Triage \(acme\/app\)/,
      ),
    ).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Linear" })).toBeTruthy();
  });
});
