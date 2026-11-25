// SPDX-License-Identifier: LicenseRef-Proprietary

// @vitest-environment jsdom
// The card of the Claude Code OAuth token (#1150): an Admin or an Owner sets, tests, replaces and removes it; a Member is told only whether one
// is saved; the saved value is never on the page; the test says that it checked the shape and asked nobody.
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

const navigation = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: navigation.refresh, push: vi.fn() }),
}));

import type { ClaudeCodeTokenStatus } from "../claude-code-token.ts";
import type { ClaudeCodeTokenApi } from "./claude-code-token-api.ts";
import { ClaudeCodeTokenCard } from "./claude-code-token-card.tsx";

afterEach(() => {
  cleanup();
  navigation.refresh.mockClear();
});

const TOKEN = "sk-ant-oat01-DUMMYDUMMYDUMMYDUMMYDUMMY0123456789-abcdef_WXYZ";
const NONE: ClaudeCodeTokenStatus = { state: "not_configured" };
const CONFIGURED: ClaudeCodeTokenStatus = {
  state: "configured",
  lastFour: "WXYZ",
  updatedAt: "2026-11-25T08:00:00.000Z",
  updatedBy: "admin-1",
};

function fakeApi(
  overrides: Partial<ClaudeCodeTokenApi> = {},
): ClaudeCodeTokenApi {
  return {
    save: vi.fn(
      async () =>
        ({
          ok: true,
          data: { ok: true, changed: true, token: CONFIGURED },
        }) as never,
    ),
    remove: vi.fn(
      async () => ({ ok: true, data: { ok: true, removed: true } }) as never,
    ),
    test: vi.fn(
      async () =>
        ({
          ok: true,
          data: { ok: true, verified: false, format: "known" },
        }) as never,
    ),
    ...overrides,
  };
}

describe("the Claude Code OAuth token card", () => {
  // #1150-T07
  it("saves the typed token, empties the field and refreshes the page", async () => {
    const api = fakeApi();
    render(
      <ClaudeCodeTokenCard
        workspaceSlug="alpha"
        canManage
        status={NONE}
        api={api}
      />,
    );
    const user = userEvent.setup();

    expect(screen.getByText("No token is saved.")).toBeTruthy();
    await user.type(screen.getByLabelText("Token"), TOKEN);
    await user.click(screen.getByRole("button", { name: "Save token" }));

    await waitFor(() => expect(api.save).toHaveBeenCalledWith(TOKEN));
    expect(await screen.findByText("The token is saved.")).toBeTruthy();
    expect((screen.getByLabelText("Token") as HTMLInputElement).value).toBe("");
    expect(navigation.refresh).toHaveBeenCalled();
  });

  // #1150-T07
  it("shows a saved token by its last four characters only and keeps it for an empty field", async () => {
    const api = fakeApi({
      save: vi.fn(
        async () =>
          ({
            ok: true,
            data: { ok: true, changed: false, token: CONFIGURED },
          }) as never,
      ),
    });
    const { container } = render(
      <ClaudeCodeTokenCard
        workspaceSlug="alpha"
        canManage
        status={CONFIGURED}
        api={api}
      />,
    );
    const user = userEvent.setup();

    expect(screen.getByText("A token is saved (ends in WXYZ).")).toBeTruthy();
    expect(container.innerHTML).not.toContain(TOKEN.slice(0, -4));
    await user.click(screen.getByRole("button", { name: "Save token" }));

    expect(await screen.findByText("The saved token is kept.")).toBeTruthy();
    expect(api.save).toHaveBeenCalledWith("");
  });

  // #1150-T07
  it("tests the shape and says that nothing was sent to Anthropic", async () => {
    const api = fakeApi();
    render(
      <ClaudeCodeTokenCard
        workspaceSlug="alpha"
        canManage
        status={CONFIGURED}
        api={api}
      />,
    );
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Test token" }));

    expect(
      await screen.findByText(/nothing is sent to Anthropic/),
    ).toBeTruthy();
    expect(api.test).toHaveBeenCalledWith("");
  });

  // #1150-T07
  it("shows the refusal of a token the runner would not accept in words", async () => {
    const api = fakeApi({
      save: vi.fn(
        async () =>
          ({
            ok: false,
            code: "invalid_input",
            issues: [{ field: "token", code: "token_invalid" }],
          }) as never,
      ),
    });
    render(
      <ClaudeCodeTokenCard
        workspaceSlug="alpha"
        canManage
        status={NONE}
        api={api}
      />,
    );
    const user = userEvent.setup();

    await user.type(screen.getByLabelText("Token"), "two tokens");
    await user.click(screen.getByRole("button", { name: "Save token" }));

    expect(
      (await screen.findAllByText(/does not look like a Claude Code token/))
        .length,
    ).toBeGreaterThan(0);
  });

  // #1150-T07
  it("removes the token", async () => {
    const api = fakeApi();
    render(
      <ClaudeCodeTokenCard
        workspaceSlug="alpha"
        canManage
        status={CONFIGURED}
        api={api}
      />,
    );
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Remove token" }));

    expect(await screen.findByText("The token is removed.")).toBeTruthy();
    expect(api.remove).toHaveBeenCalled();
  });

  // #1150-T07
  it("gives a Member no form and no button, only whether a token is saved", () => {
    render(
      <ClaudeCodeTokenCard
        workspaceSlug="alpha"
        canManage={false}
        status={CONFIGURED}
        api={fakeApi()}
      />,
    );

    expect(screen.queryByLabelText("Token")).toBeNull();
    for (const name of ["Save token", "Test token", "Remove token"])
      expect(screen.queryByRole("button", { name })).toBeNull();
    expect(
      screen.getByText(/A Claude Code OAuth token is saved for this workspace/),
    ).toBeTruthy();
  });
});
