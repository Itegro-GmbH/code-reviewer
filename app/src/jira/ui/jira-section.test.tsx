// SPDX-License-Identifier: LicenseRef-Proprietary

// @vitest-environment jsdom
// The Jira card of the Integrations tab (#1037): the sites with their state, Connect Jira and the way it is offered or not, Reconnect for
// a broken connection, the two-step Remove and the refusal that names the project, the choice among several sites, what a member does not
// get, and that names from Atlassian are text. The card gets no token and shows none.
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

const navigation = vi.hoisted(() => ({ refresh: vi.fn(), replace: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({
    refresh: navigation.refresh,
    replace: navigation.replace,
  }),
}));

import type { JiraApi } from "./api.ts";
import { JiraSection, type JiraSectionData } from "./jira-section.tsx";
import { describeJiraFailure, describeJiraResult } from "./messages.ts";
import { JIRA_RESULT_CODES } from "../errors.ts";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const CONSENT = "https://auth.atlassian.com/authorize?state=abc";

const CONNECTED = {
  id: "jc-1",
  cloudId: "cloud-1",
  siteUrl: "https://acme.atlassian.net",
  siteName: "acme",
  accountName: "Ada Lovelace",
  scopes: ["read:jira-work"],
  status: "connected" as const,
  errorCode: null,
  createdAt: "2026-11-14T10:00:00.000Z",
  updatedAt: "2026-11-14T10:00:00.000Z",
};
const BROKEN = {
  ...CONNECTED,
  id: "jc-2",
  siteName: "beta",
  siteUrl: "https://beta.atlassian.net",
  status: "broken" as const,
  errorCode: "jira_refresh_refused",
};

function data(overrides: Partial<JiraSectionData> = {}): JiraSectionData {
  return {
    configured: true,
    connections: [],
    choices: null,
    notice: null,
    ...overrides,
  };
}

function api(overrides: Partial<JiraApi> = {}): JiraApi {
  return {
    connect: vi.fn(async () => ({
      ok: true as const,
      data: { ok: true as const, url: CONSENT },
    })),
    choose: vi.fn(async () => ({
      ok: true as const,
      data: { ok: true as const },
    })),
    remove: vi.fn(async () => ({
      ok: true as const,
      data: { ok: true as const },
    })),
    ...overrides,
  };
}

function renderCard(
  pageData: JiraSectionData,
  options: {
    canManage?: boolean;
    api?: JiraApi;
    go?: (url: string) => void;
  } = {},
) {
  const calls = options.api ?? api();
  const go = options.go ?? vi.fn();
  render(
    <JiraSection
      workspaceSlug="acme"
      canManage={options.canManage ?? true}
      data={pageData}
      api={calls}
      go={go}
    />,
  );
  return { api: calls, go };
}

describe("the Jira card", () => {
  // #1037
  it("offers Connect Jira with no site connected, and sends the browser to the consent page", async () => {
    const { api: calls, go } = renderCard(data());

    expect(
      screen.getByText("No Jira Cloud site is connected yet."),
    ).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Connect Jira" }));

    expect(calls.connect).toHaveBeenCalledWith(undefined);
    expect(go).toHaveBeenCalledWith(CONSENT);
  });

  // #1037
  it("lists the sites with who connected them and their state, and offers another site", () => {
    renderCard(data({ connections: [CONNECTED, BROKEN] }));

    const rows = within(
      screen.getByRole("list", { name: "Jira sites" }),
    ).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(within(rows[0] as HTMLElement).getByText("Connected")).toBeTruthy();
    expect(
      within(rows[0] as HTMLElement).getByRole("link", {
        name: "https://acme.atlassian.net",
      }),
    ).toBeTruthy();
    expect(
      within(rows[0] as HTMLElement).getByText(/connected by Ada Lovelace/),
    ).toBeTruthy();
    expect(
      within(rows[1] as HTMLElement).getByText("Needs reconnecting"),
    ).toBeTruthy();
    expect(
      within(rows[1] as HTMLElement).getByText(
        /Atlassian no longer accepts this connection/,
      ),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Connect another site" }),
    ).toBeTruthy();
  });

  // #1037
  it("reconnects a broken connection by naming it, and only a broken one", async () => {
    const { api: calls, go } = renderCard(
      data({ connections: [CONNECTED, BROKEN] }),
    );

    expect(screen.queryByRole("button", { name: "Reconnect acme" })).toBeNull();
    await userEvent.click(
      screen.getByRole("button", { name: "Reconnect beta" }),
    );

    expect(calls.connect).toHaveBeenCalledWith("jc-2");
    expect(go).toHaveBeenCalledWith(CONSENT);
  });

  // #1037
  it("removes a connection only after the dialog is confirmed", async () => {
    const { api: calls } = renderCard(data({ connections: [CONNECTED] }));

    await userEvent.click(screen.getByRole("button", { name: "Remove acme" }));
    expect(calls.remove).not.toHaveBeenCalled();
    await userEvent.click(
      screen.getByRole("button", { name: "Confirm removing acme" }),
    );

    expect(calls.remove).toHaveBeenCalledWith("jc-1");
    expect(navigation.refresh).toHaveBeenCalled();
  });

  // #1037-T03
  it("says which projects use a connection that was not removed", async () => {
    renderCard(data({ connections: [CONNECTED] }), {
      api: api({
        remove: vi.fn(async () => ({
          ok: false as const,
          status: 409,
          code: "jira_connection_in_use",
          issues: [],
          details: { projects: [{ id: "p-1", name: "acme/api" }] },
        })),
      }),
    });

    await userEvent.click(screen.getByRole("button", { name: "Remove acme" }));
    await userEvent.click(
      screen.getByRole("button", { name: "Confirm removing acme" }),
    );

    expect((await screen.findByRole("status")).textContent).toContain(
      "Used by: acme/api.",
    );
  });

  // #1037
  it("is off where the Atlassian app is not set up: no Connect, and the reason", () => {
    renderCard(data({ configured: false, connections: [CONNECTED] }));

    expect(screen.getByRole("note").textContent).toContain(
      "Jira is not set up on this installation",
    );
    expect(
      (
        screen.getByRole("button", {
          name: "Connect another site",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });

  // #1037
  it("lets a Member see the sites and none of the controls", () => {
    renderCard(data({ connections: [CONNECTED, BROKEN] }), {
      canManage: false,
    });

    expect(screen.getByText("acme")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  // #1037
  it("offers the sites of a grant that covers several, and connects the one that is chosen", async () => {
    const { api: calls } = renderCard(
      data({
        choices: [
          {
            cloudId: "c-1",
            siteUrl: "https://one.atlassian.net",
            siteName: "one",
          },
          {
            cloudId: "c-2",
            siteUrl: "https://two.atlassian.net",
            siteName: "two",
          },
        ],
      }),
    );

    await userEvent.click(screen.getByRole("button", { name: "Connect two" }));

    expect(calls.choose).toHaveBeenCalledWith("c-2");
    expect(navigation.replace).toHaveBeenCalledWith(
      "/w/acme/settings/integrations",
    );
  });

  // #1037
  it("shows what a flow ended with, and a failed start as one message", async () => {
    renderCard(data({ notice: describeJiraResult("jira_no_site") }), {
      api: api({
        connect: vi.fn(async () => ({
          ok: false as const,
          status: 429,
          code: "rate_limited",
          issues: [],
        })),
      }),
    });

    expect(screen.getByRole("status").textContent).toContain(
      "no Jira Cloud site",
    );
    await userEvent.click(screen.getByRole("button", { name: "Connect Jira" }));
    expect(
      (await screen.findAllByRole("status"))
        .map((e) => e.textContent)
        .join(" "),
    ).toContain("Too many attempts");
  });

  // #1037
  it("shows names from Atlassian as text, never as markup, and an address that is not https as text", () => {
    const hostile = {
      ...CONNECTED,
      siteName: "<img src=x onerror=alert(1)>",
      siteUrl: "javascript:alert(1)",
    };
    const { container } = render(
      <JiraSection
        workspaceSlug="acme"
        canManage
        data={data({ connections: [hostile] })}
        api={api()}
        go={vi.fn()}
      />,
    );

    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("a[href^='javascript']")).toBeNull();
    expect(container.textContent).toContain("<img src=x onerror=alert(1)>");
  });
});

describe("the words of the Jira connection", () => {
  // #1037
  it("have copy for every result code, and none for a code that is not ours", () => {
    for (const code of JIRA_RESULT_CODES)
      expect(describeJiraResult(code)?.text.length).toBeGreaterThan(10);
    expect(describeJiraResult("something-else")).toBeNull();
    expect(describeJiraResult(undefined)).toBeNull();
    expect(describeJiraFailure("whatever")).toBe(
      "Something went wrong. Try again.",
    );
  });
});
