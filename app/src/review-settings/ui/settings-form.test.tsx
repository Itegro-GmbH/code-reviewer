// SPDX-License-Identifier: LicenseRef-Proprietary

// @vitest-environment jsdom
// Pins down the settings form in the browser: wrong values are named next to their field before
// anything is sent, a valid change sends only the fields the person set and shows what the server
// answered, a refusal of the server lands next to its field, "Reset to default" takes a field back, and
// text from the settings is rendered as text.
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { estimateReviewCost } from "../cost.ts";
import { DEFAULT_REVIEW_SKILL } from "../default-skill.ts";
import type { ProjectDynamicView } from "../service.ts";
import {
  builtInReviewSettings,
  DEFAULT_DYNAMIC_MODEL,
  PROJECT_DYNAMIC_LIMITS,
  type ReviewSettings,
} from "../settings.ts";
import {
  chooseOption,
  openSection,
} from "../../test-support/settings-sections.ts";
import {
  dynamicView,
  ownModel,
} from "../../test-support/settings-form-models.ts";
import type { SettingsApi } from "./api.ts";
import type { SettingsFormModel } from "./form-model.ts";
import { SettingsForm } from "./settings-form.tsx";
import { getProductIdentity } from "../../product-identity/current.ts";

afterEach(cleanup);

const BUILT_IN = builtInReviewSettings("anthropic/claude-haiku-5.5");

// The project-only view every project form has since #194: Diff Review, the shipped model and skill.
const DYNAMIC_VIEW: ProjectDynamicView = {
  overrides: {},
  effective: {
    reviewKind: "diff",
    dynamicModel: DEFAULT_DYNAMIC_MODEL,
    reviewSkill: DEFAULT_REVIEW_SKILL.text,
    reviewVerdict: "blocking",
  },
  sources: {
    reviewKind: "built_in",
    dynamicModel: "built_in",
    reviewSkill: "built_in",
    reviewVerdict: "built_in",
  },
  defaults: {
    reviewKind: "diff",
    dynamicModel: DEFAULT_DYNAMIC_MODEL,
    reviewSkill: DEFAULT_REVIEW_SKILL.text,
    reviewVerdict: "blocking",
  },
  reviewSkillIsDefault: true,
  defaultSkill: {
    id: DEFAULT_REVIEW_SKILL.id,
    version: DEFAULT_REVIEW_SKILL.version,
    hash: DEFAULT_REVIEW_SKILL.hash,
  },
  limits: { reviewSkillMaxBytes: PROJECT_DYNAMIC_LIMITS.reviewSkillMaxBytes },
};

function projectModel(
  overrides: SettingsFormModel["overrides"] = {},
  inherited: ReviewSettings = BUILT_IN,
): SettingsFormModel {
  const effective = { ...inherited, ...overrides };
  const sources = Object.fromEntries(
    Object.keys(effective).map((field) => [
      field,
      Object.hasOwn(overrides, field) ? "project" : "built_in",
    ]),
  ) as SettingsFormModel["sources"];
  return {
    mode: "project",
    inherited,
    overrides,
    effective,
    sources,
    cost: estimateReviewCost(effective),
    managed: false,
    catalog: null,
    operatorMaxCostCents: 100,
    lastSaved: null,
    dynamic: DYNAMIC_VIEW,
  };
}

/** The JSON a settings route answers with for a project, built from a model. */
function answerFor(model: SettingsFormModel) {
  return {
    overrides: model.overrides,
    effective: model.effective,
    sources: model.sources,
    inherited: model.inherited,
    cost: model.cost,
    dynamic: model.dynamic,
  };
}

function fakeApi(
  result: Awaited<ReturnType<SettingsApi["save"]>> = { ok: true, data: {} },
) {
  const save = vi.fn<SettingsApi["save"]>(async () => result);
  const reset = vi.fn<NonNullable<SettingsApi["reset"]>>(async () => result);
  return { api: { save, reset } satisfies SettingsApi, save, reset };
}

/**
 * Since #200 a project form that was not changed sends nothing (an empty request would clear the Diff
 * overrides), so a test about what happens to a request makes one change first.
 */
async function changeSomething(user: ReturnType<typeof userEvent.setup>) {
  const findings = screen.getByLabelText("Most findings per review");
  await user.clear(findings);
  await user.type(findings, "12");
}

describe("the settings form", () => {
  it("shows the values in force and where each one comes from", async () => {
    const user = userEvent.setup();
    const model = projectModel({ maxFindings: 9 });
    render(
      <SettingsForm
        product={getProductIdentity()}
        workspaceSlug="acme"
        initial={model}
        api={fakeApi().api}
      />,
    );

    expect(
      (screen.getByLabelText("Most findings per review") as HTMLInputElement)
        .value,
    ).toBe("9");
    const findings = screen
      .getByLabelText("Most findings per review")
      .closest("[data-field]") as HTMLElement;
    expect(within(findings).getByText("Set for this project")).toBeTruthy();
    await openSection(user, "LLM");
    expect(screen.getByLabelText("Model").textContent).toBe(
      "anthropic/claude-haiku-5.5",
    );
    const providerField = screen
      .getByLabelText("Provider")
      .closest("[data-field]") as HTMLElement;
    expect(within(providerField).getByText("Built-in value")).toBeTruthy();
  });

  it("places where a checkbox value comes from right beside the checkbox text", () => {
    render(
      <SettingsForm
        product={getProductIdentity()}
        workspaceSlug="acme"
        initial={projectModel({ largePrChunking: false })}
        api={fakeApi().api}
      />,
    );

    const field = screen
      .getByLabelText("Review a large pull request in chunks")
      .closest("[data-field]") as HTMLElement;
    const label = screen.getByText("Review a large pull request in chunks");

    // The origin (source and reset action) sits on the same row as the checkbox text.
    expect(label.parentElement?.textContent).toContain("Set for this project");
    expect(
      within(field).getByRole("button", {
        name: "Reset to default for Review a large pull request in chunks",
      }),
    ).toBeTruthy();
  });

  it("places where the comment commands setting comes from beside its heading", async () => {
    const user = userEvent.setup();
    render(
      <SettingsForm
        product={getProductIdentity()}
        workspaceSlug="acme"
        initial={projectModel()}
        api={fakeApi().api}
      />,
    );
    await openSection(user, "Trigger");

    const heading = screen.getByText("Comment commands");

    expect(heading.nextElementSibling?.textContent).toBe("Built-in value");
  });

  // #689-T14
  it("has no token budget field in the Limits section, only the cost limit with its maximum", async () => {
    const user = userEvent.setup();
    render(
      <SettingsForm
        product={getProductIdentity()}
        workspaceSlug="acme"
        initial={projectModel()}
        api={fakeApi().api}
      />,
    );

    await openSection(user, "Limits");

    expect(screen.queryByLabelText("Token budget")).toBeNull();
    expect(document.body.textContent).not.toMatch(/token budget/i);
    const limit = screen
      .getByLabelText("Cost limit per review (USD)")
      .closest("[data-field]") as HTMLElement;
    expect(limit.textContent).toContain("at most $1.00");
  });

  // CR-34-T06
  it("names every wrong value next to its field, opens the first section with a problem and sends nothing", async () => {
    const user = userEvent.setup();
    const { api, save } = fakeApi();
    render(
      <SettingsForm
        product={getProductIdentity()}
        workspaceSlug="acme"
        initial={projectModel()}
        api={api}
      />,
    );

    const findings = screen.getByLabelText("Most findings per review");
    await user.clear(findings);
    await user.type(findings, "-3");
    await openSection(user, "Limits");
    const cost = screen.getByLabelText("Cost limit per review (USD)");
    await user.clear(cost);
    await user.type(cost, "lots");
    await user.click(
      screen.getByRole("button", { name: "Save review settings" }),
    );

    expect(save).not.toHaveBeenCalled();
    const field = (label: string) =>
      screen.getByLabelText(label).closest("[data-field]") as HTMLElement;
    // The first section with a problem is open and its first marked control has the focus (rulebook R20).
    expect(
      within(field("Most findings per review")).getByText("Enter 1 or more."),
    ).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toMatch(/marked fields/);
    expect(document.activeElement).toBe(
      screen.getByLabelText("Most findings per review"),
    );
    await openSection(user, "Limits");
    expect(
      within(field("Cost limit per review (USD)")).getByText(
        /Enter an amount in dollars/,
      ),
    ).toBeTruthy();
  });

  // #656-T05
  it("marks the tab of every section with a problem, in its accessible name, until the problem is fixed", async () => {
    const user = userEvent.setup();
    render(
      <SettingsForm
        product={getProductIdentity()}
        workspaceSlug="acme"
        initial={projectModel()}
        api={fakeApi().api}
      />,
    );
    const tabNames = () =>
      screen.getAllByRole("tab").map((tab) => tab.textContent);
    expect(tabNames()).toEqual(["Review", "LLM", "Trigger", "Limits"]);

    const findings = screen.getByLabelText("Most findings per review");
    await user.clear(findings);
    await user.type(findings, "-3");
    await openSection(user, "Limits");
    const cost = screen.getByLabelText("Cost limit per review (USD)");
    await user.clear(cost);
    await user.type(cost, "lots");
    // Nothing is marked before a save is refused.
    expect(tabNames()).toEqual(["Review", "LLM", "Trigger", "Limits"]);
    await user.click(
      screen.getByRole("button", { name: "Save review settings" }),
    );

    expect(
      screen.getByRole("tab", { name: "Review (has a problem)" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("tab", { name: "Limits (has a problem)" }),
    ).toBeTruthy();
    expect(screen.getByRole("tab", { name: "LLM" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Trigger" })).toBeTruthy();

    await openSection(user, "Limits");
    await user.clear(screen.getByLabelText("Cost limit per review (USD)"));
    await user.type(
      screen.getByLabelText("Cost limit per review (USD)"),
      "0.5",
    );

    expect(screen.getByRole("tab", { name: "Limits" })).toBeTruthy();
    expect(
      screen.getByRole("tab", { name: "Review (has a problem)" }),
    ).toBeTruthy();
  });

  // CR-34-T06
  it("names project rules that are too long", async () => {
    const user = userEvent.setup();
    const { api, save } = fakeApi();
    render(
      <SettingsForm
        product={getProductIdentity()}
        workspaceSlug="acme"
        initial={projectModel()}
        api={api}
      />,
    );

    await user.click(screen.getByLabelText("Project rules"));
    await user.paste("x".repeat(4001));
    await user.click(
      screen.getByRole("button", { name: "Save review settings" }),
    );

    expect(save).not.toHaveBeenCalled();
    expect(screen.getByText(/Use at most 4,000 characters/)).toBeTruthy();
  });

  // CR-34-T06, #203 (an unknown command cannot be typed: the form offers exactly the one that exists)
  it("offers exactly the one comment command that exists", async () => {
    const user = userEvent.setup();
    render(
      <SettingsForm
        product={getProductIdentity()}
        workspaceSlug="acme"
        initial={projectModel()}
        api={fakeApi().api}
      />,
    );
    await openSection(user, "Trigger");

    expect(
      screen
        .getAllByRole("checkbox", { name: /^\/[a-z]+$/ })
        .map((box) => box.parentElement?.textContent),
    ).toEqual(["/review"]);
  });

  // CR-34-T05
  it("sends only the fields the person changed and shows the answer of the server", async () => {
    const user = userEvent.setup();
    const saved = projectModel({ maxFindings: 12 });
    const { api, save } = fakeApi({ ok: true, data: answerFor(saved) });
    render(
      <SettingsForm
        product={getProductIdentity()}
        workspaceSlug="acme"
        initial={projectModel()}
        api={api}
      />,
    );

    const findings = screen.getByLabelText("Most findings per review");
    await user.clear(findings);
    await user.type(findings, "12");
    await user.click(
      screen.getByRole("button", { name: "Save review settings" }),
    );

    expect(save).toHaveBeenCalledWith({ maxFindings: 12 });
    expect((await screen.findByRole("status")).textContent).toMatch(/Saved\./);
    expect(screen.getByText(/keeps the values it started with/)).toBeTruthy();
    const field = findings.closest("[data-field]") as HTMLElement;
    expect(within(field).getByText("Set for this project")).toBeTruthy();
  });

  // CR-34-T07
  it("puts the field problems of a refusal from the server next to their fields", async () => {
    const user = userEvent.setup();
    const { api } = fakeApi({
      ok: false,
      status: 400,
      code: "REVIEW_SETTINGS_INVALID",
      issues: [{ field: "maxCostCents", code: "TOO_LARGE" }],
    });
    render(
      <SettingsForm
        product={getProductIdentity()}
        workspaceSlug="acme"
        initial={projectModel()}
        api={api}
      />,
    );

    await openSection(user, "Limits");
    await user.type(
      screen.getByLabelText("Cost limit per review (USD)"),
      "0.5",
    );
    await user.click(
      screen.getByRole("button", { name: "Save review settings" }),
    );

    const field = screen
      .getByLabelText("Cost limit per review (USD)")
      .closest("[data-field]") as HTMLElement;
    expect(
      await within(field).findByText(/Enter an amount from \$0.01/),
    ).toBeTruthy();
    expect(screen.queryByText(/Saved\./)).toBeNull();
  });

  // #689-T06
  it("names the maximum when the server refuses a cost limit above it, and shows no code", async () => {
    const user = userEvent.setup();
    const { api } = fakeApi({
      ok: false,
      status: 400,
      code: "REVIEW_SETTINGS_INVALID",
      issues: [
        {
          field: "maxCostCents",
          code: "EXCEEDS_OPERATOR_MAXIMUM",
          maximumCents: 150,
        },
      ],
    });
    render(
      <SettingsForm
        product={getProductIdentity()}
        workspaceSlug="acme"
        initial={projectModel()}
        api={api}
      />,
    );

    await openSection(user, "Limits");
    const cost = screen.getByLabelText("Cost limit per review (USD)");
    await user.type(cost, "5");
    await user.click(
      screen.getByRole("button", { name: "Save review settings" }),
    );

    const field = cost.closest("[data-field]") as HTMLElement;
    const message = await within(field).findByText(
      "The maximum cost per review is $1.50. Enter that or less.",
    );
    expect(message.textContent).not.toContain("EXCEEDS_OPERATOR_MAXIMUM");
  });

  it("tells the person when the save fails as a whole", async () => {
    const user = userEvent.setup();
    const { api } = fakeApi({
      ok: false,
      status: null,
      code: "NETWORK_ERROR",
      issues: [],
    });
    render(
      <SettingsForm
        product={getProductIdentity()}
        workspaceSlug="acme"
        initial={projectModel()}
        api={api}
      />,
    );

    await changeSomething(user);
    await user.click(
      screen.getByRole("button", { name: "Save review settings" }),
    );

    expect((await screen.findByRole("alert")).textContent).toMatch(
      /could not be reached/,
    );
  });

  // #174-T04
  it("takes a field back to the inherited value with 'Reset to default', without saving", async () => {
    const user = userEvent.setup();
    const { api, save } = fakeApi({
      ok: true,
      data: answerFor(projectModel()),
    });
    render(
      <SettingsForm
        product={getProductIdentity()}
        workspaceSlug="acme"
        initial={projectModel({ maxFindings: 9 })}
        api={api}
      />,
    );

    await user.click(
      screen.getByRole("button", {
        name: "Reset to default for Most findings per review",
      }),
    );

    // The value returns to the built-in immediately, and nothing was saved.
    expect(
      (screen.getByLabelText("Most findings per review") as HTMLInputElement)
        .value,
    ).toBe("5");
    expect(save).not.toHaveBeenCalled();
    await user.click(
      screen.getByRole("button", { name: "Save review settings" }),
    );
    expect(save).toHaveBeenCalledWith({});
  });

  it("resets a project to the defaults for everything after a confirmation, and shows the inherited values", async () => {
    const user = userEvent.setup();
    const { api, reset } = fakeApi({
      ok: true,
      data: answerFor(projectModel()),
    });
    render(
      <SettingsForm
        product={getProductIdentity()}
        workspaceSlug="acme"
        initial={projectModel({ maxFindings: 9 })}
        api={api}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Reset everything" }));
    expect(reset).not.toHaveBeenCalled();
    // The copy names what a full reset takes away (#200 review).
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toMatch(/Review kind/);
    expect(dialog.textContent).toMatch(/review skill/);
    await user.click(screen.getByRole("button", { name: "Reset to defaults" }));

    expect(reset).toHaveBeenCalledTimes(1);
    await screen.findByText(/Saved\./);
    expect(
      (screen.getByLabelText("Most findings per review") as HTMLInputElement)
        .value,
    ).toBe("5");
  });

  it("does not reset anything when the person cancels the confirmation", async () => {
    const user = userEvent.setup();
    const { api, reset } = fakeApi();
    render(
      <SettingsForm
        product={getProductIdentity()}
        workspaceSlug="acme"
        initial={projectModel({ maxFindings: 9 })}
        api={api}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Reset everything" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(reset).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "Reset everything" }),
    ).toBeTruthy();
  });

  it("takes the problem of a field away as soon as the person changes it", async () => {
    const user = userEvent.setup();
    render(
      <SettingsForm
        product={getProductIdentity()}
        workspaceSlug="acme"
        initial={projectModel()}
        api={fakeApi().api}
      />,
    );
    const findings = screen.getByLabelText("Most findings per review");
    await user.clear(findings);
    await user.type(findings, "abc");
    await user.click(
      screen.getByRole("button", { name: "Save review settings" }),
    );
    expect(screen.getByText("Enter a whole number.")).toBeTruthy();

    await user.clear(findings);
    await user.type(findings, "7");

    expect(screen.queryByText("Enter a whole number.")).toBeNull();
    expect(findings.getAttribute("aria-invalid")).toBe("false");
  });

  it("shows a problem of the server that belongs to no field, with the message at the foot", async () => {
    const user = userEvent.setup();
    const { api } = fakeApi({
      ok: false,
      status: 400,
      code: "REVIEW_SETTINGS_INVALID",
      issues: [{ field: "settings", code: "INVALID_TYPE" }],
    });
    render(
      <SettingsForm
        product={getProductIdentity()}
        workspaceSlug="acme"
        initial={projectModel()}
        api={api}
      />,
    );

    await changeSomething(user);
    await user.click(
      screen.getByRole("button", { name: "Save review settings" }),
    );

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/Some settings are not valid/);
    expect(alert.textContent).toMatch(/This value is not valid/);
  });

  it("locks the controls while a save is running, so no keystroke is lost", async () => {
    const user = userEvent.setup();
    let finish: (value: { ok: true; data: unknown }) => void = () => undefined;
    const save = vi.fn<SettingsApi["save"]>(
      () => new Promise((resolve) => (finish = resolve)),
    );
    render(
      <SettingsForm
        product={getProductIdentity()}
        workspaceSlug="acme"
        initial={projectModel()}
        api={{ save }}
      />,
    );

    await changeSomething(user);
    await openSection(user, "LLM");
    await user.click(
      screen.getByRole("button", { name: "Save review settings" }),
    );

    // A disabled fieldset disables its controls without touching their own `disabled` property.
    expect(screen.getByLabelText("Model").matches(":disabled")).toBe(true);
    await openSection(user, "Review");
    const findings = screen.getByLabelText("Most findings per review");
    expect(findings.matches(":disabled")).toBe(true);
    finish({ ok: true, data: answerFor(projectModel()) });
    await screen.findByText(/Saved\./);
    expect(findings.matches(":disabled")).toBe(false);
  });

  it("names every reset button after what the person sees, never after the internal field name", async () => {
    const user = userEvent.setup();
    render(
      <SettingsForm
        product={getProductIdentity()}
        workspaceSlug="acme"
        initial={projectModel({
          largePrChunking: false,
          inlineKeyIssues: true,
          autoReviewOnOpen: false,
          autoReviewOnPush: false,
          allowedCommands: ["review"],
          extraInstructions: "x",
        })}
        api={fakeApi().api}
      />,
    );

    const resetButtons = () =>
      screen
        .getAllByRole("button", { name: /^Reset to default for / })
        .map((button) => button.getAttribute("aria-label"));
    const inReview = resetButtons();
    await openSection(user, "Trigger");
    const names = [...inReview, ...resetButtons()];

    expect(names.length).toBe(6);
    for (const name of names) expect(name).not.toMatch(/[a-z][A-Z]/);
    expect(names).toContain(
      "Reset to default for Review a large pull request in chunks",
    );
    expect(names).toContain("Reset to default for comment commands");
  });

  // CR-34-T05
  it("warns above the cost limit while the person picks a pricey model, and still lets them save", async () => {
    const user = userEvent.setup();
    const { api } = fakeApi();
    render(
      <SettingsForm
        product={getProductIdentity()}
        workspaceSlug="acme"
        initial={projectModel()}
        api={api}
      />,
    );

    await openSection(user, "LLM");
    await chooseOption(
      user,
      screen.getByLabelText("Model"),
      "anthropic/claude-sonnet-5.5",
    );
    await openSection(user, "Limits");

    expect(screen.getByText(/above the warning level of \$0\.10/)).toBeTruthy();
    expect(
      (
        screen.getByRole("button", {
          name: "Save review settings",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
  });

  // CR-34-T05
  it("warns that a model has no known price", async () => {
    const user = userEvent.setup();
    render(
      <SettingsForm
        product={getProductIdentity()}
        workspaceSlug="acme"
        initial={projectModel({ model: "acme/mystery-1" })}
        api={fakeApi().api}
      />,
    );

    await openSection(user, "Limits");

    expect(screen.getByText(/No price is known for/).textContent).toContain(
      "acme/mystery-1",
    );
  });

  // CR-34-T13
  it("renders project rules with HTML as text in the field and runs nothing", () => {
    const hostile =
      '<img src=x onerror="window.pwned=1"><script>window.pwned=1</script>';
    const { container } = render(
      <SettingsForm
        product={getProductIdentity()}
        workspaceSlug="acme"
        initial={projectModel({ extraInstructions: hostile })}
        api={fakeApi().api}
      />,
    );

    expect(
      (screen.getByLabelText("Project rules") as HTMLTextAreaElement).value,
    ).toBe(hostile);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
    expect((window as unknown as { pwned?: number }).pwned).toBeUndefined();
  });

  // CR-34-T08
  it("is the same form for the global defaults, without the reset of a project", () => {
    const model: SettingsFormModel = {
      ...projectModel(),
      mode: "global",
      lastSaved: { at: "2026-10-10T12:34:56Z", by: "octocat" },
    };
    const save = vi.fn<SettingsApi["save"]>();

    render(
      <SettingsForm
        product={getProductIdentity()}
        workspaceSlug="acme"
        initial={model}
        api={{ save }}
      />,
    );

    expect(
      screen.getByRole("button", { name: "Save review defaults" }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: /Reset everything/ }),
    ).toBeNull();
    expect(screen.getByText(/Last saved/).textContent).toMatch(
      /Last saved 2026-10-10 12:34 UTC by octocat\./,
    );
  });

  // CR-34-T05 (without a stand-in, a project form talks to the route of its repository)
  it("saves a project through the settings route of its repository when no stand-in is handed in", async () => {
    const user = userEvent.setup();
    const seen: Array<{ url: string; method: string | undefined }> = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      seen.push({ url, method: init?.method });
      return new Response("{}", { status: 200 });
    });
    render(
      <SettingsForm
        product={getProductIdentity()}
        workspaceSlug="acme"
        initial={projectModel()}
        repositoryId="repo-9"
      />,
    );

    await changeSomething(user);
    await user.click(
      screen.getByRole("button", { name: "Save review settings" }),
    );

    await screen.findByRole("alert");
    expect(seen).toEqual([
      {
        url: "/api/w/acme/repositories/repo-9/project/settings",
        method: "PUT",
      },
    ]);
    vi.unstubAllGlobals();
  });

  // #656-T03
  it("offers exactly a provider and a model dropdown in the LLM section, and no field to type a model in", async () => {
    const user = userEvent.setup();
    render(
      <SettingsForm
        product={getProductIdentity()}
        workspaceSlug="acme"
        initial={projectModel()}
        api={fakeApi().api}
      />,
    );

    await openSection(user, "LLM");

    const panel = screen.getByRole("tabpanel", { name: "LLM" });
    expect(
      within(panel)
        .getAllByRole("combobox")
        .map((box) => box.getAttribute("aria-label") ?? box.id !== ""),
    ).toHaveLength(2);
    expect(within(panel).queryAllByRole("textbox")).toEqual([]);
    expect(within(panel).queryByLabelText("Fallback model")).toBeNull();
  });
});

describe("a read only form (#1108)", () => {
  // #1108: in the factory nobody edits the review settings in the UI; the form says who sets them instead of naming a role.
  it("shows the note it is given in place of the save button, and the default note names the role", () => {
    const { rerender } = render(
      <SettingsForm
        product={getProductIdentity()}
        workspaceSlug="acme"
        initial={projectModel()}
        readOnly
        readOnlyNote="An AI sets these through the API."
        api={fakeApi().api}
      />,
    );

    expect(screen.getByText("An AI sets these through the API.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Save/ })).toBeNull();

    rerender(
      <SettingsForm
        product={getProductIdentity()}
        workspaceSlug="acme"
        initial={projectModel()}
        readOnly
        api={fakeApi().api}
      />,
    );
    expect(
      screen.getByText("Only Admins and Owners can change these values."),
    ).toBeTruthy();
  });
});

describe("the LLM section follows the provider (#656)", () => {
  // #656-T03
  it("lists only the models of the chosen provider, and takes the default model of that provider with it", async () => {
    const user = userEvent.setup();
    render(
      <SettingsForm
        product={getProductIdentity()}
        workspaceSlug="acme"
        initial={projectModel()}
        api={fakeApi().api}
      />,
    );
    await openSection(user, "LLM");
    const optionsOf = async () => {
      await user.click(screen.getByLabelText("Model"));
      const names = screen
        .getAllByRole("option")
        .map((option) => option.textContent ?? "");
      await user.keyboard("{Escape}");
      return names;
    };
    const openRouterModels = await optionsOf();

    await chooseOption(user, screen.getByLabelText("Provider"), "Anthropic");

    const anthropicModels = await optionsOf();
    expect(anthropicModels.length).toBeGreaterThan(0);
    expect(anthropicModels).not.toEqual(openRouterModels);
    expect(anthropicModels).toContain(
      screen.getByLabelText("Model").textContent,
    );
  });
});

describe("the Limits section (#656)", () => {
  // #656-T04
  it("says that an empty cost limit follows the workspace default, names that default, and sends nothing of its own for it", async () => {
    const user = userEvent.setup();
    const { api, save } = fakeApi();
    render(
      <SettingsForm
        product={getProductIdentity()}
        workspaceSlug="acme"
        initial={projectModel(
          { maxCostCents: 100 },
          { ...BUILT_IN, maxCostCents: 250 },
        )}
        api={api}
      />,
    );

    await openSection(user, "Limits");
    const input = screen.getByLabelText(
      "Cost limit per review (USD)",
    ) as HTMLInputElement;
    expect(input.value).toBe("1.00");
    const field = input.closest("[data-field]") as HTMLElement;
    expect(field.textContent).toContain(
      "A review stops when it reaches this amount, at most $1.00.",
    );
    expect(field.textContent).toContain(
      "Leave empty to use the workspace default ($2.50).",
    );
    // Nothing of where the maximum comes from is named to a member.
    expect(field.textContent).not.toMatch(
      /environment|operator|instance|admin/i,
    );
    // No rate and no markup is named next to the limit.
    expect(field.textContent).not.toMatch(/rate|markup|per minute/i);

    await user.clear(input);
    await user.click(
      screen.getByRole("button", { name: "Save review settings" }),
    );

    expect(save).toHaveBeenCalledWith({});
  });

  // #656-T04
  it("sends the cost limit of a project in whole cents, and an emptied limit as none of its own", async () => {
    const user = userEvent.setup();
    const { api, save } = fakeApi();
    render(
      <SettingsForm
        product={getProductIdentity()}
        workspaceSlug="acme"
        initial={projectModel()}
        api={api}
      />,
    );

    await openSection(user, "Limits");
    await user.type(
      screen.getByLabelText("Cost limit per review (USD)"),
      "1.5",
    );
    await user.click(
      screen.getByRole("button", { name: "Save review settings" }),
    );

    expect(save).toHaveBeenCalledWith({ maxCostCents: 150 });
  });

  // #666-T06
  it("says that a Diff Review checks the limit between requests, and a Dynamic Review is not told that", async () => {
    const user = userEvent.setup();
    const diff = render(
      <SettingsForm
        product={getProductIdentity()}
        workspaceSlug="acme"
        initial={projectModel()}
        api={fakeApi().api}
      />,
    );
    await openSection(user, "Limits");
    const diffField = screen
      .getByLabelText("Cost limit per review (USD)")
      .closest("[data-field]") as HTMLElement;
    expect(diffField.textContent).toContain(
      "checked between model requests, so a single request can exceed it",
    );
    diff.unmount();

    render(
      <SettingsForm
        product={getProductIdentity()}
        workspaceSlug="acme"
        initial={projectModel()}
        api={fakeApi().api}
      />,
    );
    await user.click(screen.getByRole("radio", { name: "Dynamic Review" }));
    await openSection(user, "Limits");
    const dynamicField = screen
      .getByLabelText("Cost limit per review (USD)")
      .closest("[data-field]") as HTMLElement;
    expect(dynamicField.textContent).not.toContain("between model requests");
  });

  // #689-T14
  it("shows the maximum the admin set, as the placeholder and in the hint, and says when a saved limit is cut to it", async () => {
    const user = userEvent.setup();
    render(
      <SettingsForm
        product={getProductIdentity()}
        workspaceSlug="acme"
        initial={{
          ...projectModel({ maxCostCents: 600 }),
          operatorMaxCostCents: 250,
        }}
        api={fakeApi().api}
      />,
    );

    await openSection(user, "Limits");
    const input = screen.getByLabelText(
      "Cost limit per review (USD)",
    ) as HTMLInputElement;
    const field = input.closest("[data-field]") as HTMLElement;

    expect(input.value).toBe("6.00");
    expect(field.textContent).toContain("at most $2.50");
    expect(field.textContent).toContain(
      "The saved limit of $6.00 is above the maximum, so reviews stop at $2.50.",
    );
  });

  // #689-T14
  it("shows Max with the amount in an empty field, and names the workspace default cut to the maximum", async () => {
    const user = userEvent.setup();
    render(
      <SettingsForm
        product={getProductIdentity()}
        workspaceSlug="acme"
        initial={{
          ...projectModel({}, { ...BUILT_IN, maxCostCents: 800 }),
          operatorMaxCostCents: 300,
        }}
        api={fakeApi().api}
      />,
    );

    await openSection(user, "Limits");
    const input = screen.getByLabelText(
      "Cost limit per review (USD)",
    ) as HTMLInputElement;

    expect(input.placeholder).toBe("$3.00");
  });

  // #666-T06
  it("says that no limit is set, and shows no amount, when neither the workspace nor the project set one", async () => {
    const user = userEvent.setup();
    render(
      <SettingsForm
        product={getProductIdentity()}
        workspaceSlug="acme"
        initial={projectModel()}
        api={fakeApi().api}
      />,
    );

    await openSection(user, "Limits");

    const field = screen
      .getByLabelText("Cost limit per review (USD)")
      .closest("[data-field]") as HTMLElement;
    expect(field.textContent).toContain(
      "Leave empty for up to $1.00; the workspace sets no limit.",
    );
    expect(field.textContent).not.toContain("$0.10");
    expect(
      (screen.getByLabelText("Cost limit per review (USD)") as HTMLInputElement)
        .placeholder,
    ).toBe("Max $1.00");
  });

  // #656-T04
  it("names a cost limit that is not an amount, with the range and the format", async () => {
    const user = userEvent.setup();
    const { api, save } = fakeApi();
    render(
      <SettingsForm
        product={getProductIdentity()}
        workspaceSlug="acme"
        initial={projectModel()}
        api={api}
      />,
    );

    await openSection(user, "Limits");
    await user.type(
      screen.getByLabelText("Cost limit per review (USD)"),
      "lots",
    );
    await user.click(
      screen.getByRole("button", { name: "Save review settings" }),
    );

    expect(save).not.toHaveBeenCalled();
    expect(
      screen
        .getByLabelText("Cost limit per review (USD)")
        .getAttribute("aria-invalid"),
    ).toBe("true");
    expect(
      screen
        .getByLabelText("Cost limit per review (USD)")
        .closest("[data-field]")?.textContent,
    ).toContain(
      "Enter an amount in dollars with up to two decimals, like 0.50 or 2.",
    );
  });
});

describe("the settings form of a workspace on its own key keeps its stored tier (#283)", () => {
  // #283-T02
  it("shows the model of a workspace on its own key in the LLM section, and no Quality choice", async () => {
    const user = userEvent.setup();
    render(
      <SettingsForm
        product={getProductIdentity()}
        workspaceSlug="acme"
        initial={projectModel({ model: "vendor/project-model" })}
        api={fakeApi().api}
      />,
    );

    await openSection(user, "LLM");
    expect(screen.getByLabelText("Model").textContent).toBe(
      "vendor/project-model",
    );
    expect(screen.queryByRole("radiogroup", { name: "Quality" })).toBeNull();
    await openSection(user, "Limits");
    expect(screen.getByLabelText("Cost limit per review (USD)")).toBeTruthy();
    expect(document.body.textContent).toContain("Estimated cost");
  });
});

describe("the form of the workspace defaults has the sections of a project (#676)", () => {
  // #676-T01
  it("offers the kind and the verdict in Review, the provider and model of the chosen kind in LLM, and no review skill", async () => {
    const user = userEvent.setup();
    const { api, save } = fakeApi();
    render(
      <SettingsForm
        product={getProductIdentity()}
        workspaceSlug="acme"
        initial={ownModel({ mode: "global" })}
        api={api}
        dynamicReviewEnabled
      />,
    );

    expect(
      screen.getByRole("radiogroup", { name: "Review kind" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("radiogroup", { name: "Review verdict" }),
    ).toBeTruthy();
    expect(screen.queryByLabelText("Review skill")).toBeNull();

    // Diff Review is the kind: its provider and model are in LLM.
    await openSection(user, "LLM");
    expect(screen.getByLabelText("Provider").textContent).toContain(
      "OpenRouter",
    );
    await openSection(user, "Review");
    await user.click(screen.getByRole("radio", { name: "Dynamic Review" }));
    // Dynamic Review is chosen: the provider and model of the Dynamic default.
    expect(screen.queryByLabelText("Review skill")).toBeNull();
    await openSection(user, "LLM");
    expect(screen.getByLabelText("Model").textContent).toBe(
      DEFAULT_DYNAMIC_MODEL,
    );
    await openSection(user, "Limits");
    expect(screen.queryByLabelText("Token budget")).toBeNull();
    expect(screen.getByLabelText("Cost limit per review (USD)")).toBeTruthy();

    // The change of the kind of every project is confirmed first, and the confirmation speaks of the projects.
    await user.click(
      screen.getByRole("button", { name: "Save review defaults" }),
    );
    const dialog = await screen.findByRole("alertdialog", {
      name: "Switch to Dynamic Review?",
    });
    expect(dialog.textContent).toMatch(
      /Every project that sets no review kind/,
    );
    expect(save).not.toHaveBeenCalled();
    await user.click(
      within(dialog).getByRole("button", { name: "Switch to Dynamic Review" }),
    );
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0]?.[0]).toEqual({ reviewKind: "dynamic" });
  });

  // #676-T01
  it("says there is nothing to save when nothing changed, and sends the whole set when something did", async () => {
    const user = userEvent.setup();
    const { api, save } = fakeApi();
    const model = ownModel({ mode: "global" });
    render(
      <SettingsForm
        product={getProductIdentity()}
        workspaceSlug="acme"
        initial={model}
        api={api}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: "Save review defaults" }),
    );
    expect(await screen.findByText("No changes to save.")).toBeTruthy();
    expect(save).not.toHaveBeenCalled();

    await openSection(user, "Review");
    await user.click(screen.getByRole("radio", { name: "Any finding" }));
    await changeSomething(user);
    await user.click(
      screen.getByRole("button", { name: "Save review defaults" }),
    );

    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    // The kind is in every save, Diff Review too (#676 review fix 1).
    expect(save.mock.calls[0]?.[0]).toEqual({
      maxFindings: 12,
      reviewKind: "diff",
      reviewVerdict: "any",
    });
  });

  // #676-T01
  it("shows a Dynamic default that was saved, with the origin the project forms refer to", async () => {
    const user = userEvent.setup();
    const view = dynamicView("dynamic", false);
    const model: SettingsFormModel = {
      ...ownModel({ mode: "global" }),
      dynamic: {
        ...view,
        overrides: { reviewKind: "dynamic", dynamicModel: "vendor/model-a" },
        effective: { ...view.effective, dynamicModel: "vendor/model-a" },
        sources: {
          ...view.sources,
          reviewKind: "project",
          dynamicModel: "project",
        },
      },
    };
    render(
      <SettingsForm
        product={getProductIdentity()}
        workspaceSlug="acme"
        initial={model}
        api={fakeApi().api}
      />,
    );

    expect(
      screen
        .getByRole("radio", { name: "Dynamic Review" })
        .getAttribute("aria-checked"),
    ).toBe("true");
    await openSection(user, "LLM");
    expect(screen.getByLabelText("Model").textContent).toBe("vendor/model-a");
    expect(screen.getByText("Changed from the built-in value")).toBeTruthy();
    expect(
      screen.getByRole("button", {
        name: "Reset to default for Dynamic Review provider and model",
      }),
    ).toBeTruthy();
  });
});

describe("a project form follows the workspace defaults (#676)", () => {
  /** A project whose kind, Dynamic model and verdict come from the defaults of the workspace. */
  function followingModel(): SettingsFormModel {
    const view = dynamicView("dynamic", false);
    return {
      ...ownModel({ kind: "dynamic" }),
      dynamic: {
        ...view,
        effective: {
          ...view.effective,
          dynamicModel: "vendor/workspace-model",
          reviewVerdict: "any",
        },
        defaults: {
          ...view.defaults,
          reviewKind: "dynamic",
          dynamicModel: "vendor/workspace-model",
          reviewVerdict: "any",
        },
        sources: {
          ...view.sources,
          reviewKind: "global",
          dynamicModel: "global",
          reviewVerdict: "global",
        },
      },
    };
  }

  // #676-T02
  it("says the kind and the verdict are the global default, and shows the model with that origin", async () => {
    const user = userEvent.setup();
    render(
      <SettingsForm
        product={getProductIdentity()}
        workspaceSlug="acme"
        initial={followingModel()}
        repositoryId="r1"
        api={fakeApi().api}
        dynamicReviewEnabled
      />,
    );

    expect(screen.getAllByText("Global default")).toHaveLength(2);
    await openSection(user, "LLM");
    expect(screen.getByLabelText("Model").textContent).toBe(
      "vendor/workspace-model",
    );
    expect(screen.getAllByText("Global default").length).toBeGreaterThan(0);
    // Nothing is set for the project, so there is nothing to take back.
    expect(
      screen.queryByRole("button", { name: /Reset to default for Dynamic/ }),
    ).toBeNull();
  });

  // #676-T02
  it("takes a model of its own back to the model of the workspace default, which clears the override on save", async () => {
    const user = userEvent.setup();
    const { api, save } = fakeApi();
    const base = followingModel();
    const model: SettingsFormModel = {
      ...base,
      dynamic: {
        ...base.dynamic!,
        overrides: { dynamicModel: "vendor/own-model" },
        effective: {
          ...base.dynamic!.effective,
          dynamicModel: "vendor/own-model",
        },
        sources: { ...base.dynamic!.sources, dynamicModel: "project" },
      },
    };
    render(
      <SettingsForm
        product={getProductIdentity()}
        workspaceSlug="acme"
        initial={model}
        repositoryId="r1"
        api={api}
      />,
    );

    await openSection(user, "LLM");
    await user.click(
      screen.getByRole("button", {
        name: "Reset to default for Dynamic Review provider and model",
      }),
    );
    expect(screen.getByLabelText("Model").textContent).toBe(
      "vendor/workspace-model",
    );
    await user.click(
      screen.getByRole("button", { name: "Save review settings" }),
    );

    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    // The model of the workspace default is the default: choosing it again clears the project's own.
    expect(save.mock.calls[0]?.[0]).toEqual({ dynamicModel: null });
  });
});

// #676: the review of #679 (fixes 4 and 5).
describe("the confirmation and the version of a save of the workspace defaults", () => {
  const SAVE_DEFAULTS = { name: "Save review defaults" };

  async function switchToDynamic(
    following: number | undefined,
  ): Promise<HTMLElement> {
    const user = userEvent.setup();
    const { api } = fakeApi();
    const base = ownModel({ mode: "global" });
    render(
      <SettingsForm
        product={getProductIdentity()}
        workspaceSlug="acme"
        initial={{
          ...base,
          ...(following === undefined ? {} : { followingProjects: following }),
        }}
        api={api}
        dynamicReviewEnabled
      />,
    );
    await openSection(user, "Review");
    await user.click(screen.getByRole("radio", { name: "Dynamic Review" }));
    await user.click(screen.getByRole("button", SAVE_DEFAULTS));
    return screen.findByRole("alertdialog", {
      name: "Switch to Dynamic Review?",
    });
  }

  // #676-T04
  it("says how many projects follow the default and switch, and that their waiting reviews are cancelled", async () => {
    const dialog = await switchToDynamic(3);

    expect(dialog.textContent).toMatch(
      /3 projects follow this default and switch to Dynamic Review\./,
    );
    expect(dialog.textContent).toMatch(
      /reviews that are still waiting are cancelled, and a review that is already running finishes/,
    );
    expect(dialog.textContent).not.toMatch(
      /keep the kind they were queued for/,
    );
  });

  // #676-T04
  it("says so when one project, or none, follows the default", async () => {
    expect((await switchToDynamic(1)).textContent).toMatch(
      /1 project follows this default and switches to Dynamic Review\./,
    );
    cleanup();
    expect((await switchToDynamic(0)).textContent).toMatch(
      /No existing project follows this default, so nothing switches/,
    );
  });

  // #676-T09
  it("sends the version of the defaults it was built from, and sends none for a project", async () => {
    const user = userEvent.setup();
    const { api, save } = fakeApi();
    const model: SettingsFormModel = {
      ...ownModel({ mode: "global" }),
      lastSaved: { at: "2026-10-10T08:00:00.000Z", by: "ada" },
    };
    render(
      <SettingsForm
        product={getProductIdentity()}
        workspaceSlug="acme"
        initial={model}
        api={api}
      />,
    );
    await changeSomething(user);
    await user.click(screen.getByRole("button", SAVE_DEFAULTS));

    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0]?.[1]).toEqual({
      expectedUpdatedAt: "2026-10-10T08:00:00.000Z",
    });

    cleanup();
    const project = fakeApi();
    render(
      <SettingsForm
        product={getProductIdentity()}
        workspaceSlug="acme"
        initial={projectModel({})}
        api={project.api}
      />,
    );
    await changeSomething(user);
    await user.click(
      screen.getByRole("button", { name: "Save review settings" }),
    );
    await waitFor(() => expect(project.save).toHaveBeenCalledTimes(1));
    expect(project.save.mock.calls[0]).toHaveLength(1);
  });

  // #676-T09
  it("tells the person that the defaults were changed meanwhile, and keeps their edit", async () => {
    const user = userEvent.setup();
    const { api, save } = fakeApi();
    save.mockResolvedValueOnce({
      ok: false,
      status: 409,
      code: "REVIEW_SETTINGS_STALE",
      issues: [],
    });
    render(
      <SettingsForm
        product={getProductIdentity()}
        workspaceSlug="acme"
        initial={ownModel({ mode: "global" })}
        api={api}
      />,
    );
    await changeSomething(user);
    await user.click(screen.getByRole("button", SAVE_DEFAULTS));

    expect(
      await screen.findByText(
        "These defaults were changed meanwhile — reload the page and decide again.",
      ),
    ).toBeTruthy();
    expect(
      (screen.getByLabelText("Most findings per review") as HTMLInputElement)
        .value,
    ).toBe("12");
  });

  // #676-T07
  it("names the projects a refused provider change would break", async () => {
    const user = userEvent.setup();
    const { api, save } = fakeApi();
    save.mockResolvedValueOnce({
      ok: false,
      status: 400,
      code: "REVIEW_SETTINGS_INVALID",
      issues: [
        { field: "dynamicProvider", code: "PROJECT_MODEL_BOUND_TO_PROVIDER" },
      ],
      details: { projects: ["acme/widgets", "acme/gadgets"] },
    });
    render(
      <SettingsForm
        product={getProductIdentity()}
        workspaceSlug="acme"
        initial={ownModel({ mode: "global" })}
        api={api}
      />,
    );
    await changeSomething(user);
    await user.click(screen.getByRole("button", SAVE_DEFAULTS));

    expect(
      await screen.findByText(/Projects: acme\/widgets, acme\/gadgets\./),
    ).toBeTruthy();
  });
});
