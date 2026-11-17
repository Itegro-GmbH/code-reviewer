// SPDX-License-Identifier: LicenseRef-Proprietary

// @vitest-environment jsdom
// "Add from catalog" on the MCP page (#1054): the list of presets, the prefilled add dialog, and that a server added from a preset is posted
// exactly as the same server typed by hand. The routes are a stand-in; no network.
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { CapabilitiesProvider } from "../../capabilities/context.tsx";
import { ProductIdentityProvider } from "../../product-identity/context.tsx";
import { identityFor } from "../../product-identity/identities.ts";
import type { RequestResult } from "../../ui/json-request.ts";
import { findCatalogEntry, MCP_CATALOG } from "../catalog/entries.ts";
import { presetToForm } from "../catalog/preset.ts";
import type { McpServerView } from "../service.ts";
import type { McpApi, McpServerForm } from "./api.ts";
import { McpPanel } from "./mcp-panel.tsx";

afterEach(cleanup);

const ok = <T,>(data: T): RequestResult<T> => ({ ok: true, data });

const BASE: McpServerView = {
  id: "s1",
  name: "x",
  transport: "streamable-http",
  url: "https://x.example/mcp",
  auth: "none",
  headers: [],
  revision: 1,
  status: "untested",
  testedAt: null,
  testErrorCode: null,
  tools: null,
  oauth: null,
  createdAt: "2026-11-17T08:00:00.000Z",
  updatedAt: "2026-11-17T08:00:00.000Z",
};

function fakeApi() {
  const sent: McpServerForm[] = [];
  const connected: string[] = [];
  const tested: string[] = [];
  const made = new Map<string, McpServerView>();
  const api: McpApi = {
    list: async () => ok({ servers: [] }),
    create: async (form) => {
      sent.push(form);
      const server: McpServerView = {
        ...BASE,
        id: `s${String(sent.length)}`,
        name: form.name,
        url: form.url,
        transport: form.transport,
        auth: form.auth.kind,
        headers:
          form.auth.kind === "header"
            ? form.auth.headers.map((header) => header.name)
            : [],
        oauth:
          form.auth.kind === "oauth"
            ? {
                status: "unconnected" as const,
                connectedAt: null,
                scopes: [],
                clientSource: null,
                clientId: null,
                clientIssuer: null,
                hasClientSecret: false,
                errorCode: null,
              }
            : null,
      };
      made.set(server.id, server);
      return ok({ server });
    },
    update: async () => ok({ server: BASE }),
    remove: async () => ok({ removed: true as const }),
    test: async (id) => {
      tested.push(id);
      return ok({ server: made.get(id) ?? BASE });
    },
    connect: async (id) => {
      connected.push(id);
      return ok({
        ok: true as const,
        url: "https://as.example.com/authorize?x=1",
        issuerHost: "as.example.com",
        scopes: ["read"],
      });
    },
  };
  return { api, sent, connected, tested };
}

function show(api: McpApi, canManage = true) {
  return render(
    <CapabilitiesProvider capabilities={["review", "implementer"]}>
      <ProductIdentityProvider product={identityFor("factory")}>
        <McpPanel workspaceSlug="acme" canManage={canManage} api={api} />
      </ProductIdentityProvider>
    </CapabilitiesProvider>,
  );
}

async function openCatalog(user: ReturnType<typeof userEvent.setup>) {
  await user.click(
    await screen.findByRole("button", { name: "Add from catalog" }),
  );
  return screen.findByRole("dialog", { name: "MCP server catalog" });
}

describe("add from the catalog", () => {
  it("lists every preset with a monogram, how it signs in and the day it was checked, and offers it to a manager only", async () => {
    const user = userEvent.setup();
    const { api } = fakeApi();
    show(api);
    const catalog = await openCatalog(user);
    for (const entry of MCP_CATALOG) {
      expect(within(catalog).getByText(entry.description)).toBeTruthy();
      expect(
        within(catalog).getByRole("button", { name: `Choose ${entry.name}` }),
      ).toBeTruthy();
    }
    expect(within(catalog).getAllByText(/Checked 2026-11-17/).length).toBe(
      MCP_CATALOG.length,
    );
    expect(within(catalog).queryByRole("img")).toBeNull();

    cleanup();
    show(fakeApi().api, false);
    await screen.findByText(/MCP servers · 0/);
    expect(
      screen.queryByRole("button", { name: "Add from catalog" }),
    ).toBeNull();
  });

  it("prefills the add dialog from the preset, asks for the value of the right header, and saves nothing by itself", async () => {
    const user = userEvent.setup();
    const { api, sent } = fakeApi();
    show(api);
    const catalog = await openCatalog(user);
    await user.click(
      within(catalog).getByRole("button", { name: "Choose Stripe" }),
    );

    const dialog = await screen.findByRole("dialog", {
      name: "Add MCP server",
    });
    expect(within(dialog).getByLabelText<HTMLInputElement>("Name").value).toBe(
      "Stripe",
    );
    expect(
      within(dialog).getByLabelText<HTMLInputElement>("Address").value,
    ).toBe("https://mcp.stripe.com");
    expect(
      within(dialog).getByLabelText<HTMLInputElement>("Header name").value,
    ).toBe("Authorization");
    const value =
      within(dialog).getByLabelText<HTMLInputElement>("Header value");
    expect(value.value).toBe("");
    expect(value.placeholder).toBe("Bearer <agent API key>");
    expect(within(dialog).getByTestId("catalog-note").textContent).toMatch(
      /From the catalog: Stripe/,
    );
    expect(
      within(dialog)
        .getByRole("link", { name: "Vendor documentation" })
        .getAttribute("href"),
    ).toBe("https://docs.stripe.com/mcp");

    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(sent).toEqual([]);
  });

  // #1054-T02
  it("creates the same row from a header preset as the dialog filled in by hand", async () => {
    const user = userEvent.setup();
    const { api, sent } = fakeApi();
    show(api);

    // By hand.
    await user.click(
      await screen.findByRole("button", { name: "Add MCP server" }),
    );
    await user.type(screen.getByLabelText("Name"), "GitHub");
    await user.type(
      screen.getByLabelText("Address"),
      "https://api.githubcopilot.com/mcp/",
    );
    await user.type(screen.getByLabelText("Header value"), "Bearer fake-token");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByRole("heading", { name: "GitHub" });

    // From the catalog (the workspace may hold two servers of one name here: the stand-in does not refuse it).
    const catalog = await openCatalog(user);
    await user.click(
      within(catalog).getByRole("button", { name: "Choose GitHub" }),
    );
    await user.type(screen.getByLabelText("Header value"), "Bearer fake-token");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await screen.findAllByRole("heading", { name: "GitHub" });

    expect(sent).toHaveLength(2);
    expect(sent[1]).toEqual(sent[0]);
    const entry = findCatalogEntry("github");
    if (entry === undefined) throw new Error("the entry is missing");
    expect(sent[1]).toEqual(presetToForm(entry, "Bearer fake-token"));
    expect(document.body.textContent).not.toContain("fake-token");
  });

  // #1054-T02
  it("creates the same row from an OAuth preset as the dialog filled in by hand, then goes to Connect", async () => {
    const user = userEvent.setup();
    const { api, sent, connected, tested } = fakeApi();
    show(api);

    await user.click(
      await screen.findByRole("button", { name: "Add MCP server" }),
    );
    await user.selectOptions(screen.getByLabelText("Authentication"), "oauth");
    await user.type(screen.getByLabelText("Name"), "Linear");
    await user.type(
      screen.getByLabelText("Address"),
      "https://mcp.linear.app/mcp",
    );
    await user.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByRole("heading", { name: "Linear" });
    // By hand there is no automatic Connect: the card has its button.
    expect(connected).toEqual([]);

    const catalog = await openCatalog(user);
    await user.click(
      within(catalog).getByRole("button", { name: "Choose Linear" }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Add MCP server",
    });
    expect(
      within(dialog).getByLabelText<HTMLSelectElement>("Authentication").value,
    ).toBe("oauth");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));

    expect(sent).toHaveLength(2);
    expect(sent[1]).toEqual(sent[0]);
    // The catalog entry goes on to Connect: the person confirms the authorization server before the browser leaves.
    expect(await screen.findByText("Continue to as.example.com?")).toBeTruthy();
    expect(connected).toEqual(["s2"]);
    expect(tested).toEqual([]);
  });
});
