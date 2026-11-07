// SPDX-License-Identifier: LicenseRef-Proprietary

// @vitest-environment jsdom
// The count on the sidebar's ToDos link (#925): a number only when there is one, never an error.
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TodoCount } from "./todo-count.tsx";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** Lets the pending fetch and its handlers run to the end, so an assertion of "nothing" is made after the answer, not before it. */
const settled = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

describe("the count on the ToDos link", () => {
  const answer = (body: unknown, ok = true) =>
    vi.fn(async (url: string) => {
      void url;
      return { ok, json: async () => body } as Response;
    });

  // #925
  it("shows nothing for none", async () => {
    const fetchMock = answer({ open: 0 });
    vi.stubGlobal("fetch", fetchMock);
    const { container } = render(
      <TodoCount workspaceSlug="acme" pathname="/w/acme/todos" />,
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/w/acme/todos/count");
    expect(container.textContent).toBe("");
  });

  // #925
  it("shows the number of open ToDos", async () => {
    vi.stubGlobal("fetch", answer({ open: 3 }));
    render(<TodoCount workspaceSlug="acme" pathname="/w/acme/todos" />);

    expect(await screen.findByText("3")).toBeTruthy();
  });

  // #925
  it("shows nothing when the read throws, and no error", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("offline");
    });
    vi.stubGlobal("fetch", fetchMock);
    const { container } = render(
      <TodoCount workspaceSlug="acme" pathname="/w/acme/todos" />,
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await settled();

    expect(container.textContent).toBe("");
  });

  // #925
  it("shows nothing when the route answers with an error, even if the body has a number", async () => {
    const fetchMock = answer({ open: 5 }, false);
    vi.stubGlobal("fetch", fetchMock);
    const { container } = render(
      <TodoCount workspaceSlug="acme" pathname="/w/acme/runs" />,
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await settled();

    expect(container.textContent).toBe("");
  });
});
