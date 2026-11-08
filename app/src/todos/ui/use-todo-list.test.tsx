// SPDX-License-Identifier: LicenseRef-Proprietary

// @vitest-environment jsdom
// Reading the ToDo list (#925): at once, slowly again, not while the page is hidden, never again after a failure that asking does not fix,
// and on demand after an answer.
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TODOS_POLL_MS } from "./api.ts";
import { failed, fakeApi, list } from "./test-fixtures.ts";
import { useTodoList } from "./use-todo-list.ts";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  Object.defineProperty(document, "hidden", {
    configurable: true,
    value: false,
  });
});

describe("the ToDo list reader", () => {
  // #925
  it("stops asking after a failure that asking again does not fix", async () => {
    const api = fakeApi({ lists: [failed("UNAUTHENTICATED", 401)] });
    const { result } = renderHook(() => useTodoList(api, undefined));
    await act(async () => {});

    expect(result.current.state).toMatchObject({
      status: "error",
      code: "UNAUTHENTICATED",
      stopped: true,
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(TODOS_POLL_MS * 3);
    });
    expect(api.list).toHaveBeenCalledTimes(1);
  });

  // #925
  it("stops asking for a project the workspace does not have", async () => {
    const api = fakeApi({ lists: [failed("TODOS_PROJECT_NOT_FOUND", 404)] });
    renderHook(() => useTodoList(api, "p-9"));
    await act(async () => {});
    await act(async () => {
      await vi.advanceTimersByTimeAsync(TODOS_POLL_MS * 2);
    });

    expect(api.list).toHaveBeenCalledTimes(1);
    expect(api.list).toHaveBeenCalledWith("p-9");
  });

  // #925
  it("does not ask while the page is hidden and asks again when it is shown", async () => {
    const api = fakeApi();
    renderHook(() => useTodoList(api, undefined));
    await act(async () => {});
    expect(api.list).toHaveBeenCalledTimes(1);

    Object.defineProperty(document, "hidden", {
      configurable: true,
      value: true,
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(TODOS_POLL_MS * 2);
    });
    expect(api.list).toHaveBeenCalledTimes(1);

    Object.defineProperty(document, "hidden", {
      configurable: true,
      value: false,
    });
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(api.list).toHaveBeenCalledTimes(2);
  });

  // #925
  it("reads again on demand, after a read that was on its way", async () => {
    const api = fakeApi({ lists: [list(), list({ questions: [] })] });
    const { result } = renderHook(() => useTodoList(api, undefined));
    await act(async () => {});

    await act(async () => {
      await result.current.refresh();
    });

    expect(api.list).toHaveBeenCalledTimes(2);
    expect(result.current.state).toMatchObject({
      status: "ready",
      failed: false,
      list: { questions: [] },
    });
  });

  // #925
  it("stops asking when it goes away", async () => {
    const api = fakeApi();
    const { unmount } = renderHook(() => useTodoList(api, undefined));
    await act(async () => {});
    unmount();

    await vi.advanceTimersByTimeAsync(TODOS_POLL_MS * 3);

    expect(api.list).toHaveBeenCalledTimes(1);
  });
});
