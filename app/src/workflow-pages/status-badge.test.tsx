// SPDX-License-Identifier: LicenseRef-Proprietary

// @vitest-environment jsdom
// #921: a status this build does not know (a newer server wrote it while an older page is open, or the reverse during a rollout) is shown
// as plain text with a neutral symbol, never as a crash of the page.
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { RUN_STATUS_COPY, STEP_STATUS_COPY } from "./messages.ts";
import { StepStatusBadge, WorkflowRunStatusBadge } from "./status-badge.tsx";

afterEach(cleanup);

describe("the badges of runs and steps", () => {
  // #921-T105
  it("shows every known status with the label of its copy", () => {
    for (const status of Object.keys(RUN_STATUS_COPY) as Array<
      keyof typeof RUN_STATUS_COPY
    >) {
      const { container, unmount } = render(
        <WorkflowRunStatusBadge status={status} />,
      );
      expect(container.textContent).toBe(RUN_STATUS_COPY[status].label);
      unmount();
    }
    for (const status of Object.keys(STEP_STATUS_COPY) as Array<
      keyof typeof STEP_STATUS_COPY
    >) {
      const { container, unmount } = render(
        <StepStatusBadge status={status} />,
      );
      expect(container.textContent).toBe(STEP_STATUS_COPY[status].label);
      unmount();
    }
  });

  // #921-T106
  it("shows a status it does not know as it is written, with a neutral symbol", () => {
    const run = render(
      <WorkflowRunStatusBadge
        status={"paused-for-review" as keyof typeof RUN_STATUS_COPY}
        hint
      />,
    );
    expect(run.container.textContent).toContain("paused-for-review");
    expect(
      run.container.querySelector("svg[aria-hidden='true']"),
    ).not.toBeNull();
    cleanup();
    const step = render(
      <StepStatusBadge
        status={"paused-for-review" as keyof typeof STEP_STATUS_COPY}
      />,
    );
    expect(step.container.textContent).toBe("paused-for-review");
  });
});
