// SPDX-License-Identifier: LicenseRef-Proprietary

// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { ConnectedApp } from "../apps/service.ts";
import { ConnectedAppsList } from "./connected-apps.tsx";

afterEach(cleanup);

const APPS: ConnectedApp[] = [
  {
    id: "g1",
    clientName: "Claude Code",
    userName: "Ada",
    scope: "factory:control",
    connectedAt: "2026-11-25T09:00:00.000Z",
    lastUsedAt: "2026-11-25T09:30:00.000Z",
    own: true,
  },
  {
    id: "g2",
    clientName: "Cursor",
    userName: "Bob",
    scope: "factory:read",
    connectedAt: "2026-11-24T09:00:00.000Z",
    lastUsedAt: null,
    own: false,
  },
];

describe("the list of connected AI apps", () => {
  // #1144-T215
  it("lists each connection with who, what access and when, and a revoke form that posts to its own route", () => {
    render(<ConnectedAppsList workspaceSlug="acme" apps={APPS} />);
    expect(screen.getByText("Claude Code")).toBeTruthy();
    expect(screen.getByText("You")).toBeTruthy();
    expect(screen.getByText("Bob")).toBeTruthy();
    expect(screen.getByText("Read and control")).toBeTruthy();
    expect(screen.getByText("Read only")).toBeTruthy();
    expect(screen.getByText("Never")).toBeTruthy();
    const form = screen
      .getByRole("button", { name: "Revoke Cursor of Bob" })
      .closest("form") as HTMLFormElement;
    expect(form.getAttribute("action")).toBe("/api/w/acme/ai-apps/g2/revoke");
    expect(form.getAttribute("method")).toBe("post");
  });

  // #1144-T216
  it("says so when no app is connected", () => {
    render(<ConnectedAppsList workspaceSlug="acme" apps={[]} />);
    expect(
      screen.getByText("No AI app is connected to this workspace."),
    ).toBeTruthy();
  });
});
