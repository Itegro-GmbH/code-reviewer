// SPDX-License-Identifier: LicenseRef-Proprietary

// @vitest-environment jsdom
// The "Continue" form on the run page of the newest turn of a session (#841), tested with a stand-in for the routes: what it offers
// for an idle session, a running one, one with an instruction that waits and one whose waiting instruction was discarded; which fields
// it sends (only those the person changed); the history hint; and the sentence for each refusal.
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import { identityFor } from "../../product-identity/identities.ts";
import { ProductIdentityProvider } from "../../product-identity/context.tsx";
import type { RequestResult } from "../../ui/json-request.ts";
import { chooseOption } from "../../test-support/settings-sections.ts";
import type { ModelOptions } from "../models.ts";
import type { Continuation, ContinueApi } from "./continue-api.ts";
import { ContinueForm } from "./continue-form.tsx";
import { CONTINUE_COPY, describeDiscard } from "./continue-messages.ts";
import { describeImplementerFailure } from "./messages.ts";

const navigation = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: navigation.push }),
}));

afterEach(() => {
  cleanup();
  navigation.push.mockReset();
});

const factory = identityFor("factory");

const ok = <T,>(data: T): RequestResult<T> => ({ ok: true, data });
const refused = (
  status: number,
  code: string,
  details?: Record<string, unknown>,
): RequestResult<never> => ({
  ok: false,
  status,
  code,
  issues: [],
  ...(details === undefined ? {} : { details }),
});

const MANAGED: ModelOptions = {
  keyMode: "managed",
  entries: [
    {
      id: "entry-1",
      name: "Fast and cheap",
      description: null,
      providerLabel: "Provider A",
    },
    {
      id: "entry-2",
      name: "Careful",
      description: "Slower",
      providerLabel: "Provider B",
    },
  ],
};

function facts(overrides: Partial<Continuation> = {}): Continuation {
  return {
    sessionId: "session-1",
    branch: "implementer/abc",
    turnNumber: 1,
    sessionStatus: "idle",
    defaults: {
      model: { entryId: "entry-1" },
      costLimitCents: 200,
      environment: null,
      profile: null,
    },
    queued: null,
    discarded: null,
    historyTokens: null,
    ...overrides,
  };
}

type FakeApi = { [K in keyof ContinueApi]: Mock<ContinueApi[K]> };

function fakeApi(
  continuation: () => RequestResult<Continuation> = () => ok(facts()),
  overrides: Partial<FakeApi> = {},
): FakeApi {
  return {
    models: vi.fn<ContinueApi["models"]>(() => Promise.resolve(ok(MANAGED))),
    environments: vi.fn<ContinueApi["environments"]>(() =>
      Promise.resolve(
        ok({
          environments: [
            {
              id: "env-a",
              name: "Node",
              vcpus: 2,
              memoryGb: 2,
              sizeSupported: true,
              hasScript: true,
              networkMode: "off" as const,
            },
          ],
          maximum: 50,
        }),
      ),
    ),
    continuation: vi.fn<ContinueApi["continuation"]>(() =>
      Promise.resolve(continuation()),
    ),
    continueSession: vi.fn<ContinueApi["continueSession"]>(() =>
      Promise.resolve(
        ok({
          status: "started" as const,
          sessionId: "session-1",
          runId: "run-2",
          turnNumber: 2,
        }),
      ),
    ),
    ...overrides,
  };
}

function renderForm(api: ContinueApi) {
  return render(
    <ProductIdentityProvider product={factory}>
      <ContinueForm
        workspaceSlug="acme"
        runId="run-1"
        operatorMaximumCents={500}
        api={api}
        pollMs={20}
      />
    </ProductIdentityProvider>,
  );
}

const control = (name: string | RegExp) => screen.getByLabelText(name);

async function shown() {
  await screen.findByRole("heading", { name: CONTINUE_COPY.title });
  await waitFor(() =>
    expect(control("Environment")).not.toHaveProperty("disabled", true),
  );
}

describe("the Continue form of an idle session", () => {
  // #841-F01
  it("offers the instruction with the model, cost limit and environment of the last turn, and sends only the instruction when nothing else is changed", async () => {
    const api = fakeApi();
    const user = userEvent.setup();
    renderForm(api);
    await shown();

    expect(control("Cost limit (USD, optional)")).toHaveProperty(
      "value",
      "2.00",
    );
    expect(control("Environment").textContent).toContain(
      CONTINUE_COPY.environmentSame,
    );
    await user.type(control("Next instruction"), "Now add a test.");
    await user.click(screen.getByRole("button", { name: "Continue" }));

    await waitFor(() => expect(api.continueSession).toHaveBeenCalledOnce());
    const [sessionId, body] = api.continueSession.mock.calls[0] ?? [];
    expect(sessionId).toBe("session-1");
    expect(body).toEqual({
      instruction: "Now add a test.",
      clientRequestId: expect.any(String) as string,
    });
    await waitFor(() =>
      expect(navigation.push).toHaveBeenCalledWith("/w/acme/runs/run-2"),
    );
  });

  // #841-F20 (review of #871, N10): a navigation that fails releases the form, and the run stays linked
  it("releases the form when the navigation to the new run fails, and sends the same request id again", async () => {
    const api = fakeApi();
    navigation.push.mockImplementation(() => {
      throw new Error("navigation failed");
    });
    const user = userEvent.setup();
    renderForm(api);
    await shown();

    await user.type(control("Next instruction"), "Now add a test.");
    await user.click(screen.getByRole("button", { name: "Continue" }));

    await screen.findByRole("link", { name: CONTINUE_COPY.startedLink });
    const again = await screen.findByRole("button", { name: "Continue" });
    expect(again).toHaveProperty("disabled", false);
    await user.click(again);

    await waitFor(() => expect(api.continueSession).toHaveBeenCalledTimes(2));
    expect(api.continueSession.mock.calls[1]?.[1]).toEqual(
      api.continueSession.mock.calls[0]?.[1],
    );
  });

  // #841-F02: owner decisions 6 and 7: the model and the environment may change
  it("sends the model, the cost limit and the environment the person changed, and no other", async () => {
    const api = fakeApi();
    const user = userEvent.setup();
    renderForm(api);
    await shown();

    await user.type(control("Next instruction"), "Do it differently.");
    await chooseOption(user, control("Model"), /Careful/);
    await chooseOption(user, control("Environment"), /Node/);
    const cost = control("Cost limit (USD, optional)");
    await user.clear(cost);
    await user.type(cost, "1.50");
    await user.click(screen.getByRole("button", { name: "Continue" }));

    await waitFor(() => expect(api.continueSession).toHaveBeenCalledOnce());
    expect(api.continueSession.mock.calls[0]?.[1]).toEqual({
      instruction: "Do it differently.",
      clientRequestId: expect.any(String) as string,
      model: { entryId: "entry-2" },
      environmentId: "env-a",
      costLimitCents: 150,
    });
  });

  // #841-F03
  it("sends null for no environment and for no cost limit of its own when the person chose those", async () => {
    const api = fakeApi();
    const user = userEvent.setup();
    renderForm(api);
    await shown();

    await user.type(control("Next instruction"), "Plain.");
    await chooseOption(user, control("Environment"), /Standard/);
    await user.clear(control("Cost limit (USD, optional)"));
    await user.click(screen.getByRole("button", { name: "Continue" }));

    await waitFor(() => expect(api.continueSession).toHaveBeenCalledOnce());
    expect(api.continueSession.mock.calls[0]?.[1]).toMatchObject({
      environmentId: null,
      costLimitCents: null,
    });
  });

  // #841-F04
  it("refuses an empty instruction and a cost limit above the maximum before anything is sent", async () => {
    const api = fakeApi();
    const user = userEvent.setup();
    renderForm(api);
    await shown();

    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(api.continueSession).not.toHaveBeenCalled();
    expect(control("Next instruction").getAttribute("aria-invalid")).toBe(
      "true",
    );

    await user.type(control("Next instruction"), "x");
    const cost = control("Cost limit (USD, optional)");
    await user.clear(cost);
    await user.type(cost, "9");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(api.continueSession).not.toHaveBeenCalled();
    expect(cost.getAttribute("aria-invalid")).toBe("true");
  });

  // #841-F05
  it("shows the size of the history with the warning that the first call reads all of it, only when it is known", async () => {
    const api = fakeApi(() => ok(facts({ historyTokens: 12_345 })));
    renderForm(api);
    await shown();

    const hint = screen.getByText(/history: about/);
    expect(hint.textContent).toContain(
      "history: about 12,300 tokens; the first call reads all of it again",
    );
    expect(hint.textContent).toContain(CONTINUE_COPY.historyWarning);
  });

  // #841-F06
  it("shows no history hint when the size is not known", async () => {
    renderForm(fakeApi());
    await shown();

    expect(screen.queryByText(/history: about/)).toBeNull();
  });

  // #841-F07
  it("shows the profile of the last turn as kept, not as a choice", async () => {
    const api = fakeApi(() =>
      ok(
        facts({
          defaults: {
            model: { entryId: "entry-1" },
            costLimitCents: null,
            environment: { id: "env-a", name: "Node" },
            profile: "reviewer@3",
          },
        }),
      ),
    );
    renderForm(api);
    await shown();

    expect(screen.getByText(/reviewer@3/)).toBeTruthy();
    expect(control("Environment").textContent).toContain(
      CONTINUE_COPY.environmentSameNamed("Node"),
    );
    expect(control("Cost limit (USD, optional)")).toHaveProperty("value", "");
  });

  // #841-F08
  it("keeps the client request id of a body that failed, and gives an edited body another", async () => {
    const api = fakeApi(undefined, {
      continueSession: vi
        .fn<ContinueApi["continueSession"]>()
        .mockResolvedValue(refused(503, "IMPLEMENTER_GITHUB_UNAVAILABLE")),
    });
    const user = userEvent.setup();
    renderForm(api);
    await shown();

    await user.type(control("Next instruction"), "Try.");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(api.continueSession).toHaveBeenCalledTimes(1));
    await screen.findByText(
      describeImplementerFailure(factory, {
        code: "IMPLEMENTER_GITHUB_UNAVAILABLE",
        status: 503,
      }),
    );
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(api.continueSession).toHaveBeenCalledTimes(2));
    await user.type(control("Next instruction"), " More.");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(api.continueSession).toHaveBeenCalledTimes(3));

    const ids = api.continueSession.mock.calls.map(
      ([, body]) => body.clientRequestId,
    );
    expect(ids[0]).toBe(ids[1]);
    expect(ids[2]).not.toBe(ids[0]);
  });

  // #841-F09
  it("says IMPLEMENTER_BRANCH_GONE with the sentence for it and starts nothing", async () => {
    const api = fakeApi(undefined, {
      continueSession: vi
        .fn<ContinueApi["continueSession"]>()
        .mockResolvedValue(refused(409, "IMPLEMENTER_BRANCH_GONE")),
    });
    const user = userEvent.setup();
    renderForm(api);
    await shown();

    await user.type(control("Next instruction"), "Go.");
    await user.click(screen.getByRole("button", { name: "Continue" }));

    await screen.findByText(
      describeImplementerFailure(factory, {
        code: "IMPLEMENTER_BRANCH_GONE",
        status: 409,
      }),
    );
    expect(navigation.push).not.toHaveBeenCalled();
  });

  // #841-F10
  it("links the run a reused request id made", async () => {
    const api = fakeApi(undefined, {
      continueSession: vi
        .fn<ContinueApi["continueSession"]>()
        .mockResolvedValue(
          refused(409, "IMPLEMENTER_REQUEST_REUSED", { runId: "run-9" }),
        ),
    });
    const user = userEvent.setup();
    renderForm(api);
    await shown();

    await user.type(control("Next instruction"), "Go.");
    await user.click(screen.getByRole("button", { name: "Continue" }));

    const link = await screen.findByRole("link", {
      name: CONTINUE_COPY.openThatTask,
    });
    expect(link.getAttribute("href")).toBe("/w/acme/runs/run-9");
  });
});

describe("the Continue form of a running session", () => {
  // #841-F11 (owner decision 5)
  it("says that the instruction waits, and queues it", async () => {
    let queued: Continuation["queued"] = null;
    const api = fakeApi(() => ok(facts({ sessionStatus: "running", queued })), {
      continueSession: vi.fn<ContinueApi["continueSession"]>(() => {
        queued = { instruction: "Then this." };
        return Promise.resolve(
          ok({
            status: "queued" as const,
            sessionId: "session-1",
            runId: null,
            turnNumber: null,
          }),
        );
      }),
    });
    const user = userEvent.setup();
    renderForm(api);
    await shown();

    expect(screen.getByText(CONTINUE_COPY.runningIntro)).toBeTruthy();
    await user.type(control("Next instruction"), "Then this.");
    await user.click(screen.getByRole("button", { name: "Queue instruction" }));

    await screen.findByText(CONTINUE_COPY.queuedAccepted);
    const box = await waitFor(() => {
      const found = document.querySelector<HTMLElement>(
        '[data-slot="continue-queued"]',
      );
      if (found === null) throw new Error("not shown yet");
      return found;
    });
    expect(within(box).getByText("Then this.")).toBeTruthy();
    // Not a turn: the page does not move.
    expect(navigation.push).not.toHaveBeenCalled();
    // And nothing more can be queued while one waits.
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Queue instruction" }),
      ).toHaveProperty("disabled", true),
    );
    // The fieldset is disabled, so the textarea is, too.
    expect(control("Next instruction").matches(":disabled")).toBe(true);
  });

  // #841-F12
  it("shows the instruction that waits, disabled, when the page is opened with one queued", async () => {
    const api = fakeApi(() =>
      ok(
        facts({
          sessionStatus: "running",
          queued: { instruction: "Already waiting." },
        }),
      ),
    );
    renderForm(api);
    await shown();

    expect(screen.getByText("Already waiting.")).toBeTruthy();
    expect(screen.getByText(CONTINUE_COPY.queuedNote)).toBeTruthy();
    // The fieldset is disabled, so the textarea is, too.
    expect(control("Next instruction").matches(":disabled")).toBe(true);
    expect(
      screen.getByRole("button", { name: "Queue instruction" }),
    ).toHaveProperty("disabled", true);
  });

  // #841-F13
  it("asks again while a turn runs and offers Continue once the session is idle", async () => {
    let status: Continuation["sessionStatus"] = "running";
    const api = fakeApi(() => ok(facts({ sessionStatus: status })));
    renderForm(api);
    await shown();
    expect(
      screen.getByRole("button", { name: "Queue instruction" }),
    ).toBeTruthy();

    status = "idle";

    await screen.findByRole("button", { name: "Continue" });
    const calls = api.continuation.mock.calls.length;
    // An idle session does not change by itself: no more asking.
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(api.continuation.mock.calls.length).toBeLessThanOrEqual(calls + 1);
  });
});

describe("the Continue form after an instruction was discarded", () => {
  // #841-F14
  it("says why it did not start and shows the text, so it is not lost", async () => {
    const api = fakeApi(() =>
      ok(
        facts({
          discarded: { reason: "branch_gone", instruction: "Lost words." },
        }),
      ),
    );
    renderForm(api);
    await shown();

    const box = document.querySelector<HTMLElement>(
      '[data-slot="continue-discarded"]',
    );
    expect(box?.textContent).toContain(describeDiscard("branch_gone"));
    expect(box?.textContent).toContain("Lost words.");
    // The form is usable again: the session is idle.
    expect(control("Next instruction").matches(":disabled")).toBe(false);
  });

  // #841-F15
  it("has a sentence for every reason word, and a general one for a word it does not know", () => {
    for (const reason of [
      "branch_gone",
      "repository_unavailable",
      "write_not_granted",
      "model_not_allowed",
      "cost_limit_exceeded",
      "environment_unavailable",
    ])
      expect(describeDiscard(reason)).not.toBe(describeDiscard("unknown"));
  });
});

describe("the Continue form when there is nothing to continue", () => {
  // #841-F16
  it("shows nothing for a run that is not the newest turn of a session", async () => {
    const api = fakeApi(() => refused(404, "IMPLEMENTER_SESSION_NOT_FOUND"));
    const { container } = renderForm(api);

    await waitFor(() => expect(api.continuation).toHaveBeenCalled());
    await waitFor(() => expect(container.textContent).toBe(""));
  });

  // #841-F17
  it("says the options could not be loaded when the first read fails, and tries again on request", async () => {
    let fail = true;
    const api = fakeApi(() =>
      fail ? refused(503, "UNEXPECTED_RESPONSE") : ok(facts()),
    );
    const user = userEvent.setup();
    renderForm(api);

    await screen.findByText(CONTINUE_COPY.loadFailed);
    fail = false;
    await user.click(screen.getByRole("button", { name: "Try again" }));

    await screen.findByRole("button", { name: "Continue" });
  });
});
