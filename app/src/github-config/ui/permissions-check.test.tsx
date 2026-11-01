// SPDX-License-Identifier: LicenseRef-Proprietary

// @vitest-environment jsdom
// The list the portal shows next to "Check the permissions": it names Contents only in a deployment with the
// Implementer (#749), and nothing changes for code-review.com.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { CapabilitiesProvider } from "../../capabilities/context.tsx";
import type { Capability } from "../../capabilities/capability.ts";
import { getProductIdentity } from "../../product-identity/current.ts";
import type { GithubApi } from "./api.ts";
import { PermissionsCheck } from "./permissions-check.tsx";

afterEach(cleanup);

const IMPLEMENTER: Capability[] = ["review", "dynamic-review", "implementer"];
const CODE_REVIEW_COM: Capability[] = ["review", "dynamic-review", "billing"];

function renderCheck(capabilities: Capability[], missing: string[] = []): void {
  const api = {
    check: async () => ({
      ok: true as const,
      data: { ok: true as const, missing },
    }),
  } as unknown as GithubApi;
  render(
    <CapabilitiesProvider capabilities={capabilities}>
      <PermissionsCheck product={getProductIdentity()} api={api} />
    </CapabilitiesProvider>,
  );
}

describe("the permissions the portal lists", () => {
  // #749-T08
  it("name Contents, read and write, only in a deployment with the Implementer", () => {
    renderCheck(IMPLEMENTER);

    expect(screen.getByText(/Contents: Read and write/)).toBeTruthy();
    expect(screen.getByText(/Checks: Read and write/)).toBeTruthy();
  });

  // #749-T08
  it("do not mention Contents for code-review.com", () => {
    renderCheck(CODE_REVIEW_COM);

    expect(screen.queryByText(/Contents/)).toBeNull();
    expect(screen.getByText(/Checks: Read and write/)).toBeTruthy();
  });

  // #749-T08
  it("say what a missing Contents means in the words of the settings page", async () => {
    renderCheck(IMPLEMENTER, ["contents"]);

    fireEvent.click(
      screen.getByRole("button", { name: /Check the permissions/ }),
    );

    expect(await screen.findByText("The App lacks:")).toBeTruthy();
    expect(
      screen.getAllByText(/Repository permissions > Contents: Read and write/)
        .length,
    ).toBeGreaterThan(1);
  });
});
