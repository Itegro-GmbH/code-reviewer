// SPDX-License-Identifier: LicenseRef-Proprietary

// @vitest-environment jsdom
// The environments page's list and forms (#818), with a stand-in for the routes: the list with size and script, create, edit and
// delete for a person who may manage, read only for a member, and the sentence of every refusal.
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProductIdentityProvider } from "../../../product-identity/context.tsx";
import { identityFor } from "../../../product-identity/identities.ts";
import type { RequestResult } from "../../../ui/json-request.ts";
import { SETUP_SCRIPT_MAX_BYTES } from "../limits.ts";
import type { EnvironmentList, EnvironmentView } from "../service.ts";
import type { EnvironmentApi, EnvironmentBody } from "./api.ts";
import { EnvironmentsPanel } from "./environments-panel.tsx";
import { describeFieldIssue } from "./messages.ts";

afterEach(cleanup);

const ok = <T,>(data: T): RequestResult<T> => ({ ok: true, data });
const refused = (
  status: number,
  code: string,
  extra: Partial<Extract<RequestResult<never>, { ok: false }>> = {},
): RequestResult<never> => ({ ok: false, status, code, issues: [], ...extra });

const NODE: EnvironmentView = {
  id: "env-1",
  name: "Node 22",
  vcpus: 4,
  memoryGb: 8,
  setupScript: "pnpm install\n",
  createdAt: "2026-11-02T08:00:00.000Z",
  updatedAt: "2026-11-02T08:00:00.000Z",
};
const BARE: EnvironmentView = {
  ...NODE,
  id: "env-2",
  name: "Bare",
  vcpus: 2,
  memoryGb: 4,
  setupScript: "",
};

function fakeApi(
  environments: EnvironmentView[] = [NODE, BARE],
  overrides: Partial<EnvironmentApi> = {},
) {
  const created: EnvironmentBody[] = [];
  const updated: Array<[string, EnvironmentBody]> = [];
  const removed: string[] = [];
  const api: EnvironmentApi = {
    list: async () => ok<EnvironmentList>({ environments, maximum: 50 }),
    create: async (body) => {
      created.push(body);
      return ok({
        environment: {
          ...NODE,
          id: "env-3",
          ...body,
          memoryGb: body.vcpus * 2,
        },
      });
    },
    update: async (id, body) => {
      updated.push([id, body]);
      return ok({
        environment: { ...NODE, id, ...body, memoryGb: body.vcpus * 2 },
      });
    },
    remove: async (id) => {
      removed.push(id);
      return ok({ removed: true as const });
    },
    ...overrides,
  };
  return { api, created, updated, removed };
}

function show(api: EnvironmentApi, canManage: boolean) {
  return render(
    <ProductIdentityProvider product={identityFor("factory")}>
      <EnvironmentsPanel workspaceSlug="acme" canManage={canManage} api={api} />
    </ProductIdentityProvider>,
  );
}

describe("the list of environments", () => {
  // #818-T12
  it("shows name, size and script of each environment", async () => {
    show(fakeApi().api, true);

    const node = (await screen.findByText("Node 22")).closest("li");
    expect(node).not.toBeNull();
    expect(within(node as HTMLElement).getByText(/4 vCPU/)).toBeTruthy();
    expect(within(node as HTMLElement).getByText(/8 GB/)).toBeTruthy();
    expect(within(node as HTMLElement).getByText(/pnpm install/)).toBeTruthy();
    const bare = screen.getByText("Bare").closest("li") as HTMLElement;
    expect(within(bare).getByText("No setup script")).toBeTruthy();
  });

  // #818-T12
  it("shows a member the list and the scripts, and no way to change anything", async () => {
    show(fakeApi().api, false);

    await screen.findByText("Node 22");
    expect(
      screen.queryByRole("button", { name: /new environment/i }),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: /^edit/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /^delete/i })).toBeNull();
    expect(screen.getByText(/pnpm install/)).toBeTruthy();
  });

  // #818-T12
  it("says what a task without an environment runs on when there is none", async () => {
    show(fakeApi([]).api, true);

    expect(
      await screen.findByText(/standard: 2 vCPU, 4 GB, no setup script/),
    ).toBeTruthy();
  });

  // #818-T12
  it("says so and offers a retry when the list cannot be loaded", async () => {
    const list = vi
      .fn()
      .mockResolvedValueOnce(refused(null as never, "NETWORK_ERROR"))
      .mockResolvedValueOnce(ok({ environments: [NODE], maximum: 50 }));
    show(fakeApi([], { list }).api, true);

    expect(await screen.findByText(/could not be reached/)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Node 22")).toBeTruthy();
  });
});

describe("creating an environment", () => {
  // #818-T12
  it("sends name, chosen size and the script exactly as typed, then shows the new environment", async () => {
    const { api, created } = fakeApi([]);
    show(api, true);
    await screen.findByText(/standard/);

    await userEvent.click(
      screen.getByRole("button", { name: /new environment/i }),
    );
    await userEvent.type(screen.getByLabelText("Name"), "Rust");
    await userEvent.click(screen.getByRole("radio", { name: /8 vCPU/ }));
    await userEvent.type(
      screen.getByLabelText("Setup script"),
      "  cargo fetch  ",
    );
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(created).toEqual([
        { name: "Rust", vcpus: 8, setupScript: "  cargo fetch  " },
      ]),
    );
    expect(await screen.findByText("The environment was saved.")).toBeTruthy();
    expect(screen.getByText("Rust")).toBeTruthy();
    expect(screen.queryByLabelText("Name")).toBeNull();
  });

  // #818-T12
  it("offers exactly the platform's sizes, with the memory, and preselects the standard of 2 vCPU", async () => {
    show(fakeApi([]).api, true);
    await screen.findByText(/standard/);
    await userEvent.click(
      screen.getByRole("button", { name: /new environment/i }),
    );

    const radios = screen.getAllByRole("radio");
    expect(
      radios.map((radio) => radio.getAttribute("aria-label") ?? radio.id),
    ).toHaveLength(5);
    for (const [vcpus, gb] of [
      [1, 2],
      [2, 4],
      [4, 8],
      [6, 12],
      [8, 16],
    ] as const)
      expect(
        screen.getByRole("radio", {
          name: new RegExp(`^${vcpus} vCPU.*${gb} GB`),
        }),
      ).toBeTruthy();
    expect(
      screen
        .getByRole("radio", { name: /^2 vCPU/ })
        .getAttribute("aria-checked"),
    ).toBe("true");
  });

  // #818-T12
  it("shows the sentence of a refused field next to the field and keeps what was typed", async () => {
    const create = vi.fn(async () =>
      refused(400, "ENVIRONMENT_REQUEST_INVALID", {
        issues: [{ field: "name", code: "required" }],
      }),
    );
    show(fakeApi([], { create }).api, true);
    await screen.findByText(/standard/);
    await userEvent.click(
      screen.getByRole("button", { name: /new environment/i }),
    );
    await userEvent.type(screen.getByLabelText("Setup script"), "echo hi");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(
      await screen.findByText(describeFieldIssue("name", "required")),
    ).toBeTruthy();
    expect(screen.getByLabelText("Name").getAttribute("aria-invalid")).toBe(
      "true",
    );
    expect(
      (screen.getByLabelText("Setup script") as HTMLTextAreaElement).value,
    ).toBe("echo hi");
  });

  // #818-T12
  it("says a taken name is taken, and a full workspace is full", async () => {
    const create = vi
      .fn()
      .mockResolvedValueOnce(refused(409, "ENVIRONMENT_NAME_TAKEN"))
      .mockResolvedValueOnce(
        refused(409, "ENVIRONMENT_LIMIT_REACHED", { details: { maximum: 50 } }),
      );
    show(fakeApi([], { create }).api, true);
    await screen.findByText(/standard/);
    await userEvent.click(
      screen.getByRole("button", { name: /new environment/i }),
    );
    await userEvent.type(screen.getByLabelText("Name"), "x");

    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText(/with that name already/)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText(/can hold 50 environments/)).toBeTruthy();
  });

  // #818-T12
  it("refuses a script over 64 KB before it is sent, counting bytes", async () => {
    const { api, created } = fakeApi([]);
    show(api, true);
    await screen.findByText(/standard/);
    await userEvent.click(
      screen.getByRole("button", { name: /new environment/i }),
    );
    await userEvent.type(screen.getByLabelText("Name"), "Big");
    const script = screen.getByLabelText("Setup script");
    // typing 64 KB by key is too slow; a paste is one event
    await userEvent.click(script);
    await userEvent.paste("ä".repeat(SETUP_SCRIPT_MAX_BYTES / 2 + 1));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(
      await screen.findByText(describeFieldIssue("setupScript", "too_long")),
    ).toBeTruthy();
    expect(created).toEqual([]);
  });
});

describe("changing and deleting", () => {
  // #818-T12
  it("loads an environment into the form and sends the change to its id", async () => {
    const { api, updated } = fakeApi();
    show(api, true);
    const node = (await screen.findByText("Node 22")).closest(
      "li",
    ) as HTMLElement;

    await userEvent.click(within(node).getByRole("button", { name: /edit/i }));
    const name = screen.getByLabelText("Name") as HTMLInputElement;
    expect(name.value).toBe("Node 22");
    expect(
      (screen.getByLabelText("Setup script") as HTMLTextAreaElement).value,
    ).toBe("pnpm install\n");
    await userEvent.clear(name);
    await userEvent.type(name, "Node 24");
    await userEvent.click(screen.getByRole("radio", { name: /^6 vCPU/ }));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(updated).toEqual([
        ["env-1", { name: "Node 24", vcpus: 6, setupScript: "pnpm install\n" }],
      ]),
    );
    expect(await screen.findByText("Node 24")).toBeTruthy();
  });

  // #818-T12
  it("asks before it deletes, deletes only on confirmation, and removes the row", async () => {
    const { api, removed } = fakeApi();
    show(api, true);
    const bare = (await screen.findByText("Bare")).closest("li") as HTMLElement;

    await userEvent.click(
      within(bare).getByRole("button", { name: /delete/i }),
    );
    expect(removed).toEqual([]);
    await userEvent.click(
      await screen.findByRole("button", { name: "Yes, delete it" }),
    );

    await waitFor(() => expect(removed).toEqual(["env-2"]));
    await waitFor(() => expect(screen.queryByText("Bare")).toBeNull());
    expect(screen.getByText("Node 22")).toBeTruthy();
  });

  // #818-T12
  it("cancelling the delete changes nothing", async () => {
    const { api, removed } = fakeApi();
    show(api, true);
    const bare = (await screen.findByText("Bare")).closest("li") as HTMLElement;

    await userEvent.click(
      within(bare).getByRole("button", { name: /delete/i }),
    );
    await userEvent.click(
      await screen.findByRole("button", { name: "Cancel" }),
    );

    expect(removed).toEqual([]);
    expect(screen.getByText("Bare")).toBeTruthy();
  });

  // #818-T12
  it("says when the environment is gone already", async () => {
    const remove = vi.fn(async () => refused(404, "ENVIRONMENT_NOT_FOUND"));
    show(fakeApi(undefined, { remove }).api, true);
    const bare = (await screen.findByText("Bare")).closest("li") as HTMLElement;

    await userEvent.click(
      within(bare).getByRole("button", { name: /delete/i }),
    );
    await userEvent.click(
      await screen.findByRole("button", { name: "Yes, delete it" }),
    );

    expect(await screen.findByText(/does not exist any more/)).toBeTruthy();
  });
});

describe("what the page says about the script (#819 review)", () => {
  // #818-T40
  it("says plainly that setup scripts do not run yet, for a person who manages and for one who does not", async () => {
    for (const canManage of [true, false]) {
      show(fakeApi().api, canManage);
      expect(
        await screen.findByText(/setup scripts do not run yet/i),
      ).toBeTruthy();
      cleanup();
    }
  });

  // #818-T40
  it("describes the script as running as root with full internet access in its own container without secrets, the agent starting afterwards with its own restricted network — as a plan, not a fact", async () => {
    show(fakeApi([]).api, true);
    await screen.findByText(/standard/);
    await userEvent.click(
      screen.getByRole("button", { name: /new environment/i }),
    );

    const hint = (
      screen
        .getByLabelText("Setup script")
        .closest("[data-field]") as HTMLElement
    ).textContent;
    expect(hint).toMatch(/do not run yet/i);
    expect(hint).toMatch(/as root/);
    expect(hint).toMatch(/full internet access/);
    expect(hint).toMatch(/own container with no secrets/);
    expect(hint).toMatch(/restricted network/);
    // The old wording gave the script the agent's network.
    expect(hint).not.toMatch(/same network as the agent/);
    expect(hint).not.toMatch(/registries/);
  });
});

describe("deleting while editing, a delete that finds nothing, and a delete in flight (#819 review)", () => {
  // #818-T41
  it("gives back 'New environment' and closes the form when the environment being edited is deleted", async () => {
    const { api } = fakeApi();
    show(api, true);
    const node = (await screen.findByText("Node 22")).closest(
      "li",
    ) as HTMLElement;
    await userEvent.click(within(node).getByRole("button", { name: /edit/i }));
    expect(screen.getByLabelText("Name")).toBeTruthy();

    await userEvent.click(
      within(node).getByRole("button", { name: /delete/i }),
    );
    await userEvent.click(
      await screen.findByRole("button", { name: "Yes, delete it" }),
    );

    await waitFor(() => expect(screen.queryByText("Node 22")).toBeNull());
    expect(screen.queryByLabelText("Name")).toBeNull();
    expect(
      screen.getByRole("button", { name: /new environment/i }),
    ).toBeTruthy();
  });

  // #818-T41
  it("keeps the form of another environment open when one that is not being edited is deleted", async () => {
    const { api } = fakeApi();
    show(api, true);
    const node = (await screen.findByText("Node 22")).closest(
      "li",
    ) as HTMLElement;
    const bare = screen.getByText("Bare").closest("li") as HTMLElement;
    await userEvent.click(within(node).getByRole("button", { name: /edit/i }));

    await userEvent.click(
      within(bare).getByRole("button", { name: /delete/i }),
    );
    await userEvent.click(
      await screen.findByRole("button", { name: "Yes, delete it" }),
    );

    await waitFor(() => expect(screen.queryByText("Bare")).toBeNull());
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe(
      "Node 22",
    );
  });

  // #818-T42
  it("takes the row off the screen when the delete finds the environment gone, and says so", async () => {
    const remove = vi.fn(async () => refused(404, "ENVIRONMENT_NOT_FOUND"));
    show(fakeApi(undefined, { remove }).api, true);
    const bare = (await screen.findByText("Bare")).closest("li") as HTMLElement;

    await userEvent.click(
      within(bare).getByRole("button", { name: /delete/i }),
    );
    await userEvent.click(
      await screen.findByRole("button", { name: "Yes, delete it" }),
    );

    expect(await screen.findByText(/does not exist any more/)).toBeTruthy();
    expect(screen.queryByText("Bare")).toBeNull();
    expect(screen.getByText("Node 22")).toBeTruthy();
  });

  // #818-T42
  it("keeps the row for any other failure of the delete", async () => {
    const remove = vi.fn(async () => refused(500, "UNEXPECTED_RESPONSE"));
    show(fakeApi(undefined, { remove }).api, true);
    const bare = (await screen.findByText("Bare")).closest("li") as HTMLElement;

    await userEvent.click(
      within(bare).getByRole("button", { name: /delete/i }),
    );
    await userEvent.click(
      await screen.findByRole("button", { name: "Yes, delete it" }),
    );

    expect(await screen.findByText(/server answered/i)).toBeTruthy();
    expect(screen.getByText("Bare")).toBeTruthy();
  });

  // #818-T43
  it("disables every Delete button while a delete is in flight, and enables them again when it ends", async () => {
    let finish: (value: RequestResult<{ removed: true }>) => void = () =>
      undefined;
    const remove = vi.fn(
      () =>
        new Promise<RequestResult<{ removed: true }>>((resolve) => {
          finish = resolve;
        }),
    );
    show(fakeApi(undefined, { remove }).api, true);
    const bare = (await screen.findByText("Bare")).closest("li") as HTMLElement;

    await userEvent.click(
      within(bare).getByRole("button", { name: /delete/i }),
    );
    await userEvent.click(
      await screen.findByRole("button", { name: "Yes, delete it" }),
    );

    await waitFor(() => expect(remove).toHaveBeenCalledTimes(1));
    for (const button of screen.getAllByRole("button", { name: /^delete/i }))
      expect(button).toHaveProperty("disabled", true);
    finish(ok({ removed: true as const }));
    await waitFor(() => expect(screen.queryByText("Bare")).toBeNull());
    for (const button of screen.getAllByRole("button", { name: /^delete/i }))
      expect(button).toHaveProperty("disabled", false);
  });
});

describe("the size group (#819 review)", () => {
  // #818-T44
  it("is described by its hint, and by the refusal instead of the hint when the server refuses the size", async () => {
    const create = vi.fn(async () =>
      refused(400, "ENVIRONMENT_REQUEST_INVALID", {
        issues: [{ field: "vcpus", code: "invalid" }],
      }),
    );
    show(fakeApi([], { create }).api, true);
    await screen.findByText(/standard/);
    await userEvent.click(
      screen.getByRole("button", { name: /new environment/i }),
    );
    const group = screen.getByRole("radiogroup");
    const describedBy = () =>
      (group.getAttribute("aria-describedby") ?? "")
        .split(" ")
        .map((id) => document.getElementById(id)?.textContent ?? "");

    expect(describedBy()).toEqual([
      expect.stringContaining("2 GB of memory per vCPU"),
    ]);
    expect(group.getAttribute("aria-invalid")).not.toBe("true");

    await userEvent.type(screen.getByLabelText("Name"), "x");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    await screen.findByText(describeFieldIssue("vcpus", "invalid"));
    expect(describedBy()).toEqual([describeFieldIssue("vcpus", "invalid")]);
    expect(group.getAttribute("aria-invalid")).toBe("true");
  });
});
