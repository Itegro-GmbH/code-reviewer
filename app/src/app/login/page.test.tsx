// SPDX-License-Identifier: LicenseRef-Proprietary

// @vitest-environment jsdom
// #170: the login page names the action in its h1, gives each way to sign in its own named form,
// and puts a sign-in error directly above the fields it concerns, associated with them.
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/server", () => ({ connection: async () => {} }));
vi.mock("@/auth/actions", () => ({
  signInWithPassword: async () => {},
  signInWithGithub: async () => {},
}));
vi.mock("@/signup/shared", () => ({ getSignUpFacts: async () => ({}) }));
vi.mock("@/auth/password-reset-request", () => ({
  passwordResetAvailable: () => true,
}));

import { LoginPageContent, type LoginPageData } from "./page.tsx";

afterEach(cleanup);

/** Whether `other` comes after `anchor` in document order. */
function follows(anchor: Element, other: Element): boolean {
  return (
    (anchor.compareDocumentPosition(other) &
      Node.DOCUMENT_POSITION_FOLLOWING) !==
    0
  );
}

function data(overrides: Partial<LoginPageData> = {}): LoginPageData {
  return {
    invitation: null,
    oauth: null,
    emailPassword: true,
    github: true,
    signUpOpen: true,
    canReset: true,
    error: null,
    ...overrides,
  };
}

describe("the login page", () => {
  // #170-T01
  it("names the action and gives each way to sign in its own named form", () => {
    render(<LoginPageContent data={data()} />);

    expect(
      screen.getByRole("heading", { level: 1, name: "Sign in" }),
    ).toBeTruthy();
    const email = screen.getByRole("form", {
      name: "Sign in with email",
    });
    expect(within(email).getByLabelText("Email address")).toBeTruthy();
    expect(within(email).getByLabelText("Password")).toBeTruthy();
    expect(
      screen.getByRole("form", { name: "Sign in with GitHub" }),
    ).toBeTruthy();
  });

  // #170 review: the separator joins only the two sign-in methods, so the sign-up link follows them.
  it("keeps the separator between the two sign-in methods and the sign-up link after them", () => {
    render(<LoginPageContent data={data()} />);

    const email = screen.getByRole("form", { name: "Sign in with email" });
    const github = screen.getByRole("form", { name: "Sign in with GitHub" });
    const separator = screen.getByText("or");
    const createOne = screen.getByRole("link", { name: "Create one" });

    expect(follows(email, separator)).toBe(true);
    expect(follows(separator, github)).toBe(true);
    expect(follows(github, createOne)).toBe(true);
  });

  // #170-T02
  it("puts a sign-in error directly above the fields it concerns and associates it with them", () => {
    render(
      <LoginPageContent
        data={data({
          error: "The email address or the password is not correct.",
        })}
      />,
    );

    const form = screen.getByRole("form", {
      name: "Sign in with email",
    });
    const alert = within(form).getByRole("alert");
    expect(alert.textContent).toBe(
      "The email address or the password is not correct.",
    );
    expect(alert.id).not.toBe("");
    // Directly above the fields, not above the whole page.
    expect(form.firstElementChild).toBe(alert);
    for (const label of ["Email address", "Password"]) {
      const field = within(form).getByLabelText(label);
      expect(field.getAttribute("aria-describedby")).toBe(alert.id);
    }
  });
});
