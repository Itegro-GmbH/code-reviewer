// SPDX-License-Identifier: LicenseRef-Proprietary

// @vitest-environment jsdom
// Where the focus goes when the drawer or the start dialog closes (#925).
import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useReturnFocus } from "./return-focus.ts";

afterEach(() => {
  document.body.innerHTML = "";
});

function row(number: number, inner: string): HTMLElement {
  const table = document.createElement("table");
  table.innerHTML = `<tbody><tr data-issue="${String(number)}"><td>${inner}</td></tr></tbody>`;
  document.body.append(table);
  return table;
}

describe("the focus after a dialog closes", () => {
  // #925-T60
  it("goes back to the button that opened the dialog", () => {
    row(12, '<button type="button">Start</button>');
    const opener = document.querySelector("button") as HTMLElement;
    const { result } = renderHook(() => useReturnFocus());
    result.current.remember(opener);
    const event = new Event("focusout", { cancelable: true });

    result.current.onCloseAutoFocus(event);

    expect(document.activeElement).toBe(opener);
    expect(event.defaultPrevented).toBe(true);
  });

  // #925-T61
  it("goes to the first control of the row when the button was replaced while the dialog was open", () => {
    const table = row(12, '<button type="button">Start</button>');
    const opener = document.querySelector("button") as HTMLElement;
    const { result } = renderHook(() => useReturnFocus());
    result.current.remember(opener);
    const cell = table.querySelector("td") as HTMLElement;
    cell.innerHTML =
      '<a href="https://github.com/acme/widgets/pull/13">Review</a>';

    result.current.onCloseAutoFocus(
      new Event("focusout", { cancelable: true }),
    );

    expect(document.activeElement).toBe(cell.querySelector("a"));
  });

  // #925-T62
  it("leaves Radix's own behaviour when the row is gone", () => {
    const table = row(12, '<button type="button">Start</button>');
    const { result } = renderHook(() => useReturnFocus());
    result.current.remember(document.querySelector("button") as HTMLElement);
    table.remove();
    const event = new Event("focusout", { cancelable: true });

    result.current.onCloseAutoFocus(event);

    expect(event.defaultPrevented).toBe(false);
  });
});
