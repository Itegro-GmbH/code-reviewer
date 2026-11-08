// SPDX-License-Identifier: LicenseRef-Proprietary

// @vitest-environment jsdom
// The ToDos page (#925): the open list (questions and reviews), the done list, the filter by project, loading, empty and error states,
// the slow polling, and the panel that opens for the ToDo that is picked.
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RequestResult } from "../../ui/json-request.ts";
import type { TodoList } from "../service.ts";
import { TODOS_POLL_MS } from "./api.ts";
import {
  doneQuestion,
  failed,
  fakeApi,
  list,
  question,
  review,
} from "./test-fixtures.ts";
import { TodosPageContent } from "./todos-page.tsx";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("the ToDos page", () => {
  // #925
  it("says it is loading until the list is there", async () => {
    let release: (value: RequestResult<TodoList>) => void;
    const api = fakeApi();
    api.list.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    render(<TodosPageContent workspaceSlug="acme" api={api} />);

    expect(screen.getByText("Loading the ToDos")).toBeTruthy();
    await act(async () => {
      release({ ok: true, data: list() });
    });
    expect(screen.queryByText("Loading the ToDos")).toBeNull();
    expect(
      await screen.findByRole("heading", { level: 2, name: "Open · 2" }),
    ).toBeTruthy();
  });

  // #925
  it("lists the questions and the reviews, newest first, and the done list", async () => {
    render(<TodosPageContent workspaceSlug="acme" api={fakeApi()} />);

    const rows = within(
      await screen.findByRole("list", { name: "Open ToDos" }),
    ).getAllByRole("button");
    expect(rows.map((row) => row.getAttribute("data-todo-id"))).toEqual([
      "question:run-1:step-1:1",
      "review:r-1:7",
    ]);
    expect(rows[0]?.textContent).toContain("Retry which failures?");
    expect(rows[0]?.textContent).toContain("Answer");
    expect(rows[1]?.textContent).toContain("Add widget caching");
    expect(
      screen.getByRole("heading", { level: 2, name: "Done · 1" }),
    ).toBeTruthy();
    expect(
      screen.getByText(/Answered: Single or double opt-in\?/),
    ).toBeTruthy();
    expect(screen.getByText(/by octocat \(on this page\)/)).toBeTruthy();
    expect(
      screen.getByText(/Whoever answers first continues the run/),
    ).toBeTruthy();
  });

  // #925
  it("shows what the agent wrote as text, never as markup", async () => {
    const hostile = '<img src=x onerror="alert(1)"> **bold**';
    const { container } = render(
      <TodosPageContent
        workspaceSlug="acme"
        api={fakeApi({
          lists: [
            list({
              questions: [question({ question: hostile })],
              reviews: [],
              done: [],
            }),
          ],
        })}
      />,
    );

    expect(await screen.findByText(hostile)).toBeTruthy();
    expect(container.querySelector("img")).toBeNull();
  });

  // #925
  it("has an empty state with the way to the projects, and an empty done list", async () => {
    render(
      <TodosPageContent
        workspaceSlug="acme"
        api={fakeApi({
          lists: [list({ questions: [], reviews: [], done: [] })],
        })}
      />,
    );

    expect(await screen.findByText("Nothing waits for you")).toBeTruthy();
    expect(
      screen
        .getByRole("link", { name: "Open the projects" })
        .getAttribute("href"),
    ).toBe("/w/acme/projects");
    expect(
      screen.getByRole("heading", { level: 2, name: "Open · 0" }),
    ).toBeTruthy();
    expect(screen.getByText("Answered ToDos are listed here.")).toBeTruthy();
  });

  // #925
  it("says why the list could not be loaded, and tries again by itself", async () => {
    vi.useFakeTimers();
    const api = fakeApi({
      lists: [failed("TODOS_REVIEW_FAILED", 503), list()],
    });
    render(<TodosPageContent workspaceSlug="acme" api={api} />);

    await act(async () => {});
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("The ToDos could not be loaded.");
    expect(alert.textContent).toContain("tries again by itself");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(TODOS_POLL_MS);
    });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(
      screen.getByRole("heading", { level: 2, name: "Open · 2" }),
    ).toBeTruthy();
  });

  // #925
  it("keeps the last list on screen and says so when a later read fails", async () => {
    vi.useFakeTimers();
    const api = fakeApi({ lists: [list(), failed("NETWORK_ERROR", null)] });
    render(<TodosPageContent workspaceSlug="acme" api={api} />);
    await act(async () => {});

    await act(async () => {
      await vi.advanceTimersByTimeAsync(TODOS_POLL_MS);
    });

    expect(
      screen.getByRole("heading", { level: 2, name: "Open · 2" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("status", { name: "Updating the ToDos" }).textContent,
    ).toMatch(/Updating failed/);
  });

  // #925
  it("reads the list again at a slow interval", async () => {
    vi.useFakeTimers();
    const api = fakeApi({
      lists: [list(), list({ questions: [], reviews: [] })],
    });
    render(<TodosPageContent workspaceSlug="acme" api={api} />);
    await act(async () => {});
    expect(api.list).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(TODOS_POLL_MS - 1);
    });
    expect(api.list).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(api.list).toHaveBeenCalledTimes(2);
    expect(screen.getByText("Nothing waits for you")).toBeTruthy();
  });

  // #925
  it("filters by project when the ToDos are about more than one", async () => {
    const user = userEvent.setup();
    render(
      <TodosPageContent
        workspaceSlug="acme"
        api={fakeApi({
          lists: [
            list({
              questions: [question()],
              reviews: [
                review({
                  id: "review:r-2:3",
                  repositoryId: "r-2",
                  repo: "acme/api",
                  title: "Rate limit",
                }),
              ],
              done: [],
            }),
          ],
        })}
      />,
    );

    const filter = await screen.findByLabelText("Project");
    await user.selectOptions(filter, "acme/api");

    const rows = within(
      screen.getByRole("list", { name: "Open ToDos" }),
    ).getAllByRole("button");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.textContent).toContain("Rate limit");
    expect(
      screen.getByRole("heading", { level: 2, name: "Open · 1" }),
    ).toBeTruthy();
  });

  // #925
  it("has no filter when all ToDos are of one project", async () => {
    render(<TodosPageContent workspaceSlug="acme" api={fakeApi()} />);

    await screen.findByRole("list", { name: "Open ToDos" });
    expect(screen.queryByLabelText("Project")).toBeNull();
  });

  // #925
  it("opens the panel of the ToDo that is picked, moves the focus into it and gives it back on close", async () => {
    const user = userEvent.setup();
    render(<TodosPageContent workspaceSlug="acme" api={fakeApi()} />);
    const row = (await screen.findAllByRole("button", { pressed: false }))[0];
    if (row === undefined) throw new Error("no row");

    await user.click(row);

    const panel = screen.getByRole("complementary", {
      name: "Retry failed uploads",
    });
    expect(row.getAttribute("aria-pressed")).toBe("true");
    expect(document.activeElement).toBe(
      within(panel).getByRole("heading", { level: 2 }),
    );

    await user.click(within(panel).getByRole("button", { name: "Close" }));

    await waitFor(() => expect(document.activeElement).toBe(row));
    expect(screen.queryByRole("complementary")).toBeNull();
  });

  // #925
  it("opens the review panel for a review", async () => {
    const user = userEvent.setup();
    render(<TodosPageContent workspaceSlug="acme" api={fakeApi()} />);

    await user.click(
      await screen.findByRole("button", { name: /Add widget caching/ }),
    );

    const panel = screen.getByRole("complementary", {
      name: "Add widget caching",
    });
    expect(within(panel).getByRole("button", { name: "Approve" })).toBeTruthy();
    expect(
      within(panel).getByRole("button", { name: "Request changes" }),
    ).toBeTruthy();
  });

  // #925
  it("takes a ToDo out of the open list after it was answered and shows it as done once the list says so", async () => {
    const user = userEvent.setup();
    const answered = doneQuestion({
      id: "question:run-1:step-1:1",
      question: "Retry which failures?",
    });
    const api = fakeApi({
      lists: [
        list({ reviews: [], done: [] }),
        list({ questions: [], reviews: [], done: [answered] }),
      ],
    });
    render(<TodosPageContent workspaceSlug="acme" api={api} />);

    await user.click(
      await screen.findByRole("button", { name: /Retry which failures/ }),
    );
    await user.click(
      screen.getByRole("radio", { name: /Network errors and 5xx/ }),
    );
    await user.click(screen.getByRole("button", { name: "Answer" }));

    expect(
      await screen.findByText(/The answer went to the agent/),
    ).toBeTruthy();
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { level: 2, name: "Open · 0" }),
      ).toBeTruthy(),
    );
    expect(
      screen.getByRole("heading", { level: 2, name: "Done · 1" }),
    ).toBeTruthy();
  });

  // #925
  it("tells the sidebar to count again after an answer", async () => {
    const user = userEvent.setup();
    const heard = vi.fn();
    window.addEventListener("factory:todos-changed", heard);
    render(
      <TodosPageContent
        workspaceSlug="acme"
        api={fakeApi({ lists: [list({ reviews: [] })] })}
      />,
    );

    await user.click(
      await screen.findByRole("button", { name: /Retry which failures/ }),
    );
    await user.click(
      screen.getByRole("radio", { name: /Network errors and 5xx/ }),
    );
    await user.click(screen.getByRole("button", { name: "Answer" }));

    await waitFor(() => expect(heard).toHaveBeenCalled());
    window.removeEventListener("factory:todos-changed", heard);
  });
});

describe("the ToDos tab of a project", () => {
  // #925
  it("reads the list of the project and says so when nothing waits", async () => {
    const api = fakeApi({
      lists: [list({ projectId: "p-1", questions: [], reviews: [], done: [] })],
    });
    render(
      <TodosPageContent
        workspaceSlug="acme"
        projectId="p-1"
        variant="project"
        api={api}
      />,
    );

    expect(
      await screen.findByText("Nothing waits for you in this project"),
    ).toBeTruthy();
    expect(api.list).toHaveBeenCalledWith("p-1");
    expect(
      screen.queryByRole("link", { name: "Open the projects" }),
    ).toBeNull();
  });

  // #925
  it("reads nothing for a repository that is not a project", () => {
    const api = fakeApi();
    render(
      <TodosPageContent workspaceSlug="acme" variant="project" api={api} />,
    );

    expect(screen.getByText(/not a project yet/)).toBeTruthy();
    expect(api.list).not.toHaveBeenCalled();
  });
});
