// SPDX-License-Identifier: LicenseRef-Proprietary

// @vitest-environment jsdom
// The form that starts a run by hand (#873), with a stand-in for the start route: the fields of the trigger's input, what is checked
// before anything is sent, the `clientRequestId` that makes a retry of the same input one run, and the sentence of every refusal.
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RequestResult } from "../ui/json-request.ts";
import type { RunView } from "../workflow-runs/service.ts";
import type { WorkflowRunsApi } from "./api.ts";
import { START_COPY } from "./messages.ts";
import { inputOf, StartForm } from "./start-form.tsx";
import type { StartField } from "./start-form-spec.ts";
import { run } from "./test-fixtures.ts";

const navigation = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: navigation.push }),
}));

afterEach(() => {
  cleanup();
  navigation.push.mockClear();
});

const FIELDS: StartField[] = [
  { name: "repo", required: true, kind: "string" },
  {
    name: "topic",
    required: false,
    kind: "string",
    description: "What to look at",
  },
];

const ok = (value: RunView): RequestResult<{ run: RunView }> => ({
  ok: true,
  data: { run: value },
});
const refused = (
  status: number,
  code: string,
  details?: Record<string, unknown>,
): RequestResult<{ run: RunView }> => ({
  ok: false,
  status,
  code,
  issues: [],
  ...(details === undefined ? {} : { details }),
});

type StartBody = { input: Record<string, unknown>; clientRequestId: string };

function apiAnswering(...answers: RequestResult<{ run: RunView }>[]) {
  const fake = {
    start: vi.fn<
      (
        workflowId: string,
        body: StartBody,
      ) => Promise<RequestResult<{ run: RunView }>>
    >(async () => answers.shift() ?? refused(500, "UNEXPECTED_RESPONSE")),
  };
  return fake as unknown as WorkflowRunsApi & { start: typeof fake.start };
}

function renderForm(api: WorkflowRunsApi, fields: StartField[] = FIELDS) {
  return render(
    <StartForm
      workspaceSlug="acme"
      workflowId="wf-1"
      fields={fields}
      api={api}
    />,
  );
}

describe("the fields", () => {
  // #873-T50
  it("shows one field for each input of the trigger, labelled, with the note of the workflow", () => {
    renderForm(apiAnswering(), [
      ...FIELDS,
      { name: "issue", required: true, kind: "integer" },
      { name: "dry", required: false, kind: "boolean" },
      { name: "labels", required: false, kind: "json" },
    ]);

    expect(screen.getByLabelText("Repository")).toBeTruthy();
    expect(screen.getByLabelText("topic")).toBeTruthy();
    expect(screen.getByText("What to look at")).toBeTruthy();
    expect(screen.getByLabelText("issue")).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: "dry" })).toBeTruthy();
    expect(screen.getByLabelText("labels")).toBeTruthy();
  });
});

describe("what is sent", () => {
  // #873-T51
  it("starts with the input typed, leaves empty optional fields out, and goes to the run", async () => {
    const user = userEvent.setup();
    const api = apiAnswering(ok(run({ id: "run-9" })));
    renderForm(api);

    await user.type(screen.getByLabelText("Repository"), "acme/widgets");
    await user.click(screen.getByRole("button", { name: START_COPY.start }));

    await waitFor(() => expect(api.start).toHaveBeenCalledTimes(1));
    expect(api.start).toHaveBeenCalledWith("wf-1", {
      input: { repo: "acme/widgets" },
      clientRequestId: expect.stringMatching(/^[\x21-\x7e]{1,200}$/),
    });
    await waitFor(() =>
      expect(navigation.push).toHaveBeenCalledWith(
        "/w/acme/workflows/wf-1/runs/run-9",
      ),
    );
  });

  // #873-T52
  it("does not send a form with a required field empty, and says which one", async () => {
    const user = userEvent.setup();
    const api = apiAnswering(ok(run()));
    renderForm(api);

    await user.click(screen.getByRole("button", { name: START_COPY.start }));

    expect(api.start).not.toHaveBeenCalled();
    expect(
      screen.getByLabelText("Repository").getAttribute("aria-invalid"),
    ).toBe("true");
    expect(screen.getByText(START_COPY.required)).toBeTruthy();
  });

  // #873-T53
  it("sends numbers as numbers, a checkbox as true/false and JSON as a value, and refuses text where they are asked", async () => {
    const fields: StartField[] = [
      { name: "repo", required: true, kind: "string" },
      { name: "issue", required: true, kind: "integer" },
      { name: "dry", required: true, kind: "boolean" },
      { name: "labels", required: false, kind: "json" },
    ];
    const user = userEvent.setup();
    const api = apiAnswering(ok(run()));
    renderForm(api, fields);

    await user.type(screen.getByLabelText("Repository"), "acme/widgets");
    await user.type(screen.getByLabelText("issue"), "seven");
    await user.click(screen.getByRole("button", { name: START_COPY.start }));
    expect(api.start).not.toHaveBeenCalled();
    expect(screen.getByText(START_COPY.notInteger)).toBeTruthy();

    await user.clear(screen.getByLabelText("issue"));
    await user.type(screen.getByLabelText("issue"), "7");
    await user.click(screen.getByLabelText("labels"));
    await user.paste('["bug"]');
    await user.click(screen.getByRole("button", { name: START_COPY.start }));

    await waitFor(() => expect(api.start).toHaveBeenCalledTimes(1));
    expect(api.start.mock.calls[0]?.[1].input).toEqual({
      repo: "acme/widgets",
      issue: 7,
      dry: false,
      labels: ["bug"],
    });
  });
});

describe("the same request", () => {
  // #873-T54
  it("keeps the clientRequestId when the same input is sent again, and makes another for an edited input", async () => {
    const user = userEvent.setup();
    const api = apiAnswering(
      refused(0, "NETWORK_ERROR"),
      refused(0, "NETWORK_ERROR"),
      ok(run()),
    );
    renderForm(api);

    await user.type(screen.getByLabelText("Repository"), "acme/widgets");
    await user.click(screen.getByRole("button", { name: START_COPY.start }));
    await waitFor(() => expect(api.start).toHaveBeenCalledTimes(1));
    await user.click(screen.getByRole("button", { name: START_COPY.start }));
    await waitFor(() => expect(api.start).toHaveBeenCalledTimes(2));
    await user.type(screen.getByLabelText("topic"), "caching");
    await user.click(screen.getByRole("button", { name: START_COPY.start }));
    await waitFor(() => expect(api.start).toHaveBeenCalledTimes(3));

    const ids = api.start.mock.calls.map((call) => call[1].clientRequestId);
    expect(ids[0]).toBe(ids[1]);
    expect(ids[2]).not.toBe(ids[0]);
  });

  // #873-T54
  it("releases the form after a start and makes the next start with the same input another request", async () => {
    const user = userEvent.setup();
    const api = apiAnswering(
      ok(run({ id: "run-1" })),
      ok(run({ id: "run-2" })),
    );
    const { container } = renderForm(api);

    await user.type(screen.getByLabelText("Repository"), "acme/widgets");
    await user.click(screen.getByRole("button", { name: START_COPY.start }));
    await waitFor(() =>
      expect(navigation.push).toHaveBeenCalledWith(
        "/w/acme/workflows/wf-1/runs/run-1",
      ),
    );

    // The page stays mounted when the person comes back with "back": the form is usable again, with what was typed.
    const button = container.querySelector("button[type=submit]");
    await waitFor(() => expect(button?.hasAttribute("disabled")).toBe(false));
    expect(
      (screen.getByLabelText("Repository") as HTMLInputElement).disabled,
    ).toBe(false);
    await user.click(screen.getByRole("button", { name: START_COPY.start }));
    await waitFor(() => expect(api.start).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(navigation.push).toHaveBeenLastCalledWith(
        "/w/acme/workflows/wf-1/runs/run-2",
      ),
    );

    const ids = api.start.mock.calls.map((call) => call[1].clientRequestId);
    expect(api.start.mock.calls[1]?.[1].input).toEqual(
      api.start.mock.calls[0]?.[1].input,
    );
    expect(ids[1]).not.toBe(ids[0]);
  });

  // #873-T54
  it("does not send twice while the first answer is on its way", async () => {
    const user = userEvent.setup();
    let release: (value: RequestResult<{ run: RunView }>) => void = () => {};
    const api = {
      start: vi.fn(
        () =>
          new Promise<RequestResult<{ run: RunView }>>((resolve) => {
            release = resolve;
          }),
      ),
    } as unknown as WorkflowRunsApi;
    renderForm(api);

    await user.type(screen.getByLabelText("Repository"), "acme/widgets");
    const button = screen.getByRole("button", { name: START_COPY.start });
    await user.click(button);
    await user.click(button);
    await user.keyboard("{Enter}");

    expect(api.start).toHaveBeenCalledTimes(1);
    release(ok(run()));
  });
});

describe("a refusal", () => {
  // #873-T55
  it.each([
    ["WORKFLOW_RUN_REPOSITORY_NOT_FOUND", 404, "not one of this workspace"],
    ["WORKFLOW_RUN_WORKFLOW_ARCHIVED", 409, "archived"],
    ["WORKFLOW_RUN_GITHUB_UNAVAILABLE", 503, "GitHub could not be asked"],
    ["NETWORK_ERROR", null, "could not be reached"],
  ])(
    "says what %s means, in words, and keeps the form",
    async (code, status, words) => {
      const user = userEvent.setup();
      const api = apiAnswering({
        ok: false,
        status,
        code,
        issues: [],
      });
      const { container } = renderForm(api);

      await user.type(screen.getByLabelText("Repository"), "acme/widgets");
      await user.click(screen.getByRole("button", { name: START_COPY.start }));

      const alert = await screen.findByRole("alert");
      expect(alert.textContent).toContain(words);
      expect(alert.textContent).not.toContain(code);
      expect(
        (screen.getByLabelText("Repository") as HTMLInputElement).value,
      ).toBe("acme/widgets");
      expect(
        container
          .querySelector("button[type=submit]")
          ?.hasAttribute("disabled"),
      ).toBe(false);
      expect(navigation.push).not.toHaveBeenCalled();
    },
  );

  // #873-T56
  it("marks the field the server named when the input does not fit", async () => {
    const user = userEvent.setup();
    const api = apiAnswering(
      refused(422, "WORKFLOW_RUN_INPUT_INVALID", {
        errors: [{ path: "/topic", code: "limit_exceeded", message: "…" }],
      }),
    );
    renderForm(api);

    await user.type(screen.getByLabelText("Repository"), "acme/widgets");
    await user.click(screen.getByRole("button", { name: START_COPY.start }));

    await screen.findByText(START_COPY.invalidValue);
    expect(screen.getByLabelText("topic").getAttribute("aria-invalid")).toBe(
      "true",
    );
    expect(
      screen.getByLabelText("Repository").getAttribute("aria-invalid"),
    ).toBe("false");
  });

  // #873-T57
  it("offers the run that an earlier request with the same id already made", async () => {
    const user = userEvent.setup();
    const api = apiAnswering(
      refused(409, "WORKFLOW_RUN_REQUEST_REUSED", { runId: "run-3" }),
    );
    renderForm(api);

    await user.type(screen.getByLabelText("Repository"), "acme/widgets");
    await user.click(screen.getByRole("button", { name: START_COPY.start }));

    const link = await screen.findByRole("link", {
      name: START_COPY.openThatRun,
    });
    expect(link.getAttribute("href")).toBe("/w/acme/workflows/wf-1/runs/run-3");
  });
});

describe("the input made from the values", () => {
  it("leaves out an unchecked optional box and keeps zero and false", () => {
    const fields: StartField[] = [
      { name: "a", required: false, kind: "boolean" },
      { name: "n", required: false, kind: "integer" },
      { name: "x", required: false, kind: "number" },
    ];
    expect(inputOf(fields, { n: "0", x: "1.5" })).toEqual({
      input: { n: 0, x: 1.5 },
    });
    expect(inputOf(fields, { a: true, n: "-3" })).toEqual({
      input: { a: true, n: -3 },
    });
    expect(inputOf(fields, { x: "abc" })).toEqual({
      errors: { x: START_COPY.notNumber },
    });
    expect(inputOf(fields, { n: "99999999999999999999" })).toEqual({
      errors: { n: START_COPY.notInteger },
    });
  });

  it("takes numbers in decimal notation only", () => {
    const fields: StartField[] = [
      { name: "x", required: false, kind: "number" },
    ];
    expect(inputOf(fields, { x: "-0.5" })).toEqual({ input: { x: -0.5 } });
    expect(inputOf(fields, { x: ".5" })).toEqual({ input: { x: 0.5 } });
    for (const text of ["0x10", "1e3", "Infinity", "1_000", "1,5", "0b1"])
      expect(inputOf(fields, { x: text }), text).toEqual({
        errors: { x: START_COPY.notNumber },
      });
  });
});
