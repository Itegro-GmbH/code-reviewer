// SPDX-License-Identifier: LicenseRef-Proprietary

// @vitest-environment jsdom
// The Advanced sub-page of the workspace settings (#658): one action, Delete workspace, confirmed by typing the name of the
// workspace. The request is not made before the name matches, a refusal is said in the dialog (which stays open), and a
// success sends the person to the start page.
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceApi } from "./api.ts";
import { AdvancedSettingsPageContent } from "./advanced-settings-page.tsx";

afterEach(cleanup);

function fakeApi(
  answer: Awaited<ReturnType<WorkspaceApi["deleteWorkspace"]>> = {
    ok: true,
    data: { ok: true },
  },
) {
  return { deleteWorkspace: vi.fn(async () => answer) };
}

function renderAdvanced(
  api = fakeApi(),
  navigate: (path: string) => void = () => undefined,
) {
  render(
    <AdvancedSettingsPageContent
      workspaceSlug="acme"
      workspaceName="Acme Reviews"
      api={api}
      navigate={navigate}
    />,
  );
  return api;
}

async function openDialog(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Delete workspace…" }));
  return screen.getByRole("alertdialog");
}

describe("the Advanced settings sub-page", () => {
  // #658-T02
  it("holds the deletion of the workspace and nothing else, and its navigation lists Advanced", () => {
    renderAdvanced();

    expect(
      screen.getByRole("heading", { level: 2, name: "Delete workspace" }),
    ).toBeTruthy();
    expect(screen.getAllByRole("button")).toHaveLength(1);
    expect(screen.queryByText(/Reset every default/)).toBeNull();
    expect(screen.queryByText(/Remove the .* key/)).toBeNull();
    const nav = screen.getByRole("navigation", { name: "Settings sections" });
    expect(
      within(nav)
        .getByRole("link", { name: "Advanced" })
        .getAttribute("aria-current"),
    ).toBe("page");
  });

  // #658-T03
  it("asks for the name and only deletes once it is typed", async () => {
    const user = userEvent.setup();
    const navigate = vi.fn();
    const api = renderAdvanced(fakeApi(), navigate);

    const dialog = await openDialog(user);
    const confirm = within(dialog).getByRole("button", {
      name: "Delete this workspace",
    });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);

    const field = within(dialog).getByLabelText("Type Acme Reviews to confirm");
    await user.type(field, "Acme");
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    expect(api.deleteWorkspace).not.toHaveBeenCalled();

    await user.type(field, " Reviews");
    expect((confirm as HTMLButtonElement).disabled).toBe(false);
    await user.click(confirm);

    expect(api.deleteWorkspace).toHaveBeenCalledWith("Acme Reviews");
    expect(navigate).toHaveBeenCalledWith("/");
  });

  // #658-T04
  it("says why a workspace with credit cannot be deleted, and stays open", async () => {
    const user = userEvent.setup();
    const navigate = vi.fn();
    renderAdvanced(
      fakeApi({ ok: false, code: "balance_positive", status: 409 } as never),
      navigate,
    );

    const dialog = await openDialog(user);
    await user.type(
      within(dialog).getByLabelText("Type Acme Reviews to confirm"),
      "Acme Reviews",
    );
    await user.click(
      within(dialog).getByRole("button", { name: "Delete this workspace" }),
    );

    expect(await within(dialog).findByText(/still has credit/)).toBeTruthy();
    expect(
      within(dialog).getByText(/Contact support for a payout/),
    ).toBeTruthy();
    expect(screen.getByRole("alertdialog")).toBeTruthy();
    expect(navigate).not.toHaveBeenCalled();
  });

  // #658-T04
  it("says what to settle first when the workspace owes an amount, and stays open", async () => {
    const user = userEvent.setup();
    const navigate = vi.fn();
    renderAdvanced(
      fakeApi({ ok: false, code: "balance_negative", status: 409 } as never),
      navigate,
    );

    const dialog = await openDialog(user);
    await user.type(
      within(dialog).getByLabelText("Type Acme Reviews to confirm"),
      "Acme Reviews",
    );
    await user.click(
      within(dialog).getByRole("button", { name: "Delete this workspace" }),
    );

    expect(await within(dialog).findByText(/Settle it first/)).toBeTruthy();
    expect(screen.getByRole("alertdialog")).toBeTruthy();
    expect(navigate).not.toHaveBeenCalled();
  });

  it("forgets the typed name when the dialog is closed", async () => {
    const user = userEvent.setup();
    renderAdvanced();

    const dialog = await openDialog(user);
    await user.type(
      within(dialog).getByLabelText("Type Acme Reviews to confirm"),
      "Acme Reviews",
    );
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    const again = await openDialog(user);

    expect(
      (
        within(again).getByLabelText(
          "Type Acme Reviews to confirm",
        ) as HTMLInputElement
      ).value,
    ).toBe("");
  });
});
