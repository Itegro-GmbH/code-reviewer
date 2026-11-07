// SPDX-License-Identifier: LicenseRef-Proprietary

// @vitest-environment jsdom
// The lane builder as a whole (#926): the shipped lane "Issue to PR" opens, round-trips (open, change the instruction, save) to a document
// the real validator accepts, and every change is validated live: a red count on the card, the sentence in the header, no save while the
// lane is invalid. The validator here is the real one; only the transport is replaced.
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BuilderApi } from "./api.ts";
import { LaneBuilder } from "./builder.tsx";
import { getAt, nodeAt, type Doc } from "./document.ts";
import { answerOf, fakeBuilderApi, shippedLane } from "./test-fixtures.ts";

const navigation = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: navigation.refresh }),
}));

afterEach(() => {
  cleanup();
  navigation.refresh.mockClear();
});

const PROFILES = [
  { name: "implementer", version: 2 },
  { name: "reviewer", version: 1 },
];

function open(
  options: {
    document?: unknown;
    api?: BuilderApi;
    profiles?: typeof PROFILES;
  } = {},
) {
  const fake = fakeBuilderApi(3);
  const view = render(
    <LaneBuilder
      workspaceSlug="acme"
      workflowId="wf-1"
      version={3}
      versions={[
        { version: 3, savedAt: "2026-11-06T10:00:00.000Z" },
        { version: 2, savedAt: "2026-11-05T10:00:00.000Z" },
      ]}
      document={options.document ?? shippedLane()}
      profiles={options.profiles ?? PROFILES}
      startPanel={<p>The start form</p>}
      api={options.api ?? fake.api}
      validateDelayMs={0}
    />,
  );
  const card = (pointer: string) =>
    view.container.querySelector(`[data-node="${pointer}"]`) as HTMLElement;
  return { ...view, ...fake, card };
}

describe("opening the shipped lane", () => {
  // #926-T50
  it("is valid, says so with its steps and budget, and has nothing to save yet", async () => {
    open();
    expect(await screen.findByText("Valid · 10 steps · $20")).toBeTruthy();
    const save = screen.getByRole("button", {
      name: "Save as v4",
    }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
  });

  // #926-T51
  it("shows the lane card: limits, versions and the sentence about ask", async () => {
    open();
    const lane = screen.getByRole("region", { name: "Lane" });
    expect(within(lane).getByLabelText("Budget value").textContent).toBe("20");
    expect(within(lane).getByLabelText("Time per turn value").textContent).toBe(
      "60",
    );
    expect(within(lane).getByText("v3 · current")).toBeTruthy();
    expect(within(lane).getByText("v2")).toBeTruthy();
    expect(within(lane).getByText(/A turn ends with done or ask/)).toBeTruthy();
    await screen.findByText(/^Valid/);
  });

  // #926-T52
  it("shows the document as read only JSON on request", async () => {
    open();
    expect(screen.queryByLabelText("The lane as JSON, read only")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "JSON" }));
    const json = screen.getByLabelText("The lane as JSON, read only");
    expect(json.tagName).toBe("PRE");
    expect(json.textContent).toContain('"name": "Issue to PR"');
    fireEvent.click(screen.getByRole("button", { name: "Hide JSON" }));
    expect(screen.queryByLabelText("The lane as JSON, read only")).toBeNull();
    await screen.findByText(/^Valid/);
  });

  // #926-T53
  it("says it cannot edit a document that is not a lane", () => {
    open({ document: "nonsense" });
    expect(screen.getByText(/cannot be read as a lane/)).toBeTruthy();
  });
});

describe("the round trip", () => {
  // #926-T54
  it("open, change the instruction, save: a document the validator accepts, as the next version", async () => {
    const { card, saved } = open();
    await screen.findByText(/^Valid/);
    fireEvent.click(card("/steps/1/body/1"));
    fireEvent.change(screen.getByLabelText("Instruction"), {
      target: {
        value: "Review branch {{implement.branch}}. Only report real bugs.",
      },
    });
    const save = screen.getByRole("button", {
      name: "Save as v4",
    }) as HTMLButtonElement;
    await waitFor(() => expect(save.disabled).toBe(false));
    fireEvent.click(save);

    await waitFor(() => expect(saved).toHaveLength(1));
    const body = saved[0] as Doc;
    expect(getAt(body, "/steps/1/body/1/instruction")).toBe(
      "Review branch {{implement.branch}}. Only report real bugs.",
    );
    expect(answerOf(body).valid).toBe(true);
    // Nothing else changed.
    const before = shippedLane();
    expect(getAt(body, "/steps/1/body/0")).toEqual(
      getAt(before, "/steps/1/body/0"),
    );
    expect(body.triggers).toEqual(before.triggers);
    expect(body.onFailure).toEqual(before.onFailure);
    await screen.findByText("Saved.");
    expect(screen.getByRole("button", { name: "Save as v5" })).toBeTruthy();
    expect(navigation.refresh).toHaveBeenCalled();
  });

  // #926-T55
  it("opens a document written with the single trigger of before and saves it with triggers", async () => {
    const old = { ...shippedLane() } as Record<string, unknown>;
    delete old.triggers;
    old.trigger = { kind: "github.issueLabeled", label: "agent implement" };
    const { card, saved } = open({ document: old });
    await screen.findByText(/^Valid/);
    fireEvent.click(card("/steps/0"));
    fireEvent.change(screen.getByLabelText("Id"), {
      target: { value: "begin" },
    });
    const save = screen.getByRole("button", {
      name: "Save as v4",
    }) as HTMLButtonElement;
    await waitFor(() => expect(save.disabled).toBe(false));
    fireEvent.click(save);
    await waitFor(() => expect(saved).toHaveLength(1));
    expect((saved[0] as Doc).triggers).toEqual([
      {
        id: "labeled",
        kind: "github.issueLabeled",
        label: "agent implement",
        steps: [],
      },
    ]);
    expect(answerOf(saved[0]).valid).toBe(true);
  });

  // #926-T56
  it("tells a lost race and keeps the person's changes", async () => {
    const fake = fakeBuilderApi(3);
    const api: BuilderApi = {
      validate: fake.api.validate,
      save: () =>
        Promise.resolve({
          ok: false,
          status: 409,
          code: "WORKFLOW_VERSION_CONFLICT",
          issues: [],
        }),
    };
    const { card } = open({ api });
    await screen.findByText(/^Valid/);
    fireEvent.click(card("/steps/1/body/1"));
    fireEvent.change(screen.getByLabelText("Instruction"), {
      target: { value: "Changed." },
    });
    const save = screen.getByRole("button", {
      name: "Save as v4",
    }) as HTMLButtonElement;
    await waitFor(() => expect(save.disabled).toBe(false));
    fireEvent.click(save);
    expect(
      (await screen.findByText(/saved by someone else/)).textContent,
    ).toContain("Reload the page");
    expect(
      (screen.getByLabelText("Instruction") as HTMLTextAreaElement).value,
    ).toBe("Changed.");
  });
});

describe("validation on every change", () => {
  // #926-T57
  it("counts an error on the card it belongs to, says it in the header and does not save", async () => {
    const { card } = open({ profiles: [] });
    await screen.findByText(/^Valid/);
    fireEvent.click(card("/steps/1/body/1"));
    fireEvent.change(screen.getByLabelText("Profile"), {
      target: { value: "nobody" },
    });

    expect(await screen.findByText("1 error, not saved")).toBeTruthy();
    expect(
      within(card("/steps/1/body/1")).getByLabelText("1 error"),
    ).toBeTruthy();
    expect(
      within(card("/steps/1/body/0")).queryByLabelText(/error/),
    ).toBeNull();
    const problem = screen.getByRole("group", {
      name: "Error profile_unknown",
    });
    expect(
      within(within(problem).getByLabelText("Available")).getByText(
        "implementer",
      ),
    ).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Save as v4" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  // #926-T58
  it("follows a removed step: what used it is reported, and the lane is not saved", async () => {
    const { card } = open();
    await screen.findByText("Valid · 10 steps · $20");
    fireEvent.click(card("/steps/1/body/0"));
    fireEvent.click(screen.getByRole("button", { name: "Remove step" }));

    expect(await screen.findByText(/errors?, not saved/)).toBeTruthy();
    expect(card("/steps/1/body/0").textContent).toContain("review");
    expect(card("/steps/1/body/1")).toBeNull();
    const reported = [...document.querySelectorAll("[data-node]")].filter(
      (entry) =>
        entry.querySelector("[aria-label$='error'],[aria-label$='errors']"),
    );
    expect(reported.length).toBeGreaterThan(0);
    expect(
      (screen.getByRole("button", { name: "Save as v4" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  // #926-T59
  it("adds a step with the plus, selects it, and counts it", async () => {
    const { card } = open();
    await screen.findByText("Valid · 10 steps · $20");
    fireEvent.click(
      screen.getByRole("button", { name: "Add a step after start" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Agent step" }));
    expect(card("/steps/1").getAttribute("data-kind")).toBe("agent");
    expect(card("/steps/1").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByLabelText("Id")).toBeTruthy();
    expect((screen.getByLabelText("Id") as HTMLInputElement).value).toBe(
      "agent",
    );
    expect((screen.getByLabelText("Profile") as HTMLSelectElement).value).toBe(
      "implementer",
    );
    expect(screen.getByText(/Shared steps · in order · 11 of 50/)).toBeTruthy();
    await screen.findByText(/^(Valid|\d+ errors?)/);
  });

  // #926-T60
  it("moves a step and keeps it selected", async () => {
    const { card } = open();
    await screen.findByText(/^Valid/);
    fireEvent.click(card("/steps/0"));
    fireEvent.click(screen.getByRole("button", { name: "Move down" }));
    expect(nodeAt({ steps: [] }, "/steps/0")).toBeUndefined();
    expect(card("/steps/1").textContent).toContain("start");
    expect(card("/steps/1").getAttribute("aria-pressed")).toBe("true");
  });

  // #926-T61
  it("changes the limits of the lane in the document", async () => {
    const { saved } = open();
    await screen.findByText(/^Valid/);
    fireEvent.click(screen.getByRole("button", { name: "More budget" }));
    fireEvent.click(screen.getByRole("button", { name: "Less time per turn" }));
    expect(await screen.findByText("Valid · 10 steps · $25")).toBeTruthy();
    const save = screen.getByRole("button", {
      name: "Save as v4",
    }) as HTMLButtonElement;
    await waitFor(() => expect(save.disabled).toBe(false));
    fireEvent.click(save);
    await waitFor(() => expect(saved).toHaveLength(1));
    expect(saved[0]).toMatchObject({ budgetUsd: 25, turnTimeLimitMinutes: 55 });
  });

  // #926-T62
  it("says when the validator cannot be asked, and does not save", async () => {
    const api: BuilderApi = {
      validate: () =>
        Promise.resolve({
          ok: false,
          status: null,
          code: "NETWORK_ERROR",
          issues: [],
        }),
      save: fakeBuilderApi().api.save,
    };
    const { card } = open({ api });
    expect(
      (await screen.findAllByText(/Could not check the lane/)).length,
    ).toBeGreaterThan(0);
    fireEvent.click(card("/steps/0"));
    fireEvent.change(screen.getByLabelText("Id"), {
      target: { value: "begin" },
    });
    expect(
      (screen.getByRole("button", { name: "Save as v4" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });
});

describe("run now", () => {
  // #926-T63
  it("opens the start form, and says it starts the saved version, not the changes", async () => {
    const { card } = open();
    await screen.findByText(/^Valid/);
    fireEvent.click(screen.getByRole("button", { name: "Run now" }));
    expect(await screen.findByText("The start form")).toBeTruthy();
    expect(screen.getByText("Starts the saved version.")).toBeTruthy();
    fireEvent.keyDown(document.activeElement ?? document.body, {
      key: "Escape",
    });
    await waitFor(() =>
      expect(screen.queryByText("The start form")).toBeNull(),
    );
    fireEvent.click(card("/steps/0"));
    fireEvent.change(screen.getByLabelText("Id"), {
      target: { value: "begin" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Run now" }));
    expect(
      await screen.findByText(/Your unsaved changes are not part of it/),
    ).toBeTruthy();
  });
});
