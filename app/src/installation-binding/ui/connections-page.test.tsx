// SPDX-License-Identifier: LicenseRef-Proprietary

// @vitest-environment jsdom
// Pins down the Connections page: what a flow just ended with, the connections with their state, the buttons an
// Owner or Admin gets (and a Member does not), what is said while Connect GitHub cannot be offered, the list of
// installations to choose from, the two-step end of a connection, and that names from GitHub are text.
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

const navigation = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: navigation.refresh }),
}));

import type { BindingApi } from "./api.ts";
import { ConnectionsPanel } from "./connections-panel.tsx";
import {
  ConnectionsPageContent,
  type ConnectionsPageData,
} from "./connections-page.tsx";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const URL_ON_GITHUB = "https://github.test/apps/x/installations/new?state=abc";

function data(
  overrides: Partial<ConnectionsPageData> = {},
): ConnectionsPageData {
  return {
    connect: "available",
    picker: true,
    connections: [],
    requests: [],
    notice: null,
    choices: null,
    ...overrides,
  };
}

function api(overrides: Partial<BindingApi> = {}): BindingApi {
  return {
    connect: vi.fn(async () => ({
      ok: true as const,
      data: { ok: true as const, url: URL_ON_GITHUB },
    })),
    startPicker: vi.fn(async () => ({
      ok: true as const,
      data: { ok: true as const, url: URL_ON_GITHUB },
    })),
    choose: vi.fn(async () => ({
      ok: true as const,
      data: { ok: true as const, url: URL_ON_GITHUB },
    })),
    disconnect: vi.fn(async () => ({
      ok: true as const,
      data: { ok: true as const },
    })),
    sync: vi.fn(),
    ...overrides,
  };
}

function renderPanel(
  pageData: ConnectionsPageData,
  options: {
    canManage?: boolean;
    api?: BindingApi;
    go?: (url: string) => void;
  } = {},
) {
  const calls = options.api ?? api();
  const go = options.go ?? vi.fn();
  render(
    <ConnectionsPanel
      workspaceSlug="acme"
      canManage={options.canManage ?? true}
      data={pageData}
      api={calls}
      go={go}
    />,
  );
  return { api: calls, go };
}

describe("the page", () => {
  // #176-T01
  it("renders one h1 without a breadcrumb (its own area root) and three cards with the expected headings", () => {
    render(
      <ConnectionsPageContent
        workspaceSlug="acme"
        canManage
        data={data()}
        api={api()}
      />,
    );

    expect(
      screen.getByRole("heading", { level: 1, name: "Connections" }),
    ).toBeTruthy();
    // Connections is its own area root, not below Settings (lead decision 2026-10-13).
    expect(screen.queryByRole("navigation", { name: "breadcrumb" })).toBeNull();
    expect(
      screen.getByRole("heading", { level: 2, name: "Installations" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("heading", { level: 2, name: "Connect" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("heading", { level: 2, name: "Requests" }),
    ).toBeTruthy();
  });
});

describe("the buttons", () => {
  // #103-IB-02
  it("sends the browser to the address the route answered when an Owner or Admin presses Connect GitHub", async () => {
    const user = userEvent.setup();
    const { api: calls, go } = renderPanel(data());

    await user.click(screen.getByRole("button", { name: "Connect GitHub" }));

    expect(calls.connect).toHaveBeenCalledTimes(1);
    expect(go).toHaveBeenCalledWith(URL_ON_GITHUB);
  });

  // #103-IB-15
  it("shows a Member the connections and no button", () => {
    renderPanel(
      data({
        connections: [
          {
            id: "i1",
            accountLogin: "acme",
            accountType: "Organization",
            status: "active",
            repositoryCount: 2,
            avatarUrl: null,
          },
        ],
        requests: null,
      }),
      { canManage: false },
    );

    expect(screen.getByRole("list", { name: "Installations" })).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByText("Connect GitHub")).toBeNull();
  });

  // #103-IB-22, #176-T03
  it.each([
    ["app_not_configured", /not set up yet/],
    [
      "user_authorization_not_configured",
      /Connecting GitHub is not available yet/,
    ],
  ] as const)(
    "does not offer Connect GitHub while it cannot work (%s), and says why in exactly one alert",
    (connect, reason) => {
      renderPanel(data({ connect, picker: false }));

      expect(
        (
          screen.getByRole("button", {
            name: "Connect GitHub",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(true);
      const reasons = screen.getAllByRole("note");
      expect(reasons).toHaveLength(1);
      expect(reasons[0]?.textContent).toMatch(reason);
      expect(
        screen.queryByRole("button", { name: "Link an existing installation" }),
      ).toBeNull();
    },
  );

  // #176-T03
  it("points the disabled Connect GitHub button at the one blocked reason", () => {
    renderPanel(
      data({ connect: "user_authorization_not_configured", picker: false }),
    );

    const button = screen.getByRole("button", { name: "Connect GitHub" });
    const reason = screen.getByRole("note");
    expect(reason.id).not.toBe("");
    expect(button.getAttribute("aria-describedby")).toBe(reason.id);
  });

  // #176-T03
  it("does not describe the Connect GitHub button with a reason while it is offered", () => {
    renderPanel(data({ connect: "needs_approval", picker: false }));

    const button = screen.getByRole("button", { name: "Connect GitHub" });
    expect(button.getAttribute("aria-describedby")).toBeNull();
  });

  // #103-IB-22
  it("offers Connect GitHub but says that the admin of the instance decides, while nobody's rights can be checked", () => {
    renderPanel(data({ connect: "needs_approval", picker: false }));

    expect(
      (
        screen.getByRole("button", {
          name: "Connect GitHub",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
    expect(screen.getByRole("note").textContent).toMatch(/admin approves/);
  });

  // #103-IB-10
  it("shows the list of installations to choose from and starts the link of the one chosen", async () => {
    const user = userEvent.setup();
    const { api: calls, go } = renderPanel(
      data({
        choices: {
          picker: "signed-list",
          entries: [
            {
              installationId: "4242",
              accountLogin: "acme",
              accountType: "Organization",
            },
            {
              installationId: "4300",
              accountLogin: "octo",
              accountType: "User",
            },
          ],
        },
      }),
    );

    const list = screen.getByRole("list", {
      name: "Installations you can link",
    });
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);
    await user.click(within(list).getByRole("button", { name: "Link octo" }));

    expect(calls.choose).toHaveBeenCalledWith("signed-list", "4300");
    expect(go).toHaveBeenCalledWith(URL_ON_GITHUB);
  });

  // #103-IB-10
  it("says so when no installation is left to choose from", () => {
    renderPanel(data({ choices: { picker: "p", entries: [] } }));

    expect(
      screen.getByText(/shows no installation that you can use/),
    ).toBeTruthy();
  });

  // #103-IB-02
  it("says in words why a start failed and stays on the page", async () => {
    const user = userEvent.setup();
    const { go } = renderPanel(data(), {
      api: api({
        connect: vi.fn(async () => ({
          ok: false as const,
          status: 429,
          code: "rate_limited",
          issues: [],
        })),
      }),
    });

    await user.click(screen.getByRole("button", { name: "Connect GitHub" }));

    expect(await screen.findByText(/Too many attempts/)).toBeTruthy();
    expect(go).not.toHaveBeenCalled();
  });
});

describe("what a flow ended with", () => {
  // #103-IB-10
  it("shows the notice of a flow that ended well as a status", () => {
    renderPanel(
      data({ notice: { tone: "info", text: "Nothing is connected yet." } }),
    );

    expect(screen.getByRole("status").textContent).toBe(
      "Nothing is connected yet.",
    );
    expect(screen.queryByRole("alert")).toBeNull();
  });

  // #103-IB-04
  it("shows the notice of a refusal as a polite status, not a dialog", () => {
    renderPanel(
      data({
        notice: {
          tone: "error",
          text: "That installation cannot be connected.",
        },
      }),
    );

    expect(screen.getByRole("status").textContent).toBe(
      "That installation cannot be connected.",
    );
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("a connection", () => {
  const connection = {
    id: "i1",
    accountLogin: "acme",
    accountType: "Organization",
    status: "active" as const,
    repositoryCount: 1,
    avatarUrl: null,
  };

  // #103-IB-14, #176-T02
  it("is ended in two steps: the first press opens a dialog, the confirmation ends it and the page reloads", async () => {
    const user = userEvent.setup();
    const { api: calls } = renderPanel(data({ connections: [connection] }));

    await user.click(screen.getByRole("button", { name: "Disconnect acme" }));
    expect(calls.disconnect).not.toHaveBeenCalled();
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText(/Projects and runs stay/)).toBeTruthy();
    await user.click(
      within(dialog).getByRole("button", {
        name: "Confirm disconnecting acme",
      }),
    );

    expect(calls.disconnect).toHaveBeenCalledTimes(1);
    expect(calls.disconnect).toHaveBeenCalledWith("i1");
    expect(navigation.refresh).toHaveBeenCalledTimes(1);
  });

  // #103-IB-14, #176-T02
  it("is not ended when the person cancels the dialog", async () => {
    const user = userEvent.setup();
    const { api: calls } = renderPanel(data({ connections: [connection] }));

    await user.click(screen.getByRole("button", { name: "Disconnect acme" }));
    const dialog = await screen.findByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));

    expect(calls.disconnect).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "Disconnect acme" }),
    ).toBeTruthy();
  });

  // #103-IB-14
  it("shows an ended connection as disconnected, without a button", () => {
    renderPanel(
      data({
        connections: [{ ...connection, status: "disconnected" as const }],
      }),
    );

    expect(screen.getByText("Disconnected")).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: /Disconnect acme/ }),
    ).toBeNull();
  });

  // #103-IB-10
  it("renders a name from GitHub as text, never as markup", () => {
    const hostile = '<img src=x onerror="alert(1)">';
    renderPanel(
      data({ connections: [{ ...connection, accountLogin: hostile }] }),
    );

    expect(screen.getByText(hostile)).toBeTruthy();
    expect(document.querySelector("img")).toBeNull();
  });

  // #638-T02
  it("shows the avatar of the account, or its initials while there is none", () => {
    renderPanel(
      data({
        connections: [
          {
            ...connection,
            avatarUrl: "https://avatars.githubusercontent.com/u/5001?v=4",
          },
          {
            ...connection,
            id: "i2",
            accountLogin: "helios-labs",
            avatarUrl: null,
          },
        ],
      }),
    );

    const [withAvatar, withoutAvatar] = Array.from(
      document.querySelectorAll<HTMLElement>("[data-connection]"),
    );
    expect(withAvatar!.querySelector("img")?.getAttribute("src")).toBe(
      "https://avatars.githubusercontent.com/u/5001?v=4",
    );
    expect(withoutAvatar!.querySelector("img")).toBeNull();
    expect(withoutAvatar!.textContent).toContain("HL");
  });

  // #638-T03
  it("loads no avatar from a host other than GitHub's avatar host", () => {
    renderPanel(
      data({
        connections: [
          {
            ...connection,
            accountLogin: "acme-corp",
            avatarUrl: "https://avatars.example.test/u/1",
          },
        ],
      }),
    );

    expect(document.querySelector("img")).toBeNull();
    expect(screen.getByText("AC")).toBeTruthy();
  });
});

describe("the requests", () => {
  // #103-IB-19
  it("lists the requests of the workspace with their state for an Owner or Admin", () => {
    renderPanel(
      data({
        requests: [
          {
            id: "r1",
            accountLogin: "acme",
            status: "pending",
            createdAt: "2026-10-12T10:00:00.000Z",
            decidedAt: null,
          },
          {
            id: "r2",
            accountLogin: "beta",
            status: "denied",
            createdAt: "2026-10-11T10:00:00.000Z",
            decidedAt: "2026-10-11T12:00:00.000Z",
          },
        ],
      }),
    );

    const list = screen.getByRole("list", {
      name: "Requests for the code-review.com admin",
    });
    const items = within(list).getAllByRole("listitem");
    expect(items[0]?.textContent).toMatch(
      /Waiting for a code-review.com admin/,
    );
    expect(items[1]?.textContent).toMatch(/Denied by a code-review.com admin/);
  });

  // #103-IB-15
  it("does not show them to a Member", () => {
    renderPanel(data({ requests: null }), { canManage: false });

    expect(
      screen.queryByRole("list", {
        name: "Requests for the code-review.com admin",
      }),
    ).toBeNull();
  });

  // #176-T01
  it("shows one empty line while no request waits", () => {
    renderPanel(data({ requests: [] }));

    expect(
      screen.queryByRole("list", {
        name: "Requests for the code-review.com admin",
      }),
    ).toBeNull();
    expect(screen.getByText("No requests waiting.")).toBeTruthy();
  });
});
