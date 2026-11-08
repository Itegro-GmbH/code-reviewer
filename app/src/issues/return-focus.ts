// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";
// The drawer and the start dialog are controlled Radix dialogs without a Trigger, so Radix has no element to give the focus back to when
// they close (it focuses nothing and the person starts again from the top of the page). The board remembers the button that opened them
// and the dialog hands the focus back to it in `onCloseAutoFocus`.
import { useRef } from "react";

export function useReturnFocus() {
  const opener = useRef<HTMLElement | null>(null);
  const row = useRef<string | null>(null);
  return {
    /** Call from the click that opens the dialog, with the button that was clicked. */
    remember: (element: HTMLElement) => {
      opener.current = element;
      row.current =
        element.closest<HTMLElement>("[data-issue]")?.dataset.issue ?? null;
    },
    /**
     * For the `onCloseAutoFocus` of the dialog content. A button that was replaced while the dialog was open (polling turned Start into
     * Review) gives the focus to the first control of its row; a row that is gone leaves Radix's own behaviour.
     */
    onCloseAutoFocus: (event: Event) => {
      const element = opener.current;
      const target =
        element !== null && element.isConnected
          ? element
          : row.current === null
            ? null
            : document.querySelector<HTMLElement>(
                `[data-issue="${row.current}"] button, [data-issue="${row.current}"] a`,
              );
      if (target === null) return;
      event.preventDefault();
      target.focus();
    },
  };
}
