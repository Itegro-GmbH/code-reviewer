// SPDX-License-Identifier: LicenseRef-Proprietary

// @vitest-environment jsdom
// The count on the sidebar's ToDos link (#925): a number only when there is one, never an error.
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TODOS_CHANGED_EVENT } from "./events.ts";
import { ProjectTodoBadge, TodoCount } from "./badges.tsx";

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

  // #925
  it("reads the count again when the ToDos page says it dealt with one", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ open: 2 }) })
      .mockResolvedValue({ ok: true, json: async () => ({ open: 1 }) });
    vi.stubGlobal("fetch", fetchMock);
    render(<TodoCount workspaceSlug="acme" pathname="/w/acme/todos" />);
    expect(await screen.findByText("2")).toBeTruthy();

    await act(async () => {
      window.dispatchEvent(new Event(TODOS_CHANGED_EVENT));
    });

    expect(await screen.findByText("1")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  // #925
  it("stops listening when it goes away", async () => {
    const fetchMock = answer({ open: 1 });
    vi.stubGlobal("fetch", fetchMock);
    const { unmount } = render(
      <TodoCount workspaceSlug="acme" pathname="/w/acme/todos" />,
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    unmount();

    window.dispatchEvent(new Event(TODOS_CHANGED_EVENT));

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // #925
  it("reads fresh when the ToDos page says it dealt with one, and not otherwise", async () => {
    const fetchMock = answer({ open: 1 });
    vi.stubGlobal("fetch", fetchMock);
    render(<TodoCount workspaceSlug="acme" pathname="/w/acme/todos" />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    await act(async () => {
      window.dispatchEvent(new Event(TODOS_CHANGED_EVENT));
    });

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      "/api/w/acme/todos/count",
      "/api/w/acme/todos/count?fresh=1",
    ]);
  });

  // #925
  it("reads again when the page changes", async () => {
    const fetchMock = answer({ open: 1 });
    vi.stubGlobal("fetch", fetchMock);
    const { rerender } = render(
      <TodoCount workspaceSlug="acme" pathname="/w/acme/runs" />,
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    rerender(<TodoCount workspaceSlug="acme" pathname="/w/acme/todos" />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });

  // #925
  it("keeps the newest answer when an older read arrives after it", async () => {
    const releases: ((count: number) => void)[] = [];
    const fetchMock = vi.fn(
      (url: string) =>
        new Promise<Response>((resolve) => {
          void url;
          releases.push((count) =>
            resolve({
              ok: true,
              json: async () => ({ open: count }),
            } as Response),
          );
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<TodoCount workspaceSlug="acme" pathname="/w/acme/todos" />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    // The page saw a change and asks fresh while the first read is still on its way.
    await act(async () => {
      window.dispatchEvent(new Event(TODOS_CHANGED_EVENT));
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    await act(async () => {
      releases[1]?.(1);
    });
    expect(await screen.findByText("1")).toBeTruthy();
    await act(async () => {
      releases[0]?.(7);
    });
    await settled();

    expect(screen.queryByText("7")).toBeNull();
    expect(screen.getByText("1")).toBeTruthy();
  });

  // #925
  it("asks once when the sidebar and the tab of a project both want the count", async () => {
    const fetchMock = answer({ open: 3, projects: { "p-1": 2 } });
    vi.stubGlobal("fetch", fetchMock);
    render(
      <>
        <TodoCount workspaceSlug="acme" pathname="/w/acme/projects/r-1" />
        <ProjectTodoBadge workspaceSlug="acme" projectId="p-1" />
      </>,
    );

    expect(await screen.findByText("3")).toBeTruthy();
    expect(await screen.findByText("2")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // #925
  it("shows the number of the project on its ToDos tab, and nothing for a project without ToDos or without an id", async () => {
    vi.stubGlobal("fetch", answer({ open: 3, projects: { "p-1": 2 } }));
    const { container } = render(
      <>
        <ProjectTodoBadge workspaceSlug="acme" projectId="p-1" />
        <ProjectTodoBadge workspaceSlug="acme" projectId="p-2" />
        <ProjectTodoBadge workspaceSlug="acme" projectId={null} />
      </>,
    );

    expect(await screen.findByText("2")).toBeTruthy();
    await settled();
    expect(container.textContent).toBe("Open: 2");
  });
});
