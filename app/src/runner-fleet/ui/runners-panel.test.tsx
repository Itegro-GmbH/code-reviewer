// SPDX-License-Identifier: LicenseRef-Proprietary

// @vitest-environment jsdom
// The runners page (#854), with a stand-in for the routes: the list with labels, version, harnesses and last seen, a token that is
// shown once with the command to copy, revoking after a confirmation, read only for a member, and the sentence of every refusal.
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { CapabilitiesProvider } from "../../capabilities/context.tsx";
import type { Capability } from "../../capabilities/capability.ts";
import { ProductIdentityProvider } from "../../product-identity/context.tsx";
import { identityFor } from "../../product-identity/identities.ts";
import type { RequestResult } from "../../ui/json-request.ts";
import type { RunnerList, RunnerView } from "../service.ts";
import type { RunnerFleetApi } from "./api.ts";
import { RunnersPanel } from "./runners-panel.tsx";

afterEach(cleanup);

const ok = <T,>(data: T): RequestResult<T> => ({ ok: true, data });
const refused = (status: number, code: string): RequestResult<never> => ({
  ok: false,
  status,
  code,
  issues: [],
});

const BOX: RunnerView = {
  id: "r1",
  name: "build-box-1",
  labels: ["gpu", "linux"],
  baseVersion: "1.2.0",
  manifest: {
    harnesses: { opencode: { version: "1.19.0", ready: true } },
    capabilities: ["agent-docker"],
  },
  limits: {},
  createdAt: "2026-11-05T08:00:00.000Z",
  lastSeenAt: "2026-11-05T11:59:00.000Z",
  status: "online",
};
const OLD: RunnerView = {
  ...BOX,
  id: "r2",
  name: "old-box",
  labels: [],
  baseVersion: "0.9.0",
  manifest: { harnesses: {}, capabilities: [] },
  status: "update_needed",
};

function fakeApi(
  runners: RunnerView[] = [BOX, OLD],
  overrides: Partial<RunnerFleetApi> = {},
  minBaseVersion: string | null = null,
) {
  const revoked: string[] = [];
  let tokens = 0;
  const api: RunnerFleetApi = {
    list: async () =>
      ok<RunnerList>({ runners, minBaseVersion, onlineWithinSeconds: 120 }),
    createToken: async () => {
      tokens += 1;
      return ok({
        token: `crt_token-${tokens}`,
        expiresAt: "2026-11-05T13:00:00.000Z",
      });
    },
    revoke: async (id) => {
      revoked.push(id);
      return ok({ revoked: true as const });
    },
    ...overrides,
  };
  return { api, revoked };
}

function show(
  api: RunnerFleetApi,
  canManage: boolean,
  capabilities: readonly Capability[] = ["review", "implementer"],
) {
  return render(
    <CapabilitiesProvider capabilities={capabilities}>
      <ProductIdentityProvider product={identityFor("factory")}>
        <RunnersPanel workspaceSlug="acme" canManage={canManage} api={api} />
      </ProductIdentityProvider>
    </CapabilitiesProvider>,
  );
}

describe("the list of runners", () => {
  // #854-T72
  it("shows name, state, labels, base, harnesses, capabilities and last seen of each runner", async () => {
    show(fakeApi().api, true);

    const box = (await screen.findByText("build-box-1")).closest(
      "li",
    ) as HTMLElement;
    expect(within(box).getByText("Online")).toBeTruthy();
    expect(within(box).getByText("gpu, linux")).toBeTruthy();
    expect(within(box).getByText("1.2.0")).toBeTruthy();
    expect(within(box).getByText("opencode 1.19.0 (ready)")).toBeTruthy();
    expect(within(box).getByText("agent-docker")).toBeTruthy();
    expect(within(box).getByText("2026-11-05 11:59 UTC")).toBeTruthy();
    const old = screen.getByText("old-box").closest("li") as HTMLElement;
    expect(within(old).getByText("Update needed")).toBeTruthy();
    expect(within(old).getByText("No labels")).toBeTruthy();
    expect(within(old).getByText("None announced")).toBeTruthy();
  });

  // #854-T72
  it("names the minimum base when the instance requires one", async () => {
    show(fakeApi([BOX], {}, "1.1.0").api, true);

    expect(await screen.findByText(/older than base 1\.1\.0/)).toBeTruthy();
  });

  // #854-T73
  it("shows a member the list and no way to add or revoke", async () => {
    show(fakeApi().api, false);

    await screen.findByText("build-box-1");
    expect(
      screen.queryByRole("button", { name: /connect your own runner/i }),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: /^revoke/i })).toBeNull();
  });

  it("says so when there is no runner", async () => {
    show(fakeApi([]).api, true);

    expect(await screen.findByText(/No runner yet/)).toBeTruthy();
  });

  it("says what went wrong and offers to try again when the list cannot be loaded", async () => {
    let attempts = 0;
    const { api } = fakeApi([BOX], {
      list: async () => {
        attempts += 1;
        return attempts === 1
          ? refused(500, "UNEXPECTED_RESPONSE")
          : ok({
              runners: [BOX],
              minBaseVersion: null,
              onlineWithinSeconds: 120,
            });
      },
    });
    show(api, true);

    await userEvent.click(
      await screen.findByRole("button", { name: /try again/i }),
    );

    expect(await screen.findByText("build-box-1")).toBeTruthy();
  });
});

describe("a registration token", () => {
  // #854-T74
  it("is shown once, in a dialog, with the command to register a runner, and gone when the person is done", async () => {
    const user = userEvent.setup();
    show(fakeApi().api, true);

    await user.click(
      await screen.findByRole("button", { name: /connect your own runner/i }),
    );

    expect((await screen.findByLabelText("Command")).textContent).toBe(
      "factory-runner register --token crt_token-1",
    );
    expect(screen.getByText(/Valid until 2026-11-05 13:00 UTC/)).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Copy the register command" }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: /connect your own runner/i }),
    ).toBeNull();

    await user.click(screen.getByRole("button", { name: "I copied it" }));

    expect(screen.queryByText(/crt_token-1/)).toBeNull();
    expect(
      screen.getByRole("button", { name: /connect your own runner/i }),
    ).toBeTruthy();
  });

  // #925
  it("stays open on Escape and on a click beside the dialog, until the person says they copied it", async () => {
    const user = userEvent.setup();
    show(fakeApi().api, true);
    await user.click(
      await screen.findByRole("button", { name: /connect your own runner/i }),
    );
    await screen.findByLabelText("Command");

    await user.keyboard("{Escape}");
    // The open dialog blocks pointer events on the page; a pointer press outside is what Radix listens to.
    fireEvent.pointerDown(document.body);
    fireEvent.pointerUp(document.body);

    expect(screen.getByLabelText("Command").textContent).toContain(
      "crt_token-1",
    );
    expect(screen.queryByRole("button", { name: "Close" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "I copied it" }));

    expect(screen.queryByLabelText("Command")).toBeNull();
  });

  // #854-T75
  it("says why none was made when the workspace holds the most", async () => {
    const user = userEvent.setup();
    show(
      fakeApi([BOX], {
        createToken: async () => ({
          ok: false,
          status: 409,
          code: "RUNNER_FLEET_TOKEN_LIMIT_REACHED",
          issues: [],
          details: { maximum: 20 },
        }),
      }).api,
      true,
    );

    await user.click(
      await screen.findByRole("button", { name: /connect your own runner/i }),
    );

    expect(
      await screen.findByText(/holds 20 registration tokens/),
    ).toBeTruthy();
    expect(screen.queryByLabelText("Command")).toBeNull();
  });
});

describe("the two kinds of environment", () => {
  // #925
  it("says the hosted sandbox is billed from the balance only where billing is on", async () => {
    show(fakeApi().api, false, ["review", "implementer", "billing"]);
    expect(
      (await screen.findAllByText(/Billed from the balance/)).length,
    ).toBeGreaterThan(0);
    cleanup();

    show(fakeApi().api, false, ["review", "implementer"]);
    await screen.findByText("Hosted sandbox");

    expect(screen.queryByText(/Billed from the balance/i)).toBeNull();
  });

  // #919
  it("says that a profile picks its runner, with its Runs on field", async () => {
    show(fakeApi().api, false);
    await screen.findByText("Hosted sandbox");

    expect(
      screen.getByText(/A profile says on which of them it runs/),
    ).toBeTruthy();
    expect(screen.queryByText(/#919/)).toBeNull();
  });
});

describe("revoking a runner", () => {
  // #854-T76
  it("asks first, then revokes and drops the runner from the list", async () => {
    const user = userEvent.setup();
    const { api, revoked } = fakeApi();
    show(api, true);

    await user.click(
      await screen.findByRole("button", { name: "Revoke build-box-1" }),
    );
    expect(revoked).toEqual([]);
    await user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", {
        name: "Revoke",
      }),
    );

    await waitFor(() => expect(screen.queryByText("build-box-1")).toBeNull());
    expect(revoked).toEqual(["r1"]);
    expect(screen.getByText("old-box")).toBeTruthy();
    expect(screen.getByText("The runner was revoked.")).toBeTruthy();
  });

  // #854-T76
  it("does not revoke when the person cancels", async () => {
    const user = userEvent.setup();
    const { api, revoked } = fakeApi();
    show(api, true);

    await user.click(
      await screen.findByRole("button", { name: "Revoke build-box-1" }),
    );
    await user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", {
        name: "Cancel",
      }),
    );

    expect(revoked).toEqual([]);
    expect(screen.getByText("build-box-1")).toBeTruthy();
  });

  // #854-T77
  it("drops a runner that is gone already and tells the person so", async () => {
    const user = userEvent.setup();
    show(
      fakeApi([BOX], {
        revoke: async () => refused(404, "RUNNER_FLEET_NOT_FOUND"),
      }).api,
      true,
    );

    await user.click(
      await screen.findByRole("button", { name: "Revoke build-box-1" }),
    );
    await user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", {
        name: "Revoke",
      }),
    );

    await waitFor(() => expect(screen.queryByText("build-box-1")).toBeNull());
    expect(await screen.findByText(/does not exist any more/)).toBeTruthy();
  });
});
