// SPDX-License-Identifier: LicenseRef-Proprietary

// @vitest-environment jsdom
// The Profiles page (#925): the list with harness, model, runner and rights, and the drawer of one profile. What the profile format has
// is editable and saved as the next version with the model carried over; what it has no place for is disabled with a hint.
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProfileView } from "../service.ts";
import type { ProfilesApi } from "./api.ts";
import {
  nextVersionBody,
  profileRowOf,
  ProfilesPageContent,
} from "./profiles-page.tsx";

afterEach(cleanup);

function view(overrides: Partial<ProfileView> = {}): ProfileView {
  return {
    id: "p1",
    name: "implementer",
    version: 2,
    createdAt: "2026-11-01T10:00:00.000Z",
    updatedAt: "2026-11-02T10:00:00.000Z",
    archivedAt: null,
    documentVersion: 2,
    versions: [],
    document: {
      name: "implementer",
      description: "Writes the change",
      model: { provider: "anthropic", model: "claude-sonnet-5-5" },
      instructions: "Work in small steps.",
      costLimitCents: 500,
      canPush: true,
      defaultResult: null,
      harness: "opencode",
    },
    ...overrides,
  };
}

function fakeApi(profile: ProfileView = view()) {
  const get = vi.fn<ProfilesApi["get"]>(async () => ({
    ok: true,
    data: { profile },
  }));
  const saveVersion = vi.fn<ProfilesApi["saveVersion"]>(
    async (_id, _body, expected) => ({
      ok: true,
      data: { profile: { ...profile, version: expected + 1 } },
    }),
  );
  return { api: { get, saveVersion } satisfies ProfilesApi, get, saveVersion };
}

describe("the list of profiles", () => {
  // #925
  it("shows the profile, its version, harness and model, the runner and the rights", () => {
    render(
      <ProfilesPageContent
        workspaceSlug="acme"
        profiles={[
          profileRowOf(view()),
          profileRowOf(
            view({
              id: "p2",
              name: "reviewer",
              version: 1,
              document: {
                ...view().document,
                name: "reviewer",
                canPush: false,
                harness: "claude-code",
              },
            }),
          ),
        ]}
        api={fakeApi().api}
      />,
    );

    expect(
      screen.getByRole("heading", { level: 2, name: "Profiles · 2" }),
    ).toBeTruthy();
    const first = screen.getByRole("row", { name: /implementer/ });
    expect(within(first).getByText("v2")).toBeTruthy();
    expect(
      within(first).getByText("opencode · anthropic · claude-sonnet-5-5"),
    ).toBeTruthy();
    expect(within(first).getByText("Hosted sandbox")).toBeTruthy();
    // The runner is not a field of the profile: the cell says it comes from the harness.
    expect(within(first).getByText("from harness")).toBeTruthy();
    expect(within(first).getByText("may push")).toBeTruthy();
    const second = screen.getByRole("row", { name: /reviewer/ });
    expect(within(second).getByText("Your runner")).toBeTruthy();
    expect(within(second).getByText("read-only")).toBeTruthy();
  });

  // #925
  it("says there are no profiles yet", () => {
    render(
      <ProfilesPageContent
        workspaceSlug="acme"
        profiles={[]}
        api={fakeApi().api}
      />,
    );

    expect(screen.getByText("No profiles yet")).toBeTruthy();
  });
});

describe("the drawer of a profile", () => {
  async function openDrawer(api: ProfilesApi) {
    const user = userEvent.setup();
    render(
      <ProfilesPageContent
        workspaceSlug="acme"
        profiles={[profileRowOf(view())]}
        api={api}
      />,
    );
    await user.click(screen.getByRole("button", { name: /implementer/ }));
    return { user, dialog: await screen.findByRole("dialog") };
  }

  // #925
  it("loads the profile and shows the fields of the prototype, those without a backend disabled with a hint", async () => {
    const { api, get } = fakeApi();
    const { dialog } = await openDrawer(api);

    expect(await within(dialog).findByLabelText("Harness")).toBeTruthy();
    expect(get).toHaveBeenCalledWith("p1");
    expect(
      (within(dialog).getByLabelText("Harness") as HTMLSelectElement).disabled,
    ).toBe(false);
    expect(
      (within(dialog).getByLabelText("Instructions") as HTMLTextAreaElement)
        .value,
    ).toBe("Work in small steps.");
    for (const label of [
      "Model",
      "API key",
      "Runs on",
      "May end a turn with a question",
    ])
      expect(
        (within(dialog).getByLabelText(label) as HTMLInputElement).disabled,
        label,
      ).toBe(true);
    expect(
      within(dialog).getAllByText(/comes later/i).length,
    ).toBeGreaterThanOrEqual(3);
    expect(
      (
        within(dialog).getByRole("button", {
          name: "Duplicate",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });

  // #925
  it("saves the edited fields as the next version of the shown one, with the model carried over", async () => {
    const { api, saveVersion } = fakeApi();
    const { user, dialog } = await openDrawer(api);
    const instructions = await within(dialog).findByLabelText("Instructions");

    await user.clear(instructions);
    await user.type(instructions, "Ask before you push.");
    await user.click(within(dialog).getByLabelText("May push branches"));
    await user.click(
      within(dialog).getByRole("button", { name: "Save as new version" }),
    );

    await waitFor(() => expect(saveVersion).toHaveBeenCalledTimes(1));
    const [id, body, expected] = saveVersion.mock.calls[0]!;
    expect(id).toBe("p1");
    expect(expected).toBe(2);
    expect(body).toMatchObject({
      name: "implementer",
      model: { provider: "anthropic", model: "claude-sonnet-5-5" },
      instructions: "Ask before you push.",
      canPush: false,
      harness: "opencode",
      costLimitCents: 500,
    });
  });

  // #925
  it("says the version it saved, in the drawer that stays open", async () => {
    const { api } = fakeApi();
    const { user, dialog } = await openDrawer(api);
    await within(dialog).findByLabelText("Instructions");

    await user.click(
      within(dialog).getByRole("button", { name: "Save as new version" }),
    );

    expect(await within(dialog).findByText("Saved as version 3.")).toBeTruthy();
    expect(within(dialog).getByText("Profile · v3")).toBeTruthy();
    // The save is answered with the new version: nothing is read again.
    expect(api.get).toHaveBeenCalledTimes(1);
  });

  // #925
  it("shows the saved harness, rights and version in the row of the list", async () => {
    const saved = view({
      version: 3,
      document: {
        ...view().document,
        canPush: false,
        harness: "claude-code",
      },
    });
    const { api, saveVersion } = fakeApi();
    saveVersion.mockResolvedValueOnce({ ok: true, data: { profile: saved } });
    const { user, dialog } = await openDrawer(api);
    await within(dialog).findByLabelText("Instructions");
    // The open drawer hides the page behind it from the accessibility tree.
    const row = screen.getByRole("row", { name: /implementer/, hidden: true });
    expect(within(row).getByText("v2")).toBeTruthy();
    expect(within(row).getByText("Hosted sandbox")).toBeTruthy();

    await user.click(
      within(dialog).getByRole("button", { name: "Save as new version" }),
    );
    await within(dialog).findByText("Saved as version 3.");

    expect(within(row).getByText("v3")).toBeTruthy();
    expect(
      within(row).getByText("claude-code · anthropic · claude-sonnet-5-5"),
    ).toBeTruthy();
    expect(within(row).getByText("Your runner")).toBeTruthy();
    expect(within(row).getByText("read-only")).toBeTruthy();
  });

  // #925
  it("says the profile has a newer version when the save conflicts, and keeps the form", async () => {
    const { api } = fakeApi();
    api.saveVersion.mockResolvedValueOnce({
      ok: false,
      status: 409,
      code: "PROFILE_VERSION_CONFLICT",
      issues: [],
    });
    const { user, dialog } = await openDrawer(api);
    await within(dialog).findByLabelText("Instructions");

    await user.click(
      within(dialog).getByRole("button", { name: "Save as new version" }),
    );

    expect(await within(dialog).findByText(/newer version/)).toBeTruthy();
    expect(within(dialog).getByLabelText("Instructions")).toBeTruthy();
  });

  // #925
  it("offers to try again when the profile cannot be loaded", async () => {
    const { api, get } = fakeApi();
    get.mockResolvedValueOnce({
      ok: false,
      status: null,
      code: "NETWORK_ERROR",
      issues: [],
    });
    const { user, dialog } = await openDrawer(api);

    await user.click(
      await within(dialog).findByRole("button", { name: "Try again" }),
    );

    expect(await within(dialog).findByLabelText("Harness")).toBeTruthy();
    expect(get).toHaveBeenCalledTimes(2);
  });
});

describe("the body of the next version", () => {
  // #925
  it("keeps the cost limit and the default result of the version it starts from", () => {
    const defaultResult: NonNullable<ProfileView["document"]["defaultResult"]> =
      {
        type: "object",
        required: ["findings"],
        properties: { findings: { type: "array", items: { type: "string" } } },
      };
    const profile = view({
      document: {
        ...view().document,
        costLimitCents: 750,
        defaultResult,
      },
    });

    const body = nextVersionBody(profile, {
      harness: "claude-code",
      instructions: "x",
      canPush: false,
    });

    expect(body).toMatchObject({
      costLimitCents: 750,
      defaultResult,
      harness: "claude-code",
      canPush: false,
      instructions: "x",
    });
  });

  // #925
  it("leaves out the fields the version has none of, so they stay unset", () => {
    const profile = view({
      document: {
        ...view().document,
        costLimitCents: null,
        defaultResult: null,
      },
    });

    const body = nextVersionBody(profile, {
      harness: "claude-code",
      instructions: "x",
      canPush: false,
    });

    expect(body).not.toHaveProperty("costLimitCents");
    expect(body).not.toHaveProperty("defaultResult");
    expect(body).toMatchObject({ harness: "claude-code", canPush: false });
  });
});
