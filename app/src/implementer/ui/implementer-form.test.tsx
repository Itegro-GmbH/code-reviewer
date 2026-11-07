// SPDX-License-Identifier: LicenseRef-Proprietary

// @vitest-environment jsdom
// The form that sends a task to the Implementer (#756), tested with a stand-in for the four routes of #755: the repositories
// (one without write permission is listed but cannot be chosen), the branches of the chosen repository with the default branch
// preselected, the name of the new branch, the model picker for both key modes, and the submit: once per form load, with the
// sentence of every refusal.
import {
  act,
  cleanup,
  fireEvent,
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
import type { NativeModelView } from "../../native-providers/catalog.ts";
import { chooseOption } from "../../test-support/settings-sections.ts";
import type { BranchChoices, RepositoryChoice } from "../service.ts";
import type { ModelOptions } from "../models.ts";
import { INSTRUCTION_MAX_LENGTH } from "../start-input.ts";
import type {
  ImplementerApi,
  ProfileChoice,
  ProfileDetail,
  StartTaskRequest,
} from "./api.ts";
import { ImplementerForm } from "./implementer-form.tsx";
import {
  describeBranchIssue,
  describeImplementerFailure,
  describeModelRefusal,
  describeUnwritable,
  describeUnwritableNote,
} from "./messages.ts";

const navigation = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: navigation.push }),
}));

afterEach(cleanup);

const factory = identityFor("factory");

const ok = <T,>(data: T): RequestResult<T> => ({ ok: true, data });
const refused = (
  status: number,
  code: string,
  extra: {
    issues?: Array<{ field: string; code: string }>;
    details?: Record<string, unknown>;
  } = {},
): RequestResult<never> => ({
  ok: false,
  status,
  code,
  issues: extra.issues ?? [],
  ...(extra.details === undefined ? {} : { details: extra.details }),
});

const REPOSITORIES: RepositoryChoice[] = [
  { id: "r1", fullName: "acme/widgets", writeGranted: true, unwritable: null },
  {
    id: "r2",
    fullName: "acme/legacy",
    writeGranted: false,
    unwritable: "write_not_granted",
  },
  { id: "r3", fullName: "acme/gadgets", writeGranted: true, unwritable: null },
];
const BRANCHES: Record<string, BranchChoices> = {
  r1: {
    defaultBranch: "main",
    branches: ["main", "develop"],
    truncated: false,
  },
  r3: { defaultBranch: "trunk", branches: ["trunk", "next"], truncated: false },
};

const model = (id: string, name: string, extra = {}): NativeModelView => ({
  id,
  name,
  contextTokens: 128_000,
  outputTokens: 8_000,
  reasoning: false,
  deprecated: false,
  alpha: false,
  price: null,
  ...extra,
});
const OWN: ModelOptions = {
  keyMode: "own",
  providers: [
    {
      id: "deepseek",
      label: "DeepSeek",
      models: [
        model("deepseek-chat", "DeepSeek Chat"),
        model("deepseek-old", "DeepSeek Old", { deprecated: true }),
      ],
    },
    {
      id: "moonshot",
      label: "Moonshot",
      models: [model("kimi-k2", "Kimi K2")],
    },
  ],
};
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

/** The calls as mocks, so a test reads what was sent. */
type FakeApi = { [K in keyof ImplementerApi]: Mock<ImplementerApi[K]> };

function fakeApi(overrides: Partial<FakeApi> = {}): FakeApi {
  return {
    repositories: vi.fn<ImplementerApi["repositories"]>(() =>
      Promise.resolve(ok({ repositories: REPOSITORIES })),
    ),
    branches: vi.fn<ImplementerApi["branches"]>((id) => {
      const branches = BRANCHES[id];
      return Promise.resolve(
        branches === undefined
          ? refused(404, "IMPLEMENTER_REPOSITORY_NOT_FOUND")
          : ok(branches),
      );
    }),
    models: vi.fn<ImplementerApi["models"]>(() => Promise.resolve(ok(OWN))),
    environments: vi.fn<ImplementerApi["environments"]>(() =>
      Promise.resolve(ok({ environments: [], maximum: 50 })),
    ),
    profiles: vi.fn<ImplementerApi["profiles"]>(() =>
      Promise.resolve(ok({ profiles: [] })),
    ),
    profile: vi.fn<ImplementerApi["profile"]>(() =>
      Promise.resolve(refused(404, "PROFILE_NOT_FOUND")),
    ),
    startTask: vi.fn<ImplementerApi["startTask"]>(() =>
      Promise.resolve(ok({ runId: "run-1", sessionId: "session-1" })),
    ),
    ...overrides,
  };
}

function renderForm(
  api: ImplementerApi,
  props: { operatorMaximumCents?: number } = {},
) {
  return render(
    <ProductIdentityProvider product={factory}>
      <ImplementerForm
        workspaceSlug="acme"
        operatorMaximumCents={props.operatorMaximumCents ?? 500}
        api={api}
      />
    </ProductIdentityProvider>,
  );
}

const control = (name: string | RegExp) => screen.getByLabelText(name);

/** The repositories and the models have arrived: the two controls that wait for them are usable. */
async function ready() {
  await waitFor(() => {
    expect(control("Repository")).not.toHaveProperty("disabled", true);
    expect(control("Model")).not.toHaveProperty("disabled", true);
  });
}

async function chooseRepository(
  user: ReturnType<typeof userEvent.setup>,
  name: string,
) {
  await ready();
  await chooseOption(user, control("Repository"), name);
  await waitFor(() =>
    expect(control("Base branch")).not.toHaveProperty("disabled", true),
  );
}

function setTask(text: string) {
  fireEvent.change(control("Task"), { target: { value: text } });
}

/** A form that can be sent: the repository, the task and the model chosen. */
async function fillIn(user: ReturnType<typeof userEvent.setup>) {
  await chooseRepository(user, "acme/widgets");
  setTask("Add a health endpoint");
  await chooseOption(user, control("Provider"), "DeepSeek");
  await chooseOption(user, control("Model"), "DeepSeek Chat");
}

const startButton = () => screen.getByRole("button", { name: /^Start task/ });

describe("the repository select", () => {
  // #756-T02
  it("lists the repositories of the workspace, and one without write access is disabled with the reason", async () => {
    const user = userEvent.setup();
    renderForm(fakeApi());
    await ready();

    await user.click(control("Repository"));
    const options = await screen.findAllByRole("option");
    expect(options.map((option) => option.textContent)).toEqual([
      "acme/widgets",
      "acme/legacy (approve the new GitHub permission)",
      "acme/gadgets",
    ]);
    const legacy = screen.getByRole("option", { name: /acme\/legacy/ });
    expect(legacy.getAttribute("aria-disabled")).toBe("true");
    expect(
      screen
        .getByRole("option", { name: "acme/widgets" })
        .getAttribute("aria-disabled"),
    ).toBeNull();
  });

  // #756-T02
  it("cannot choose the repository without write access", async () => {
    const user = userEvent.setup();
    const api = fakeApi();
    renderForm(api);
    await ready();

    await user.click(control("Repository"));
    await user.click(
      await screen.findByRole("option", { name: /acme\/legacy/ }),
    );

    expect(api.branches).not.toHaveBeenCalled();
    expect(control("Base branch")).toHaveProperty("disabled", true);
  });

  // #756-T02
  it("says plainly what to do when no repository has write access, and sends nothing", async () => {
    const api = fakeApi({
      repositories: vi.fn(() =>
        Promise.resolve(
          ok({
            repositories: [
              {
                id: "r2",
                fullName: "acme/legacy",
                writeGranted: false,
                unwritable: "write_not_granted",
              },
            ],
          }),
        ),
      ),
    });
    renderForm(api);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(
      describeImplementerFailure(factory, {
        code: "IMPLEMENTER_WRITE_NOT_GRANTED",
      }),
    );
    expect(alert.textContent).toMatch(/approve/i);
    expect(startButton()).toHaveProperty("disabled", true);
  });

  // #756-T02
  it("shows the empty state with a link to Connections when no repository is linked", async () => {
    renderForm(
      fakeApi({
        repositories: vi.fn(() => Promise.resolve(ok({ repositories: [] }))),
      }),
    );

    const link = await screen.findByRole("link", { name: "Connections" });
    expect(link.getAttribute("href")).toBe("/w/acme/settings/integrations");
    expect(screen.getByText(/No repository is linked yet/)).toBeTruthy();
    expect(screen.queryByLabelText("Repository")).toBeNull();
  });

  // #756-T02
  it("shows a failed load as a sentence with a way to try again", async () => {
    const user = userEvent.setup();
    const repositories = vi
      .fn()
      .mockResolvedValueOnce(refused(503, "IMPLEMENTER_GITHUB_UNAVAILABLE"))
      .mockResolvedValue(ok({ repositories: REPOSITORIES }));
    renderForm(fakeApi({ repositories }));

    expect((await screen.findByRole("alert")).textContent).toBe(
      describeImplementerFailure(factory, {
        code: "IMPLEMENTER_GITHUB_UNAVAILABLE",
      }),
    );
    await user.click(screen.getByRole("button", { name: "Try again" }));
    await ready();
    expect(repositories).toHaveBeenCalledTimes(2);
  });
});

describe("the base branch select", () => {
  // #756-T03
  it("loads the branches of the chosen repository and preselects the default branch, marked as the default", async () => {
    const user = userEvent.setup();
    const api = fakeApi();
    renderForm(api);

    expect(control("Base branch")).toHaveProperty("disabled", true);
    await chooseRepository(user, "acme/widgets");

    expect(api.branches).toHaveBeenCalledWith("r1");
    expect(control("Base branch").textContent).toContain("main");
    await user.click(control("Base branch"));
    expect(
      (await screen.findAllByRole("option")).map(
        (option) => option.textContent,
      ),
    ).toEqual(["main (default)", "develop"]);
  });

  // #756-T03
  it("keeps the default preselected after switching to another repository and back, whatever was chosen before", async () => {
    const user = userEvent.setup();
    const api = fakeApi();
    renderForm(api);
    await chooseRepository(user, "acme/widgets");

    await chooseOption(user, control("Base branch"), "develop");
    expect(control("Base branch").textContent).toContain("develop");

    await chooseOption(user, control("Repository"), "acme/gadgets");
    await waitFor(() =>
      expect(control("Base branch").textContent).toContain("trunk"),
    );

    await chooseOption(user, control("Repository"), "acme/widgets");
    await waitFor(() =>
      expect(control("Base branch").textContent).toContain("main"),
    );
    expect(control("Base branch").textContent).not.toContain("develop");
  });

  // #756-T03
  it("says when the list was cut short, and shows a failed load with a way to try again", async () => {
    const user = userEvent.setup();
    const branches = vi
      .fn()
      .mockResolvedValueOnce(refused(503, "IMPLEMENTER_GITHUB_UNAVAILABLE"))
      .mockResolvedValue(
        ok({ defaultBranch: "main", branches: ["main"], truncated: true }),
      );
    renderForm(fakeApi({ branches }));
    await ready();
    await chooseOption(user, control("Repository"), "acme/widgets");

    expect(
      (await screen.findByText(/GitHub could not be reached/)).textContent,
    ).toBe(
      describeImplementerFailure(factory, {
        code: "IMPLEMENTER_GITHUB_UNAVAILABLE",
      }),
    );
    expect(startButton()).toHaveProperty("disabled", true);
    await user.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() =>
      expect(control("Base branch").textContent).toContain("main"),
    );
    expect(screen.getByText(/more branches than are listed/i)).toBeTruthy();
  });

  // #756-T03
  it("ignores the branches of a repository that was left before they arrived", async () => {
    const user = userEvent.setup();
    let release: (value: RequestResult<BranchChoices>) => void = () => {};
    const slow = new Promise<RequestResult<BranchChoices>>((resolve) => {
      release = resolve;
    });
    const branches = vi.fn((id: string) =>
      id === "r1" ? slow : Promise.resolve(ok(BRANCHES.r3 as BranchChoices)),
    );
    renderForm(fakeApi({ branches }));
    await ready();
    await chooseOption(user, control("Repository"), "acme/widgets");
    await chooseOption(user, control("Repository"), "acme/gadgets");
    await waitFor(() =>
      expect(control("Base branch").textContent).toContain("trunk"),
    );

    release(ok(BRANCHES.r1 as BranchChoices));
    await Promise.resolve();
    expect(control("Base branch").textContent).toContain("trunk");
  });
});

describe("the name of the new branch", () => {
  // #756-T04
  it("is prefilled with implementer/ and six random lowercase letters or digits, and can be edited", async () => {
    const user = userEvent.setup();
    renderForm(fakeApi());
    await ready();

    const field = control("New branch name") as HTMLInputElement;
    expect(field.value).toMatch(/^implementer\/[a-z0-9]{6}$/);
    await user.clear(field);
    await user.type(field, "feature/health");
    expect(field.value).toBe("feature/health");
  });

  // #756-T04
  it.each([
    ["a..b", "double_dot"],
    ["-x", "leading_dash"],
    ["a b", "forbidden_character"],
    ["fix.lock", "lock_suffix"],
    ["HEAD", "reserved_name"],
    ["a//b", "slash_placement"],
    ["a@{b", "reflog_syntax"],
    ["topic.", "trailing_dot"],
    ["x/.hidden", "component_leading_dot"],
    ["", "empty"],
  ] as const)(
    "refuses %j with the sentence of the server code %s, before anything is sent",
    async (name, code) => {
      const user = userEvent.setup();
      const api = fakeApi();
      renderForm(api);
      await fillIn(user);

      fireEvent.change(control("New branch name"), { target: { value: name } });
      await user.click(startButton());

      const expected = describeBranchIssue(code);
      const field = control("New branch name");
      expect(field.getAttribute("aria-invalid")).toBe("true");
      expect(
        document.getElementById(field.getAttribute("aria-describedby") ?? "")
          ?.textContent,
      ).toBe(expected);
      expect(api.startTask).not.toHaveBeenCalled();
    },
  );

  // #756-T04
  it("refuses the name of the base branch, and checks again when the base branch changes", async () => {
    const user = userEvent.setup();
    const api = fakeApi();
    renderForm(api);
    await fillIn(user);

    fireEvent.change(control("New branch name"), {
      target: { value: "develop" },
    });
    await chooseOption(user, control("Base branch"), "develop");
    await user.click(startButton());

    expect(
      document.getElementById(
        control("New branch name").getAttribute("aria-describedby") ?? "",
      )?.textContent,
    ).toBe(describeBranchIssue("same_as_base"));
    expect(api.startTask).not.toHaveBeenCalled();
  });

  // #756-T04
  it("takes a name the server accepts without a word", async () => {
    const user = userEvent.setup();
    renderForm(fakeApi());
    await fillIn(user);

    fireEvent.change(control("New branch name"), {
      target: { value: "feature/ünïcode-1.2" },
    });

    expect(control("New branch name").getAttribute("aria-invalid")).not.toBe(
      "true",
    );
  });
});

describe("the model picker", () => {
  // #756-T05
  it("on the workspace's own key lists the providers with a key, then the models of the chosen provider, and marks a deprecated one", async () => {
    const user = userEvent.setup();
    const api = fakeApi();
    renderForm(api);
    await ready();

    await user.click(control("Provider"));
    expect(
      (await screen.findAllByRole("option")).map(
        (option) => option.textContent,
      ),
    ).toEqual(["DeepSeek", "Moonshot"]);
    await user.click(screen.getByRole("option", { name: "DeepSeek" }));

    await user.click(control("Model"));
    expect(
      (await screen.findAllByRole("option")).map(
        (option) => option.textContent,
      ),
    ).toEqual(["DeepSeek Chat", "DeepSeek Old (deprecated)"]);
    await user.click(screen.getByRole("option", { name: "DeepSeek Chat" }));

    await chooseOption(user, control("Provider"), "Moonshot");
    // A model of the other provider is not kept.
    expect(control("Model").textContent).not.toContain("DeepSeek");
    await user.click(control("Model"));
    expect(
      (await screen.findAllByRole("option")).map(
        (option) => option.textContent,
      ),
    ).toEqual(["Kimi K2"]);
  });

  // #756-T05
  it("sends { provider, model } on the workspace's own key", async () => {
    const user = userEvent.setup();
    const api = fakeApi();
    renderForm(api);
    await fillIn(user);

    await user.click(startButton());

    await waitFor(() => expect(api.startTask).toHaveBeenCalledTimes(1));
    expect(api.startTask.mock.calls[0]?.[0].model).toEqual({
      provider: "deepseek",
      model: "deepseek-chat",
    });
  });

  // #756-T05
  it("on the operator's key lists the released entries by the names the operator gave them, never a provider's model id, and sends { entryId }", async () => {
    const user = userEvent.setup();
    const api = fakeApi({
      models: vi.fn(() => Promise.resolve(ok(MANAGED))),
    });
    renderForm(api);
    await chooseRepository(user, "acme/widgets");
    setTask("Add a health endpoint");

    expect(screen.queryByLabelText("Provider")).toBeNull();
    await user.click(control("Model"));
    expect(
      (await screen.findAllByRole("option")).map(
        (option) => option.textContent,
      ),
    ).toEqual(["Fast and cheap (Provider A)", "Careful (Provider B)"]);
    await user.click(screen.getByRole("option", { name: /^Careful/ }));
    await user.click(startButton());

    await waitFor(() => expect(api.startTask).toHaveBeenCalledTimes(1));
    expect(api.startTask.mock.calls[0]?.[0].model).toEqual({
      entryId: "entry-2",
    });
  });

  // #756-T05
  it.each([
    [
      "own key, no provider with a key",
      { keyMode: "own", providers: [] } as ModelOptions,
    ],
    [
      "operator's key, no entry released",
      { keyMode: "managed", entries: [] } as ModelOptions,
    ],
  ])(
    "shows the empty state with the link to the LLM access settings when nothing is configured (%s)",
    async (_name, options) => {
      const api = fakeApi({
        models: vi.fn(() => Promise.resolve(ok(options))),
      });
      renderForm(api);

      const link = await screen.findByRole("link", { name: "LLM access" });
      expect(link.getAttribute("href")).toBe("/w/acme/settings/llm");
      expect(screen.getByText(/No model is available yet/)).toBeTruthy();
      expect(screen.queryByLabelText("Model")).toBeNull();
      expect(startButton()).toHaveProperty("disabled", true);
    },
  );

  // #756-T05
  it("says so when the key setup cannot be read, and when the models cannot be loaded", async () => {
    const { unmount } = renderForm(
      fakeApi({
        models: vi.fn(() =>
          Promise.resolve(ok({ keyMode: "unreadable" } as ModelOptions)),
        ),
      }),
    );
    expect(
      (await screen.findAllByRole("alert")).map((a) => a.textContent),
    ).toContain(describeModelRefusal("key_mode_unreadable"));
    unmount();

    renderForm(
      fakeApi({
        models: vi.fn(() =>
          Promise.resolve(refused(null as never, "NETWORK_ERROR")),
        ),
      }),
    );
    expect(
      (await screen.findAllByRole("alert")).map((a) => a.textContent),
    ).toContain(describeImplementerFailure(factory, { code: "NETWORK_ERROR" }));
  });
});

describe("sending the task", () => {
  // #756-T06
  it("sends the whole choice with a client request id, disables the button while pending, and goes to the run on 201", async () => {
    const user = userEvent.setup();
    let finish: (
      value: RequestResult<{ runId: string; sessionId: string }>,
    ) => void = () => {};
    const pending = new Promise<
      RequestResult<{ runId: string; sessionId: string }>
    >((resolve) => {
      finish = resolve;
    });
    const api = fakeApi({ startTask: vi.fn(() => pending) });
    renderForm(api);
    await fillIn(user);
    await chooseOption(user, control("Base branch"), "develop");
    fireEvent.change(control("New branch name"), {
      target: { value: "feature/health" },
    });
    fireEvent.change(control(/^Cost limit/), { target: { value: "2.50" } });

    await user.click(startButton());

    expect(api.startTask).toHaveBeenCalledTimes(1);
    expect(api.startTask.mock.calls[0]?.[0]).toEqual({
      repositoryId: "r1",
      baseBranch: "develop",
      branch: "feature/health",
      instruction: "Add a health endpoint",
      model: { provider: "deepseek", model: "deepseek-chat" },
      costLimitCents: 250,
      clientRequestId: expect.stringMatching(/^[\x21-\x7e]{8,200}$/) as string,
    });
    const button = screen.getByRole("button", { name: /Start task|Sending/ });
    expect(button).toHaveProperty("disabled", true);
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(navigation.push).not.toHaveBeenCalled();

    finish(ok({ runId: "run 1/x", sessionId: "session-1" }));
    await waitFor(() =>
      expect(navigation.push).toHaveBeenCalledWith("/w/acme/runs/run%201%2Fx"),
    );
  });

  // #756-T06
  it("goes to the same run when the answer is 200: the request was accepted before", async () => {
    const user = userEvent.setup();
    const api = fakeApi();
    renderForm(api);
    await fillIn(user);

    await user.click(startButton());

    await waitFor(() =>
      expect(navigation.push).toHaveBeenCalledWith("/w/acme/runs/run-1"),
    );
  });

  // #756-T06
  it("does not send twice when Enter and the button are used again while the first is pending", async () => {
    const user = userEvent.setup();
    const api = fakeApi({
      startTask: vi.fn(() => new Promise<never>(() => {})),
    });
    renderForm(api);
    await fillIn(user);

    const field = control("New branch name");
    await user.click(field);
    await user.keyboard("{Enter}");
    await user.keyboard("{Enter}");
    fireEvent.submit(field.closest("form") as HTMLFormElement);
    await user.click(screen.getByRole("button", { name: /Sending the task/ }));

    expect(api.startTask).toHaveBeenCalledTimes(1);
  });

  // #756-T06
  it("sends the same client request id again when the person tries again after a failure", async () => {
    const user = userEvent.setup();
    const startTask = vi
      .fn()
      .mockResolvedValueOnce(refused(503, "IMPLEMENTER_GITHUB_UNAVAILABLE"))
      .mockResolvedValueOnce(refused(null as never, "NETWORK_ERROR"))
      .mockResolvedValue(ok({ runId: "run-1", sessionId: "session-1" }));
    renderForm(fakeApi({ startTask }));
    await fillIn(user);

    await user.click(startButton());
    expect(
      (await screen.findAllByRole("alert")).map((alert) => alert.textContent),
    ).toContain(
      describeImplementerFailure(factory, {
        code: "IMPLEMENTER_GITHUB_UNAVAILABLE",
      }),
    );
    expect(startButton()).toHaveProperty("disabled", false);
    await user.click(startButton());
    await waitFor(() => expect(startTask).toHaveBeenCalledTimes(2));
    await user.click(await waitFor(() => startButton()));
    await waitFor(() => expect(startTask).toHaveBeenCalledTimes(3));

    const ids = startTask.mock.calls.map(
      (call) => (call[0] as StartTaskRequest).clientRequestId,
    );
    expect(new Set(ids).size).toBe(1);
  });

  // #756-T06
  it("uses another client request id for another load of the form", async () => {
    const first = fakeApi();
    const second = fakeApi();
    const user = userEvent.setup();
    const { unmount } = renderForm(first);
    await fillIn(user);
    await user.click(startButton());
    await waitFor(() => expect(first.startTask).toHaveBeenCalled());
    unmount();

    renderForm(second);
    await fillIn(user);
    await user.click(startButton());
    await waitFor(() => expect(second.startTask).toHaveBeenCalled());

    expect(first.startTask.mock.calls[0]?.[0].clientRequestId).not.toBe(
      second.startTask.mock.calls[0]?.[0].clientRequestId,
    );
  });

  // #756-T06
  it("marks the branch field on 409 and says a new branch name is needed, and keeps everything else as it was", async () => {
    const user = userEvent.setup();
    const api = fakeApi({
      startTask: vi.fn(() =>
        Promise.resolve(refused(409, "IMPLEMENTER_BRANCH_EXISTS")),
      ),
    });
    renderForm(api);
    await fillIn(user);

    await user.click(startButton());

    const field = await waitFor(() => {
      const found = control("New branch name");
      expect(found.getAttribute("aria-invalid")).toBe("true");
      return found;
    });
    const message = document.getElementById(
      field.getAttribute("aria-describedby") ?? "",
    )?.textContent;
    expect(message).toBe(
      describeImplementerFailure(factory, {
        code: "IMPLEMENTER_BRANCH_EXISTS",
      }),
    );
    expect(message).toMatch(/new branch name/i);
    expect(control("Task")).toHaveProperty("value", "Add a health endpoint");
    expect(navigation.push).not.toHaveBeenCalled();
    // Typing in the field takes the mark away.
    fireEvent.change(field, { target: { value: "implementer/other1" } });
    expect(control("New branch name").getAttribute("aria-invalid")).not.toBe(
      "true",
    );
  });

  // #756-T06
  it("shows the retry text on 503 and sends nothing else", async () => {
    const user = userEvent.setup();
    const api = fakeApi({
      startTask: vi.fn(() =>
        Promise.resolve(refused(503, "IMPLEMENTER_GITHUB_UNAVAILABLE")),
      ),
    });
    renderForm(api);
    await fillIn(user);

    await user.click(startButton());

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/try again/i);
    expect(alert.textContent).toBe(
      describeImplementerFailure(factory, {
        code: "IMPLEMENTER_GITHUB_UNAVAILABLE",
      }),
    );
    expect(navigation.push).not.toHaveBeenCalled();
  });

  // #756-T06
  it.each([["IMPLEMENTER_BRANCH_CONFLICT", "New branch name"]])(
    "marks the field a %s refusal belongs to",
    async (code, label) => {
      const user = userEvent.setup();
      renderForm(
        fakeApi({
          startTask: vi.fn(() => Promise.resolve(refused(409, code))),
        }),
      );
      await fillIn(user);

      await user.click(startButton());

      await waitFor(() =>
        expect(control(label).getAttribute("aria-invalid")).toBe("true"),
      );
      expect(
        document.getElementById(
          control(label).getAttribute("aria-describedby") ?? "",
        )?.textContent,
      ).toBe(describeImplementerFailure(factory, { code }));
    },
  );

  // #756-T06
  it("shows the write permission refusal as a sentence on the form, with what to do", async () => {
    const user = userEvent.setup();
    renderForm(
      fakeApi({
        startTask: vi.fn(() =>
          Promise.resolve(refused(409, "IMPLEMENTER_WRITE_NOT_GRANTED")),
        ),
      }),
    );
    await fillIn(user);

    await user.click(startButton());

    expect((await screen.findByRole("alert")).textContent).toBe(
      describeImplementerFailure(factory, {
        code: "IMPLEMENTER_WRITE_NOT_GRANTED",
      }),
    );
  });

  // #756-T06
  it("puts the issues of a refused body on the fields they name, and the model refusal on the model", async () => {
    const user = userEvent.setup();
    const startTask = vi
      .fn()
      .mockResolvedValueOnce(
        refused(400, "IMPLEMENTER_REQUEST_INVALID", {
          issues: [
            { field: "instruction", code: "invalid" },
            { field: "branch", code: "double_dot" },
          ],
        }),
      )
      .mockResolvedValueOnce(
        refused(422, "IMPLEMENTER_MODEL_NOT_ALLOWED", {
          details: { reason: "no_key" },
        }),
      );
    renderForm(fakeApi({ startTask }));
    await fillIn(user);

    await user.click(startButton());
    await waitFor(() =>
      expect(control("Task").getAttribute("aria-invalid")).toBe("true"),
    );
    expect(control("New branch name").getAttribute("aria-invalid")).toBe(
      "true",
    );

    await user.click(startButton());
    await waitFor(() =>
      expect(control("Model").getAttribute("aria-invalid")).toBe("true"),
    );
    expect(
      document.getElementById(
        control("Model").getAttribute("aria-describedby") ?? "",
      )?.textContent,
    ).toBe(describeModelRefusal("no_key"));
  });
});

describe("the task field", () => {
  // #756-T04
  it("counts the characters against the limit and refuses a task above it without sending", async () => {
    const user = userEvent.setup();
    const api = fakeApi();
    renderForm(api);
    await fillIn(user);

    expect(screen.getByText(/^\d[\d,]* \/ 20,000$/).textContent).toBe(
      "21 / 20,000",
    );
    setTask("x".repeat(INSTRUCTION_MAX_LENGTH));
    expect(screen.getByText("20,000 / 20,000")).toBeTruthy();
    expect(control("Task").getAttribute("aria-invalid")).not.toBe("true");

    setTask("x".repeat(INSTRUCTION_MAX_LENGTH + 1));
    await user.click(startButton());

    expect(control("Task").getAttribute("aria-invalid")).toBe("true");
    expect(
      document.getElementById(
        control("Task").getAttribute("aria-describedby") ?? "",
      )?.textContent,
    ).toMatch(/20,000/);
    expect(api.startTask).not.toHaveBeenCalled();
  });

  // #756-T07
  it("asks for what is missing in the order of the form, without sending", async () => {
    const user = userEvent.setup();
    const api = fakeApi();
    renderForm(api);
    await ready();

    await user.click(startButton());

    for (const label of ["Repository", "Task", "Model"] as const)
      expect(control(label).getAttribute("aria-invalid"), label).toBe("true");
    expect(api.startTask).not.toHaveBeenCalled();
  });
});

describe("the cost limit field", () => {
  // #756-T10
  it("shows the maximum as its placeholder and sends nothing when it is empty", async () => {
    const user = userEvent.setup();
    const api = fakeApi();
    renderForm(api, { operatorMaximumCents: 750 });
    await fillIn(user);

    expect(control(/^Cost limit/).getAttribute("placeholder")).toBe(
      "Max $7.50",
    );
    await user.click(startButton());

    await waitFor(() => expect(api.startTask).toHaveBeenCalledTimes(1));
    expect(api.startTask.mock.calls[0]?.[0]).not.toHaveProperty(
      "costLimitCents",
    );
  });

  // #756-T10
  it("rejects a value above the operator maximum before sending, and names the maximum", async () => {
    const user = userEvent.setup();
    const api = fakeApi();
    renderForm(api, { operatorMaximumCents: 500 });
    await fillIn(user);

    fireEvent.change(control(/^Cost limit/), { target: { value: "5.01" } });
    await user.click(startButton());

    const field = control(/^Cost limit/);
    expect(field.getAttribute("aria-invalid")).toBe("true");
    expect(
      document.getElementById(field.getAttribute("aria-describedby") ?? "")
        ?.textContent,
    ).toBe(
      describeImplementerFailure(factory, {
        code: "EXCEEDS_OPERATOR_MAXIMUM",
        maximumCents: 500,
      }),
    );
    expect(api.startTask).not.toHaveBeenCalled();

    fireEvent.change(field, { target: { value: "5" } });
    await user.click(startButton());
    await waitFor(() => expect(api.startTask).toHaveBeenCalledTimes(1));
  });

  // #756-T10
  it("rejects text that is no amount", async () => {
    const user = userEvent.setup();
    const api = fakeApi();
    renderForm(api);
    await fillIn(user);

    fireEvent.change(control(/^Cost limit/), { target: { value: "lots" } });
    await user.click(startButton());

    expect(control(/^Cost limit/).getAttribute("aria-invalid")).toBe("true");
    expect(api.startTask).not.toHaveBeenCalled();
  });

  // #756-T10
  it("shows the maximum the server names when it refuses a limit the form let through", async () => {
    const user = userEvent.setup();
    renderForm(
      fakeApi({
        startTask: vi.fn(() =>
          Promise.resolve(
            refused(422, "EXCEEDS_OPERATOR_MAXIMUM", {
              details: { maximumCents: 300 },
            }),
          ),
        ),
      }),
    );
    await fillIn(user);
    fireEvent.change(control(/^Cost limit/), { target: { value: "4" } });

    await user.click(startButton());

    await waitFor(() =>
      expect(control(/^Cost limit/).getAttribute("aria-invalid")).toBe("true"),
    );
    expect(
      document.getElementById(
        control(/^Cost limit/).getAttribute("aria-describedby") ?? "",
      )?.textContent,
    ).toContain("$3.00");
  });
});

describe("a retry after a lost answer (review of #793)", () => {
  // #756-T06
  it("sends a new client request id when the body was edited, and keeps it for an unchanged retry", async () => {
    const user = userEvent.setup();
    const startTask = vi
      .fn()
      .mockResolvedValueOnce(refused(null as never, "NETWORK_ERROR"))
      .mockResolvedValueOnce(refused(null as never, "NETWORK_ERROR"))
      .mockResolvedValueOnce(refused(null as never, "NETWORK_ERROR"))
      .mockResolvedValue(ok({ runId: "run-2", sessionId: "session-2" }));
    renderForm(fakeApi({ startTask }));
    await fillIn(user);

    await user.click(startButton());
    await waitFor(() => expect(startTask).toHaveBeenCalledTimes(1));
    setTask("Add a health endpoint and a readiness endpoint");
    await waitFor(() =>
      expect(startButton()).toHaveProperty("disabled", false),
    );
    await user.click(startButton());
    await waitFor(() => expect(startTask).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(startButton()).toHaveProperty("disabled", false),
    );
    await user.click(startButton());
    await waitFor(() => expect(startTask).toHaveBeenCalledTimes(3));

    const ids = startTask.mock.calls.map(
      (call) => (call[0] as StartTaskRequest).clientRequestId,
    );
    expect(ids[1]).not.toBe(ids[0]);
    expect(ids[2]).toBe(ids[1]);
  });

  // #756-T06
  it.each([
    [
      "the branch",
      () =>
        fireEvent.change(control("New branch name"), {
          target: { value: "feature/other" },
        }),
    ],
    [
      "the cost limit",
      () =>
        fireEvent.change(control(/^Cost limit/), { target: { value: "3" } }),
    ],
  ])(
    "sends a new client request id when %s was edited",
    async (_name, edit) => {
      const user = userEvent.setup();
      const startTask = vi
        .fn()
        .mockResolvedValueOnce(refused(null as never, "NETWORK_ERROR"))
        .mockResolvedValue(ok({ runId: "run-2", sessionId: "session-2" }));
      renderForm(fakeApi({ startTask }));
      await fillIn(user);
      await user.click(startButton());
      await waitFor(() => expect(startTask).toHaveBeenCalledTimes(1));
      await waitFor(() =>
        expect(startButton()).toHaveProperty("disabled", false),
      );

      edit();
      await user.click(startButton());

      await waitFor(() => expect(startTask).toHaveBeenCalledTimes(2));
      expect(startTask.mock.calls[1]?.[0].clientRequestId).not.toBe(
        startTask.mock.calls[0]?.[0].clientRequestId,
      );
    },
  );

  // #756-T06
  it("does not take an edit that never reached the server for a new attempt: a refused form keeps its id", async () => {
    const user = userEvent.setup();
    const startTask = vi
      .fn()
      .mockResolvedValueOnce(refused(null as never, "NETWORK_ERROR"))
      .mockResolvedValue(ok({ runId: "run-2", sessionId: "session-2" }));
    renderForm(fakeApi({ startTask }));
    await fillIn(user);
    await user.click(startButton());
    await waitFor(() => expect(startTask).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(startButton()).toHaveProperty("disabled", false),
    );

    // An edit that the form refuses before sending, taken back again: the body is the one of the first attempt.
    fireEvent.change(control("New branch name"), { target: { value: "a..b" } });
    await user.click(startButton());
    expect(startTask).toHaveBeenCalledTimes(1);
    const first = startTask.mock.calls[0]?.[0] as StartTaskRequest;
    fireEvent.change(control("New branch name"), {
      target: { value: first.branch },
    });
    await user.click(startButton());

    await waitFor(() => expect(startTask).toHaveBeenCalledTimes(2));
    expect(startTask.mock.calls[1]?.[0].clientRequestId).toBe(
      first.clientRequestId,
    );
  });

  // #756-T06
  it("says a task with this form was already started and links to it when the server names another task for the id", async () => {
    const user = userEvent.setup();
    renderForm(
      fakeApi({
        startTask: vi.fn(() =>
          Promise.resolve(
            refused(409, "IMPLEMENTER_REQUEST_REUSED", {
              details: { runId: "run 9/x" },
            }),
          ),
        ),
      }),
    );
    await fillIn(user);

    await user.click(startButton());

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(
      describeImplementerFailure(factory, {
        code: "IMPLEMENTER_REQUEST_REUSED",
      }),
    );
    expect(alert.textContent).toMatch(/already started/i);
    expect(
      screen.getByRole("link", { name: "Open that task" }).getAttribute("href"),
    ).toBe("/w/acme/runs/run%209%2Fx");
    expect(navigation.push).not.toHaveBeenCalled();
  });
});

describe("a base branch beyond the first page of branches (review of #793)", () => {
  const truncated = (): Pick<FakeApi, "branches"> => ({
    branches: vi.fn(() =>
      Promise.resolve(
        ok({
          defaultBranch: "main",
          branches: ["main", "develop"],
          truncated: true,
        }),
      ),
    ),
  });

  // #756-T03
  it("offers a field to type the name when the list is cut short, and says how", async () => {
    const user = userEvent.setup();
    renderForm(fakeApi(truncated()));
    await chooseRepository(user, "acme/widgets");

    expect(control("Another base branch")).toBeTruthy();
    expect(screen.getByText(/type the name of the branch below/i)).toBeTruthy();
  });

  // #756-T03
  it("has no such field while the list is complete", async () => {
    const user = userEvent.setup();
    renderForm(fakeApi());
    await chooseRepository(user, "acme/widgets");

    expect(screen.queryByLabelText("Another base branch")).toBeNull();
  });

  // #756-T03
  it("sends the typed name instead of the picked one, and the picked one again when the field is emptied", async () => {
    const user = userEvent.setup();
    const startTask = vi
      .fn()
      .mockResolvedValueOnce(refused(null as never, "NETWORK_ERROR"))
      .mockResolvedValue(ok({ runId: "run-1", sessionId: "session-1" }));
    renderForm(fakeApi({ ...truncated(), startTask }));
    await fillIn(user);

    fireEvent.change(control("Another base branch"), {
      target: { value: "release/9" },
    });
    await user.click(startButton());
    await waitFor(() => expect(startTask).toHaveBeenCalledTimes(1));
    expect(startTask.mock.calls[0]?.[0].baseBranch).toBe("release/9");
    await waitFor(() =>
      expect(startButton()).toHaveProperty("disabled", false),
    );

    fireEvent.change(control("Another base branch"), {
      target: { value: " " },
    });
    await user.click(startButton());
    await waitFor(() => expect(startTask).toHaveBeenCalledTimes(2));
    expect(startTask.mock.calls[1]?.[0].baseBranch).toBe("main");
  });

  // #756-T03
  it("checks the new branch against the typed base branch", async () => {
    const user = userEvent.setup();
    const api = fakeApi(truncated());
    renderForm(api);
    await fillIn(user);

    fireEvent.change(control("Another base branch"), {
      target: { value: "release/9" },
    });
    fireEvent.change(control("New branch name"), {
      target: { value: "release/9" },
    });
    await user.click(startButton());

    expect(
      document.getElementById(
        control("New branch name").getAttribute("aria-describedby") ?? "",
      )?.textContent,
    ).toBe(describeBranchIssue("same_as_base"));
    expect(api.startTask).not.toHaveBeenCalled();
  });

  // #756-T06
  it("marks the typed field, not the list, when the server has no such branch, and loads nothing again", async () => {
    const user = userEvent.setup();
    const api = fakeApi({
      ...truncated(),
      startTask: vi.fn(() =>
        Promise.resolve(refused(404, "IMPLEMENTER_BASE_BRANCH_NOT_FOUND")),
      ),
    });
    renderForm(api);
    await fillIn(user);
    fireEvent.change(control("Another base branch"), {
      target: { value: "nope" },
    });

    await user.click(startButton());

    await waitFor(() =>
      expect(control("Another base branch").getAttribute("aria-invalid")).toBe(
        "true",
      ),
    );
    expect(
      document.getElementById(
        control("Another base branch").getAttribute("aria-describedby") ?? "",
      )?.textContent,
    ).toBe(
      describeImplementerFailure(factory, {
        code: "IMPLEMENTER_BASE_BRANCH_NOT_FOUND",
      }),
    );
    expect(control("Base branch").getAttribute("aria-invalid")).not.toBe(
      "true",
    );
  });
});

describe("a base branch that is gone (review of #793)", () => {
  // #756-T06
  it("loads the branches again, drops the pick, and tells the person in a sentence instead of marking the stale field", async () => {
    const user = userEvent.setup();
    let calls = 0;
    const branches = vi.fn(() => {
      calls += 1;
      return Promise.resolve(
        ok({
          defaultBranch: "main",
          branches: calls === 1 ? ["main", "develop"] : ["main"],
          truncated: false,
        }),
      );
    });
    const api = fakeApi({
      branches,
      startTask: vi.fn(() =>
        Promise.resolve(refused(404, "IMPLEMENTER_BASE_BRANCH_NOT_FOUND")),
      ),
    });
    renderForm(api);
    await chooseRepository(user, "acme/widgets");
    await chooseOption(user, control("Base branch"), "develop");
    setTask("Add a health endpoint");
    await chooseOption(user, control("Provider"), "DeepSeek");
    await chooseOption(user, control("Model"), "DeepSeek Chat");

    await user.click(startButton());

    await waitFor(() => expect(branches).toHaveBeenCalledTimes(2));
    expect((await screen.findByRole("alert")).textContent).toBe(
      describeImplementerFailure(factory, {
        code: "IMPLEMENTER_BASE_BRANCH_NOT_FOUND",
      }),
    );
    await waitFor(() =>
      expect(control("Base branch").textContent).toContain("main"),
    );
    expect(control("Base branch").getAttribute("aria-invalid")).not.toBe(
      "true",
    );
  });
});

describe("a repository the app cannot write to, for the reason that is true (review of #793)", () => {
  const withReasons = (
    reasons: Array<[string, RepositoryChoice["unwritable"]]>,
  ) =>
    fakeApi({
      repositories: vi.fn(() =>
        Promise.resolve(
          ok({
            repositories: reasons.map(([fullName, unwritable], index) => ({
              id: `x${index}`,
              fullName,
              writeGranted: false,
              unwritable,
            })),
          }),
        ),
      ),
    });

  // #756-T02
  it("notes each repository with its own reason, and asks for the new permission only where that is the reason", async () => {
    const user = userEvent.setup();
    renderForm(
      fakeApi({
        repositories: vi.fn(() =>
          Promise.resolve(
            ok({
              repositories: [
                ...REPOSITORIES,
                {
                  id: "r4",
                  fullName: "acme/gone",
                  writeGranted: false,
                  unwritable: "connection_gone" as const,
                },
                {
                  id: "r5",
                  fullName: "acme/paused",
                  writeGranted: false,
                  unwritable: "connection_suspended" as const,
                },
              ],
            }),
          ),
        ),
      }),
    );
    await ready();

    await user.click(control("Repository"));
    const text = (await screen.findAllByRole("option")).map(
      (option) => option.textContent,
    );
    expect(text).toContain("acme/legacy (approve the new GitHub permission)");
    expect(text).toContain(
      `acme/gone (${describeUnwritableNote("connection_gone")})`,
    );
    expect(text).toContain(
      `acme/paused (${describeUnwritableNote("connection_suspended")})`,
    );
    expect(describeUnwritableNote("connection_gone")).not.toMatch(/approve/i);
  });

  // #756-T02
  it("says the one true thing when every repository is blocked for the same reason", async () => {
    renderForm(withReasons([["acme/gone", "connection_gone"]]));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(
      describeUnwritable(factory, "connection_gone"),
    );
    expect(alert.textContent).not.toMatch(/approve the new/i);
  });

  // #756-T02
  it("says each true thing, once, when the reasons differ", async () => {
    renderForm(
      withReasons([
        ["acme/gone", "connection_gone"],
        ["acme/legacy", "write_not_granted"],
        ["acme/other", "write_not_granted"],
      ]),
    );

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(
      [
        describeUnwritable(factory, "write_not_granted"),
        describeUnwritable(factory, "connection_gone"),
      ].join(" "),
    );
  });
});

describe("after a success (review of #793)", () => {
  const sent = async () => {
    const user = userEvent.setup();
    const api = fakeApi();
    renderForm(api);
    await fillIn(user);
    await user.click(startButton());
    await waitFor(() => expect(navigation.push).toHaveBeenCalled());
    return { user, api };
  };
  const pageshow = (persisted: boolean) => {
    const event = new Event("pageshow");
    Object.defineProperty(event, "persisted", { value: persisted });
    act(() => {
      window.dispatchEvent(event);
    });
  };

  // #756-T06
  it("shows the link to the run at once, beside the sending state", async () => {
    await sent();

    const link = screen.getByRole("link", { name: "Open the run" });
    expect(link.getAttribute("href")).toBe("/w/acme/runs/run-1");
    expect(screen.getByRole("status").textContent).toMatch(/started/i);
  });

  // #756-T06
  it("leaves the sending state when the page comes back from the back/forward cache, and keeps the link", async () => {
    const { user, api } = await sent();
    const first = api.startTask.mock.calls[0]?.[0] as StartTaskRequest;
    expect(
      screen.getByRole("button", { name: /Sending the task/ }),
    ).toBeTruthy();

    pageshow(true);

    expect(startButton()).toHaveProperty("disabled", false);
    expect(control("Task")).toHaveProperty("disabled", false);
    expect(screen.getByRole("link", { name: "Open the run" })).toBeTruthy();
    // Sent again unchanged it is the same task: same id.
    await user.click(startButton());
    await waitFor(() => expect(api.startTask).toHaveBeenCalledTimes(2));
    expect(api.startTask.mock.calls[1]?.[0].clientRequestId).toBe(
      first.clientRequestId,
    );
  });

  // #756-T06
  it("ignores the pageshow of an ordinary load", async () => {
    await sent();

    pageshow(false);

    expect(
      screen.getByRole("button", { name: /Sending the task/ }),
    ).toBeTruthy();
  });
});

describe("one send at a time (review of #793)", () => {
  // #756-T06
  it("starts one task when two submits arrive before the form has re-rendered", async () => {
    const user = userEvent.setup();
    const api = fakeApi({
      startTask: vi.fn(() => new Promise<never>(() => {})),
    });
    renderForm(api);
    await fillIn(user);
    const form = control("Task").closest("form") as HTMLFormElement;

    act(() => {
      fireEvent.submit(form);
      fireEvent.submit(form);
    });

    expect(api.startTask).toHaveBeenCalledTimes(1);
  });
});

describe("labels and order", () => {
  // #756-T07
  it("gives every control a label and keeps them in the order a person fills the form, ending with the button", async () => {
    renderForm(fakeApi());
    await ready();

    const order = [
      "Repository",
      "Base branch",
      "New branch name",
      "Task",
      "Profile",
      "Provider",
      "Model",
      "Environment",
      /^Cost limit/,
    ].map((label) => control(label));
    const form = order[0]?.closest("form") as HTMLFormElement;
    const all = Array.from(
      form.querySelectorAll("button, input, textarea, [role=combobox]"),
    );
    const positions = [...order, startButton()].map((element) =>
      all.indexOf(element),
    );
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(within(form).getAllByRole("combobox").length).toBe(6);
  });
});

const NODE_ENV = {
  id: "env-node",
  name: "Node 22",
  kind: "hosted" as const,
  labels: [] as string[],
  vcpus: 6,
  memoryGb: 10,
  sizeSupported: true,
  hasScript: true,
  networkMode: "off" as const,
};
const BARE_ENV = {
  ...NODE_ENV,
  id: "env-bare",
  name: "Bare",
  vcpus: 2,
  memoryGb: 2,
  hasScript: false,
};
// An environment made when 1 vCPU was offered: shown as it is, refused at submit.
const OLD_ENV = {
  ...NODE_ENV,
  id: "env-old",
  name: "One core",
  vcpus: 1,
  memoryGb: 0,
  sizeSupported: false,
  hasScript: false,
};
const withEnvironments = () =>
  fakeApi({
    environments: vi.fn<ImplementerApi["environments"]>(() =>
      Promise.resolve(
        ok({ environments: [BARE_ENV, NODE_ENV, OLD_ENV], maximum: 50 }),
      ),
    ),
  });

describe("the environment picker (#818)", () => {
  // #818-T22
  it("offers the standard first, then each environment of the workspace with its size", async () => {
    const user = userEvent.setup();
    renderForm(withEnvironments());
    await waitFor(() =>
      expect(control("Environment")).not.toHaveProperty("disabled", true),
    );

    await user.click(control("Environment"));
    const options = await screen.findAllByRole("option");

    expect(options.map((option) => option.textContent)).toEqual([
      "Standard (2 vCPU, 2 GB memory, no setup script)",
      "Bare (2 vCPU, 2 GB memory)",
      "Node 22 (6 vCPU, 10 GB memory, setup script)",
      "One core (1 vCPU, no longer offered)",
    ]);
    expect(control("Environment").textContent).toContain("Standard");
  });

  // #818-T22
  it("sends no environment when the standard stays chosen, exactly the body of before", async () => {
    const user = userEvent.setup();
    const api = withEnvironments();
    renderForm(api);
    await fillIn(user);

    await user.click(startButton());

    await waitFor(() => expect(api.startTask).toHaveBeenCalledTimes(1));
    expect(api.startTask.mock.calls[0]?.[0]).not.toHaveProperty(
      "environmentId",
    );
  });

  // #818-T22
  it("sends the id of the chosen environment", async () => {
    const user = userEvent.setup();
    const api = withEnvironments();
    renderForm(api);
    await fillIn(user);

    await chooseOption(user, control("Environment"), /^Node 22/);
    await user.click(startButton());

    await waitFor(() => expect(api.startTask).toHaveBeenCalledTimes(1));
    expect(api.startTask.mock.calls[0]?.[0]).toMatchObject({
      environmentId: "env-node",
    });
  });

  // #818-T22
  it("makes a task with another environment another task: the request id changes with the body", async () => {
    const user = userEvent.setup();
    const api = withEnvironments();
    api.startTask.mockResolvedValueOnce(
      refused(503, "IMPLEMENTER_GITHUB_UNAVAILABLE"),
    );
    renderForm(api);
    await fillIn(user);
    await user.click(startButton());
    await waitFor(() => expect(api.startTask).toHaveBeenCalledTimes(1));
    await screen.findByText(/GitHub could not be reached/);

    await chooseOption(user, control("Environment"), /^Bare/);
    await user.click(startButton());
    await waitFor(() => expect(api.startTask).toHaveBeenCalledTimes(2));

    const [first, second] = api.startTask.mock.calls.map((call) => call[0]);
    expect(first?.clientRequestId).not.toBe(second?.clientRequestId);
  });

  // #818-T22
  it("says, for an environment with a script, what the script is and what it costs when it fails", async () => {
    const user = userEvent.setup();
    renderForm(withEnvironments());
    await waitFor(() =>
      expect(control("Environment")).not.toHaveProperty("disabled", true),
    );

    await chooseOption(user, control("Environment"), /^Node 22/);

    const note = screen.getByText(/has a setup script/i);
    expect(note.textContent).toMatch(/root/i);
    expect(note.textContent).toMatch(/full internet access and no secrets/i);
    expect(note.textContent).toMatch(/not charged/i);
    // It does not say the scripts are not run: they are.
    expect(screen.queryByText(/do not run yet/i)).toBeNull();
  });

  // #745-T45: the rule for the agent's network is part of what the person chooses
  it("says in the list which environments give the agent a network, and in a note what that means", async () => {
    const user = userEvent.setup();
    const listed = {
      ...NODE_ENV,
      id: "env-list",
      name: "Py",
      networkMode: "list" as const,
    };
    const opened = {
      ...BARE_ENV,
      id: "env-open",
      name: "Web",
      networkMode: "open" as const,
    };
    const api = fakeApi({
      environments: vi.fn<ImplementerApi["environments"]>(() =>
        Promise.resolve(
          ok({ environments: [BARE_ENV, listed, opened], maximum: 50 }),
        ),
      ),
    });
    renderForm(api);
    await waitFor(() =>
      expect(control("Environment")).not.toHaveProperty("disabled", true),
    );

    await user.click(control("Environment"));
    const options = (await screen.findAllByRole("option")).map(
      (o) => o.textContent,
    );
    expect(options).toContain(
      "Py (6 vCPU, 10 GB memory, setup script, network: listed hosts)",
    );
    expect(options).toContain("Web (2 vCPU, 2 GB memory, network: any host)");
    expect(options).toContain("Bare (2 vCPU, 2 GB memory)");
    await user.keyboard("{Escape}");

    await chooseOption(user, control("Environment"), /^Py/);
    expect(
      screen.getByText(/only the hosts of this environment's list/i),
    ).toBeTruthy();
    expect(screen.queryByText(/without internet access/i)).toBeNull();

    await chooseOption(user, control("Environment"), /^Web/);
    expect(
      screen.getByText(/reaches any public host through a proxy/i),
    ).toBeTruthy();

    await chooseOption(user, control("Environment"), /^Bare/);
    expect(screen.queryByText(/without internet access/i)).toBeNull();
    expect(screen.queryByText(/reaches any public host/i)).toBeNull();
    expect(
      screen.queryByText(/only the hosts of this environment/i),
    ).toBeNull();
  });

  // #818-T23: an environment that still has 1 vCPU is shown as it is, and the task is refused with a clear message
  it("shows an environment with a size that is no longer offered, says so when it is chosen, and shows the server's refusal", async () => {
    const user = userEvent.setup();
    const api = withEnvironments();
    api.startTask.mockResolvedValueOnce(
      refused(422, "IMPLEMENTER_ENVIRONMENT_SIZE_UNSUPPORTED"),
    );
    renderForm(api);
    await fillIn(user);
    await chooseOption(user, control("Environment"), /^One core/);

    expect(screen.getByText(/1 vCPU leaves the agent no memory/i)).toBeTruthy();
    await user.click(startButton());

    expect(
      await screen.findByText(
        /no longer offered \(1 vCPU leaves the agent no memory\)/i,
      ),
    ).toBeTruthy();
    expect(control("Environment").getAttribute("aria-invalid")).toBe("true");
    expect(api.startTask.mock.calls[0]?.[0]).toMatchObject({
      environmentId: "env-old",
    });
  });

  // #818-T22
  it("does not stop a task without an environment when the environments cannot be loaded, and says so", async () => {
    const user = userEvent.setup();
    const api = fakeApi({
      environments: vi.fn<ImplementerApi["environments"]>(() =>
        Promise.resolve(refused(500, "UNEXPECTED_RESPONSE")),
      ),
    });
    renderForm(api);
    await fillIn(user);

    expect(
      await screen.findByText(/environments could not be loaded/i),
    ).toBeTruthy();
    await user.click(startButton());

    await waitFor(() => expect(api.startTask).toHaveBeenCalledTimes(1));
    expect(api.startTask.mock.calls[0]?.[0]).not.toHaveProperty(
      "environmentId",
    );
  });

  // #818-T22
  it("marks the environment field and loads the list again when the environment is gone", async () => {
    const user = userEvent.setup();
    const api = withEnvironments();
    api.startTask.mockResolvedValueOnce(
      refused(404, "IMPLEMENTER_ENVIRONMENT_NOT_FOUND"),
    );
    renderForm(api);
    await fillIn(user);
    await chooseOption(user, control("Environment"), /^Node 22/);

    await user.click(startButton());

    expect(
      await screen.findByText(/environment does not exist any more/i),
    ).toBeTruthy();
    expect(control("Environment").getAttribute("aria-invalid")).toBe("true");
    await waitFor(() => expect(api.environments).toHaveBeenCalledTimes(2));
  });
});

const summary = (
  id: string,
  name: string,
  version: number,
  archivedAt: string | null = null,
): ProfileChoice => ({ id, name, version, archivedAt });
const profileView = (
  base: ProfileChoice,
  document: Partial<ProfileDetail["document"]> = {},
): ProfileDetail => ({
  documentVersion: base.version,
  document: {
    model: { provider: "moonshot", model: "kimi-k2" },
    canPush: true,
    ...document,
  },
});
const IMPLEMENTER_PROFILE = summary("p-impl", "implementer", 2);
const REVIEWER_PROFILE = summary("p-rev", "reviewer", 1);
const OLD_PROFILE = summary("p-old", "retired", 3, "2026-11-03T10:00:00.000Z");
const PROFILE_VIEWS: Record<string, ProfileDetail> = {
  "p-impl": profileView(IMPLEMENTER_PROFILE),
  "p-rev": profileView(REVIEWER_PROFILE, {
    canPush: false,
    model: { provider: "deepseek", model: "deepseek-chat" },
  }),
};

function withProfiles(overrides: Partial<FakeApi> = {}) {
  return fakeApi({
    profiles: vi.fn<ImplementerApi["profiles"]>(() =>
      Promise.resolve(
        ok({
          profiles: [IMPLEMENTER_PROFILE, OLD_PROFILE, REVIEWER_PROFILE],
        }),
      ),
    ),
    profile: vi.fn<ImplementerApi["profile"]>((id) => {
      const view = PROFILE_VIEWS[id];
      return Promise.resolve(
        view === undefined
          ? refused(404, "PROFILE_NOT_FOUND")
          : ok({ profile: view }),
      );
    }),
    ...overrides,
  });
}

/** The form with a repository and a task, but no model: a profile brings it. */
async function fillInWithoutModel(user: ReturnType<typeof userEvent.setup>) {
  await chooseRepository(user, "acme/widgets");
  setTask("Add a health endpoint");
  await waitFor(() =>
    expect(control("Profile")).not.toHaveProperty("disabled", true),
  );
}

describe("the profile picker (#843)", () => {
  // #843-T40
  it("offers no profile first, then the newest version of each profile that is not archived", async () => {
    const user = userEvent.setup();
    renderForm(withProfiles());
    await fillInWithoutModel(user);

    await user.click(control("Profile"));
    const options = await screen.findAllByRole("option");

    expect(options.map((option) => option.textContent)).toEqual([
      "No profile",
      "implementer (version 2)",
      "reviewer (version 1)",
    ]);
    expect(control("Profile").textContent).toContain("No profile");
  });

  // #843-T40
  it("sends exactly the request of before when no profile is chosen", async () => {
    const user = userEvent.setup();
    const api = withProfiles();
    renderForm(api);
    await fillIn(user);

    await user.click(startButton());

    await waitFor(() => expect(api.startTask).toHaveBeenCalledTimes(1));
    const sent = api.startTask.mock.calls[0]?.[0];
    expect(sent).not.toHaveProperty("profile");
    expect(sent).toMatchObject({
      model: { provider: "deepseek", model: "deepseek-chat" },
    });
    expect(api.profile).not.toHaveBeenCalled();
  });

  // #843-T41
  it("shows the model of the chosen profile, not editable, no cost limit, and sends the profile instead of the model", async () => {
    const user = userEvent.setup();
    const api = withProfiles();
    renderForm(api);
    await fillInWithoutModel(user);

    await chooseOption(user, control("Profile"), /^implementer/);

    await waitFor(() =>
      expect(control("Model")).toHaveProperty("value", "Kimi K2 (Moonshot)"),
    );
    expect(control("Model")).toHaveProperty("readOnly", true);
    expect(screen.queryByLabelText(/^Cost limit/)).toBeNull();
    expect(screen.queryByLabelText("Provider")).toBeNull();
    expect(api.profile).toHaveBeenCalledWith("p-impl");

    await user.click(startButton());

    await waitFor(() => expect(api.startTask).toHaveBeenCalledTimes(1));
    const sent = api.startTask.mock.calls[0]?.[0];
    expect(sent).toMatchObject({
      repositoryId: "r1",
      instruction: "Add a health endpoint",
      profile: "implementer@2",
    });
    expect(sent).not.toHaveProperty("model");
    expect(sent).not.toHaveProperty("costLimitCents");
  });

  // #843-T41
  it("drops the cost field when a profile is chosen, and sends nothing of what was typed in it", async () => {
    const user = userEvent.setup();
    const api = withProfiles();
    renderForm(api);
    await fillIn(user);
    await user.type(control(/^Cost limit/), "99999");

    await chooseOption(user, control("Profile"), /^implementer/);
    await waitFor(() =>
      expect(screen.queryByLabelText(/^Cost limit/)).toBeNull(),
    );
    await user.click(startButton());

    await waitFor(() => expect(api.startTask).toHaveBeenCalledTimes(1));
    expect(api.startTask.mock.calls[0]?.[0]).not.toHaveProperty(
      "costLimitCents",
    );
  });

  // #843-T41
  it("has no cost limit field for a profile that sets none either", async () => {
    const user = userEvent.setup();
    renderForm(withProfiles());
    await fillInWithoutModel(user);

    await chooseOption(user, control("Profile"), /^reviewer/);

    await waitFor(() =>
      expect(control("Model")).toHaveProperty(
        "value",
        "DeepSeek Chat (DeepSeek)",
      ),
    );
    expect(screen.queryByLabelText(/^Cost limit/)).toBeNull();
    expect(control("Model")).toHaveProperty(
      "value",
      "DeepSeek Chat (DeepSeek)",
    );
  });

  // #843-T42
  it("gives the model back after choosing no profile again", async () => {
    const user = userEvent.setup();
    const api = withProfiles();
    renderForm(api);
    await fillIn(user);
    await chooseOption(user, control("Profile"), /^implementer/);
    await waitFor(() =>
      expect(control("Model")).toHaveProperty("readOnly", true),
    );

    await chooseOption(user, control("Profile"), "No profile");

    await waitFor(() => expect(control("Provider")).toBeTruthy());
    expect(control("Model").textContent).toContain("DeepSeek Chat");
    expect(control("Model")).not.toHaveProperty("readOnly", true);
    await user.click(startButton());
    await waitFor(() => expect(api.startTask).toHaveBeenCalledTimes(1));
    expect(api.startTask.mock.calls[0]?.[0]).not.toHaveProperty("profile");
    expect(api.startTask.mock.calls[0]?.[0]).toHaveProperty("model");
  });

  // #843-T43
  it("lists no archived profile even when the route sent one", async () => {
    const user = userEvent.setup();
    renderForm(withProfiles());
    await fillInWithoutModel(user);

    await user.click(control("Profile"));
    const options = await screen.findAllByRole("option");

    expect(options.map((option) => option.textContent)).not.toContain(
      "retired (version 3)",
    );
  });

  // #843-T44
  it("says in one sentence that a profile without the push right keeps the result in the run, and not for one with it", async () => {
    const user = userEvent.setup();
    renderForm(withProfiles());
    await fillInWithoutModel(user);

    await chooseOption(user, control("Profile"), /^reviewer/);
    expect(
      await screen.findByText(
        "This profile does not push: the result stays in the run.",
      ),
    ).toBeTruthy();

    await chooseOption(user, control("Profile"), /^implementer/);
    await waitFor(() =>
      expect(control("Model")).toHaveProperty("value", "Kimi K2 (Moonshot)"),
    );
    expect(screen.queryByText(/does not push/)).toBeNull();
  });

  // #843-T45
  it("keeps the environment a choice of its own next to the profile", async () => {
    const user = userEvent.setup();
    const api = withProfiles({
      environments: vi.fn<ImplementerApi["environments"]>(() =>
        Promise.resolve(ok({ environments: [NODE_ENV], maximum: 50 })),
      ),
    });
    renderForm(api);
    await fillInWithoutModel(user);
    await chooseOption(user, control("Profile"), /^implementer/);
    await waitFor(() =>
      expect(control("Model")).toHaveProperty("value", "Kimi K2 (Moonshot)"),
    );

    await chooseOption(user, control("Environment"), /^Node 22/);
    await user.click(startButton());

    await waitFor(() => expect(api.startTask).toHaveBeenCalledTimes(1));
    expect(api.startTask.mock.calls[0]?.[0]).toMatchObject({
      profile: "implementer@2",
      environmentId: "env-node",
    });
  });

  // #843-T46
  it("cannot be sent before the profile has arrived, and says so when it cannot be loaded", async () => {
    const user = userEvent.setup();
    const api = withProfiles({
      profile: vi.fn<ImplementerApi["profile"]>(() =>
        Promise.resolve(refused(500, "PROFILE_UNAVAILABLE")),
      ),
    });
    renderForm(api);
    await fillInWithoutModel(user);

    await chooseOption(user, control("Profile"), /^implementer/);

    expect(
      await screen.findByText(/This profile could not be loaded/),
    ).toBeTruthy();
    expect(startButton()).toHaveProperty("disabled", true);
    expect(api.startTask).not.toHaveBeenCalled();
  });

  // #843-T46
  it("does not stop a task without a profile when the profiles cannot be loaded, and says so", async () => {
    const user = userEvent.setup();
    const api = withProfiles({
      profiles: vi.fn<ImplementerApi["profiles"]>(() =>
        Promise.resolve(refused(500, "PROFILE_UNAVAILABLE")),
      ),
    });
    renderForm(api);
    await fillIn(user);

    expect(
      await screen.findByText(/profiles could not be loaded/),
    ).toBeTruthy();
    await user.click(startButton());

    await waitFor(() => expect(api.startTask).toHaveBeenCalledTimes(1));
    expect(api.startTask.mock.calls[0]?.[0]).not.toHaveProperty("profile");
  });

  // #843-T47
  it("marks the profile field with the sentence when the server says the profile is gone", async () => {
    const user = userEvent.setup();
    const api = withProfiles({
      startTask: vi.fn<ImplementerApi["startTask"]>(() =>
        Promise.resolve(refused(404, "IMPLEMENTER_PROFILE_NOT_FOUND")),
      ),
    });
    renderForm(api);
    await fillInWithoutModel(user);
    await chooseOption(user, control("Profile"), /^implementer/);
    await waitFor(() =>
      expect(control("Model")).toHaveProperty("value", "Kimi K2 (Moonshot)"),
    );

    await user.click(startButton());

    expect(
      await screen.findByText(/This profile does not exist any more/),
    ).toBeTruthy();
    expect(control("Profile").getAttribute("aria-invalid")).toBe("true");
  });

  // #843-T48
  it("sends the version it shows, also when the list names another", async () => {
    const user = userEvent.setup();
    const api = withProfiles({
      profile: vi.fn<ImplementerApi["profile"]>(() =>
        Promise.resolve(
          ok({
            profile: {
              ...profileView(IMPLEMENTER_PROFILE),
              documentVersion: 3,
            },
          }),
        ),
      ),
    });
    renderForm(api);
    await fillInWithoutModel(user);
    await chooseOption(user, control("Profile"), /^implementer/);
    await waitFor(() =>
      expect(control("Model")).toHaveProperty("value", "Kimi K2 (Moonshot)"),
    );

    await user.click(startButton());

    await waitFor(() => expect(api.startTask).toHaveBeenCalledTimes(1));
    expect(api.startTask.mock.calls[0]?.[0]).toMatchObject({
      profile: "implementer@3",
    });
  });

  // #843-T49
  it("shows the sentence of the server at the model when the model of the profile is refused", async () => {
    const user = userEvent.setup();
    const api = withProfiles({
      startTask: vi.fn<ImplementerApi["startTask"]>(() =>
        Promise.resolve(
          refused(422, "IMPLEMENTER_MODEL_NOT_ALLOWED", {
            details: { reason: "no_key" },
          }),
        ),
      ),
    });
    renderForm(api);
    await fillInWithoutModel(user);
    await chooseOption(user, control("Profile"), /^implementer/);
    await waitFor(() =>
      expect(control("Model")).toHaveProperty("value", "Kimi K2 (Moonshot)"),
    );

    await user.click(startButton());

    expect(
      await screen.findByText(describeModelRefusal("no_key")),
    ).toBeTruthy();
    expect(control("Model").getAttribute("aria-invalid")).toBe("true");
    await waitFor(() => expect(document.activeElement).toBe(control("Model")));
  });

  // #843-T49
  it("shows the sentence of the server when the limit an older version of the profile holds is above the maximum", async () => {
    const user = userEvent.setup();
    const api = withProfiles({
      startTask: vi.fn<ImplementerApi["startTask"]>(() =>
        Promise.resolve(
          refused(422, "EXCEEDS_OPERATOR_MAXIMUM", {
            details: { maximumCents: 200 },
          }),
        ),
      ),
    });
    renderForm(api);
    await fillInWithoutModel(user);
    await chooseOption(user, control("Profile"), /^implementer/);
    await waitFor(() =>
      expect(control("Model")).toHaveProperty("readOnly", true),
    );

    await user.click(startButton());

    expect(await screen.findByText(/maximum of \$2\.00 per task/)).toBeTruthy();
    expect(screen.queryByLabelText(/^Cost limit/)).toBeNull();
  });

  // #843-T50
  it("says at the model that it is not available and does not send, when the options do not list the model of the profile", async () => {
    const user = userEvent.setup();
    const api = withProfiles({
      profile: vi.fn<ImplementerApi["profile"]>(() =>
        Promise.resolve(
          ok({
            profile: profileView(IMPLEMENTER_PROFILE, {
              model: { provider: "moonshot", model: "kimi-gone" },
            }),
          }),
        ),
      ),
    });
    renderForm(api);
    await fillInWithoutModel(user);

    await chooseOption(user, control("Profile"), /^implementer/);

    expect(
      await screen.findByText(
        "The model of this profile is not available in this workspace, so the task would be refused. Choose another profile or none.",
      ),
    ).toBeTruthy();
    expect(control("Model").getAttribute("aria-invalid")).toBe("true");
    await user.click(startButton());
    expect(api.startTask).not.toHaveBeenCalled();
    await waitFor(() => expect(document.activeElement).toBe(control("Model")));
  });

  // #843-T50
  it("does not say the model is gone while the options load or when they failed", async () => {
    const user = userEvent.setup();
    const api = withProfiles({
      models: vi.fn<ImplementerApi["models"]>(() =>
        Promise.resolve(refused(500, "MODELS_UNAVAILABLE")),
      ),
    });
    renderForm(api);
    await chooseRepository(user, "acme/widgets");
    setTask("Add a health endpoint");
    await waitFor(() =>
      expect(control("Profile")).not.toHaveProperty("disabled", true),
    );

    await chooseOption(user, control("Profile"), /^implementer/);
    await waitFor(() =>
      expect(control("Model")).toHaveProperty("readOnly", true),
    );
    await waitFor(() => expect(api.models).toHaveBeenCalled());

    expect(screen.queryByText(/not available in this workspace/)).toBeNull();
    await user.click(startButton());
    await waitFor(() => expect(api.startTask).toHaveBeenCalledTimes(1));
  });
});
