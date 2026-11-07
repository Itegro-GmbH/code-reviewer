// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";
// The drawer and the start dialog are controlled Radix dialogs without a Trigger, so Radix has no element to give the focus back to when
// they close (it focuses nothing and the person starts again from the top of the page). The board remembers the button that opened them
// and the dialog hands the focus back to it in `onCloseAutoFocus`.
import { useRef } from "react";

export function useReturnFocus() {
  const opener = useRef<HTMLElement | null>(null);
  return {
    /** Call from the click that opens the dialog, with the button that was clicked. */
    remember: (element: HTMLElement) => {
      opener.current = element;
    },
    /** For the `onCloseAutoFocus` of the dialog content. A button that is gone leaves Radix's own behaviour. */
    onCloseAutoFocus: (event: Event) => {
      const element = opener.current;
      if (element === null || !element.isConnected) return;
      event.preventDefault();
      element.focus();
    },
  };
}
