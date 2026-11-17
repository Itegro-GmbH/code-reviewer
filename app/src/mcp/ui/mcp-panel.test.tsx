// SPDX-License-Identifier: LicenseRef-Proprietary

// @vitest-environment jsdom
// The MCP page (#1050), with a stand-in for the routes: the list with address, transport, header NAMES with a mask, the last test and its
// tools; adding a server with a header secret (tested at once, the secret only on its way to the route); keeping a stored header on an edit;
// removing after a confirmation, and the refusal that names the lanes; read only for a member; and the sentence of every refusal.
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { ComponentProps } from "react";
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
  oauth: null,
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
    connect: async () =>
      ok({ ok: true as const, url: "https://as.example.com/authorize?x=1" }),
    ...overrides,
  };
  return { api, sent, removed };
}

function show(
  api: McpApi,
  canManage: boolean,
  extra: Partial<ComponentProps<typeof McpPanel>> = {},
) {
  return render(
    <CapabilitiesProvider capabilities={["review", "implementer"]}>
      <ProductIdentityProvider product={identityFor("factory")}>
        <McpPanel
          workspaceSlug="acme"
          canManage={canManage}
          api={api}
          {...extra}
        />
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

  // #1051-T01
  it("offers OAuth, with an optional client of its own, and sends the form without a secret in the list", async () => {
    const user = userEvent.setup();
    const { api, sent } = fakeApi([]);
    show(api, true, {
      callbackUrl: "https://factory.example.test/api/mcp/oauth/callback",
    });

    await user.click(
      await screen.findByRole("button", { name: /add mcp server/i }),
    );
    await user.selectOptions(screen.getByLabelText("Authentication"), "oauth");
    await user.type(screen.getByLabelText("Name"), "Notion");
    await user.type(
      screen.getByLabelText("Address"),
      "https://mcp.notion.example/mcp",
    );

    // Nothing to enter for a server that registers clients itself, and the redirect address is shown for one that does not.
    expect(screen.getByText(/leave both empty/i)).toBeTruthy();
    expect(
      screen.getByText(
        /https:\/\/factory\.example\.test\/api\/mcp\/oauth\/callback/,
      ),
    ).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(sent[0]?.auth).toEqual({
      kind: "oauth",
      clientId: "",
      clientSecret: "",
    });
  });
});

const OAUTH: McpServerView = {
  ...LINEAR,
  id: "s9",
  name: "Notion",
  auth: "oauth",
  headers: [],
  status: "untested",
  testedAt: null,
  tools: null,
  oauth: {
    status: "unconnected",
    errorCode: null,
    clientSource: null,
    clientId: null,
    hasClientSecret: false,
    scopes: [],
    connectedAt: null,
  },
};
const CONNECTED: McpServerView = {
  ...OAUTH,
  id: "s10",
  name: "Linear OAuth",
  oauth: {
    ...OAUTH.oauth!,
    status: "connected",
    connectedAt: "2026-11-17T10:00:00.000Z",
    scopes: ["issues:read"],
  },
};
const BROKEN_OAUTH: McpServerView = {
  ...CONNECTED,
  id: "s11",
  name: "Sentry",
  oauth: {
    ...CONNECTED.oauth!,
    status: "broken",
    errorCode: "mcp_oauth_refresh_refused",
    connectedAt: null,
  },
};

describe("a server that uses OAuth", () => {
  const card = async (name: string) =>
    (await screen.findByRole("heading", { name })).closest("li") as HTMLElement;

  // #1051-T01
  it("shows its state, offers Connect, Reconnect for a broken one, and sends the browser to the consent page", async () => {
    const user = userEvent.setup();
    const visited: string[] = [];
    show(fakeApi([OAUTH, CONNECTED, BROKEN_OAUTH]).api, true, {
      navigate: (url) => visited.push(url),
    });

    const notion = await card("Notion");
    expect(within(notion).getByText(/not connected yet/i)).toBeTruthy();
    expect(
      within(await card("Linear OAuth")).getByText(
        /Connected\. 2026-11-17 10:00 UTC/,
      ),
    ).toBeTruthy();
    expect(
      within(await card("Sentry")).getByText(/ended the grant/i),
    ).toBeTruthy();
    expect(
      within(await card("Sentry")).getByRole("button", {
        name: "Reconnect Sentry",
      }),
    ).toBeTruthy();

    await user.click(
      within(notion).getByRole("button", { name: "Connect Notion" }),
    );

    await waitFor(() =>
      expect(visited).toEqual(["https://as.example.com/authorize?x=1"]),
    );
  });

  it("says why a connection could not be started, in a sentence of our own", async () => {
    const user = userEvent.setup();
    show(
      fakeApi([OAUTH], {
        connect: async () => refused(422, "mcp_oauth_client_required"),
      }).api,
      true,
    );

    await user.click(
      await screen.findByRole("button", { name: "Connect Notion" }),
    );

    expect(
      await screen.findByText(/cannot register this application by itself/),
    ).toBeTruthy();
  });

  it("offers no Connect button to a member", async () => {
    show(fakeApi([OAUTH]).api, false);

    await screen.findByRole("heading", { name: "Notion" });

    expect(screen.queryByRole("button", { name: /connect/i })).toBeNull();
  });

  // #1051-T01
  it("tests the server once when the browser comes back from the consent page, and shows what the round trip said", async () => {
    const tested: string[] = [];
    show(
      fakeApi([CONNECTED], {
        test: async (id) => {
          tested.push(id);
          return ok({
            server: {
              ...CONNECTED,
              status: "ok",
              testedAt: "2026-11-17T10:01:00.000Z",
              tools: TOOLS,
            },
          });
        },
      }).api,
      true,
      { roundTrip: { code: "connected", serverId: "s10" } },
    );

    expect(
      await screen.findByText(
        /Connected\. The server's tools are being listed/,
      ),
    ).toBeTruthy();
    await waitFor(() => expect(tested).toEqual(["s10"]));
  });

  // #1051-T03
  it("shows a refusal of the round trip as a problem and tests nothing", async () => {
    const tested: string[] = [];
    show(
      fakeApi([OAUTH], {
        test: async (id) => {
          tested.push(id);
          return ok({ server: OAUTH });
        },
      }).api,
      true,
      { roundTrip: { code: "state_invalid", serverId: null } },
    );

    expect(
      await screen.findByText(/link was used before, expired/),
    ).toBeTruthy();
    expect(tested).toEqual([]);
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

describe("changing the address of a server that has stored keys", () => {
  // #1050-T02
  it("asks for the values again and sends nothing when the address changed and a value is left empty", async () => {
    const user = userEvent.setup();
    const { api, sent } = fakeApi();
    show(api, true);

    await user.click(
      await screen.findByRole("button", { name: "Edit Linear" }),
    );
    const url = screen.getByLabelText("Address");
    await user.clear(url);
    await user.type(url, "https://mcp.mine.example/mcp");
    const values = screen.getAllByLabelText(
      "Header value",
    ) as HTMLInputElement[];
    expect(values[0]?.placeholder).toMatch(/enter this value again/);
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toMatch(
      /enter the header values again/,
    );
    expect(sent).toEqual([]);
  });

  // #1050-T02
  it("sends every value as a value, and no keep, when the address changed and the values are entered again", async () => {
    const user = userEvent.setup();
    const { api, sent } = fakeApi();
    show(api, true);

    await user.click(
      await screen.findByRole("button", { name: "Edit Linear" }),
    );
    const url = screen.getByLabelText("Address");
    await user.clear(url);
    await user.type(url, "https://mcp.mine.example/mcp");
    const values = screen.getAllByLabelText(
      "Header value",
    ) as HTMLInputElement[];
    await user.type(values[0] as HTMLInputElement, "one");
    await user.type(values[1] as HTMLInputElement, "two");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await screen.findByRole("heading", { name: "Linear" });
    expect(sent[0]).toMatchObject({
      url: "https://mcp.mine.example/mcp",
      revision: 1,
      auth: {
        headers: [
          { name: "Authorization", value: "one" },
          { name: "X-Team", value: "two" },
        ],
      },
    });
  });

  // #1050-T02
  it("asks again when the transport changes, and says in the form that keys belong in headers", async () => {
    const user = userEvent.setup();
    const { api, sent } = fakeApi();
    show(api, true);

    await user.click(
      await screen.findByRole("button", { name: "Edit Linear" }),
    );
    await user.selectOptions(screen.getByLabelText("Transport"), "sse");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(sent).toEqual([]);
    expect(
      screen.getByText(/belong here, in a header, and not in the address/),
    ).toBeTruthy();
  });
});

describe("the tool list of a server", () => {
  // #1050-T01
  it("shows a tool that a server lists twice both times", async () => {
    const twice: McpServerView = {
      ...LINEAR,
      tools: {
        ...TOOLS,
        tools: [
          { name: "search", description: "First." },
          { name: "search", description: "Second." },
        ],
      },
    };
    show(fakeApi([twice]).api, true);

    expect(await screen.findByText("First.")).toBeTruthy();
    expect(screen.getByText("Second.")).toBeTruthy();
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
