// SPDX-License-Identifier: LicenseRef-Proprietary

// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { ConsentView } from "../oauth/service.ts";
import { ConsentForm } from "./consent-form.tsx";
import { consentErrorCopy } from "./messages.ts";

afterEach(cleanup);

const VIEW: ConsentView = {
  requestId: "R".repeat(32),
  client: { id: "c1", name: "Claude Code" },
  redirectTarget: "127.0.0.1:33418",
  requestedScopes: ["factory:read", "factory:control"],
  allowedScopes: ["factory:read", "factory:control"],
  workspaces: [
    { id: "w1", slug: "acme", name: "Acme", role: "owner" },
    { id: "w2", slug: "side", name: "Side Project", role: "member" },
  ],
};

describe("the consent form", () => {
  // #1144-T210
  it("names the app and where its code goes, and posts to the consent route", () => {
    render(<ConsentForm view={VIEW} productName="Software Factory" />);
    const form = screen.getByRole("form", { name: "Connect an AI app" });
    expect(form.getAttribute("action")).toBe("/api/oauth/consent");
    expect(form.getAttribute("method")).toBe("post");
    expect(screen.getByText("Claude Code")).toBeTruthy();
    expect(screen.getByText("127.0.0.1:33418")).toBeTruthy();
    expect(
      (form.querySelector('input[name="request"]') as HTMLInputElement).value,
    ).toBe("R".repeat(32));
  });

  // #1144-T211
  it("offers each workspace with the person's role, the first chosen, and read only chosen by default", () => {
    render(<ConsentForm view={VIEW} productName="Software Factory" />);
    const workspaces = screen.getAllByRole("radio", {
      name: /Acme|Side Project/,
    }) as HTMLInputElement[];
    expect(workspaces.map((r) => [r.value, r.checked])).toEqual([
      ["w1", true],
      ["w2", false],
    ]);
    expect(screen.getByText("Your role: Owner")).toBeTruthy();
    const scopes = screen.getAllByRole("radio", {
      name: /Read/,
    }) as HTMLInputElement[];
    expect(scopes.map((r) => [r.value, r.checked])).toEqual([
      ["factory:read", true],
      ["factory:control", false],
    ]);
  });

  // #1144-T212
  it("offers only the scope the app asked for", () => {
    render(
      <ConsentForm
        view={{ ...VIEW, allowedScopes: ["factory:control"] }}
        productName="Software Factory"
      />,
    );
    const scopes = screen.getAllByRole("radio", {
      name: /Read/,
    }) as HTMLInputElement[];
    expect(scopes.map((r) => [r.value, r.checked])).toEqual([
      ["factory:control", true],
    ]);
  });

  // #1144-T213
  it("has an Approve and a Deny button that answer the same form", () => {
    render(<ConsentForm view={VIEW} productName="Software Factory" />);
    const approve = screen.getByRole("button", {
      name: "Approve",
    }) as HTMLButtonElement;
    const deny = screen.getByRole("button", {
      name: "Deny",
    }) as HTMLButtonElement;
    expect([approve.name, approve.value, deny.name, deny.value]).toEqual([
      "decision",
      "approve",
      "decision",
      "deny",
    ]);
    expect(deny.formNoValidate).toBe(true);
  });

  // #1144-T214
  it("turns an error code into a sentence and shows nothing for a code that is none", () => {
    expect(consentErrorCopy("workspace_invalid")).toBe(
      "Choose one of your workspaces.",
    );
    expect(consentErrorCopy("<script>")).toBeNull();
    expect(consentErrorCopy(undefined)).toBeNull();
  });
});
