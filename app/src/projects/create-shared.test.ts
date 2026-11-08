// SPDX-License-Identifier: LicenseRef-Proprietary

// The wiring of the boards of a repository (#922, #937): the provider is asked with the repository of the workspace, a platform without
// boards has none, and a failure is logged by its code and never by its text (it may carry what GitHub answered).
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  repository: vi.fn(),
  integration: vi.fn(),
  resolve: vi.fn(),
}));

vi.mock("../db/startup.ts", () => ({ getDatabase: () => ({}) }));
vi.mock("../db/repositories/repositories-repository.ts", () => ({
  createRepositoriesRepository: () => ({ get: mocks.repository }),
}));
vi.mock("../db/repositories/integrations-repository.ts", () => ({
  createIntegrationsRepository: () => ({ get: mocks.integration }),
}));
vi.mock("../integrations/registry.ts", () => ({
  integrationRegistry: { resolve: mocks.resolve },
}));

import { boardsFor } from "./create-shared.ts";

const REPOSITORY = {
  id: "repo-1",
  active: true,
  integrationId: "int-1",
  externalId: "42",
  fullName: "acme/widgets",
  url: "https://github.test/acme/widgets",
};

function wire(provider: object) {
  mocks.repository.mockResolvedValue(REPOSITORY);
  mocks.integration.mockResolvedValue({
    id: "int-1",
    type: "github_app",
    status: "active",
  });
  mocks.resolve.mockReturnValue(provider);
}

afterEach(() => {
  vi.restoreAllMocks();
  mocks.repository.mockReset();
  mocks.integration.mockReset();
  mocks.resolve.mockReset();
});

describe("the boards of a repository", () => {
  // #937-T60
  it("asks the provider with the repository of the workspace and answers its boards", async () => {
    const listBoards = vi.fn(async () => ({ available: true, boards: [] }));
    wire({ listBoards });

    const answer = await boardsFor("ws-1")("repo-1");

    expect(answer).toEqual({ kind: "boards", available: true, boards: [] });
    expect(listBoards).toHaveBeenCalledWith(
      expect.objectContaining({ id: "int-1" }),
      {
        integrationId: "int-1",
        externalId: "42",
        fullName: "acme/widgets",
        url: "https://github.test/acme/widgets",
      },
    );
  });

  // #937-T61
  it("answers a repository that is not there or not active, an installation that is not active and a platform without boards", async () => {
    mocks.repository.mockResolvedValueOnce(undefined);
    expect(await boardsFor("ws-1")("nope")).toEqual({
      kind: "repository_not_found",
    });
    mocks.repository.mockResolvedValueOnce({ ...REPOSITORY, active: false });
    expect(await boardsFor("ws-1")("repo-1")).toEqual({
      kind: "repository_not_found",
    });
    wire({});
    mocks.integration.mockResolvedValueOnce({
      id: "int-1",
      status: "disabled",
    });
    expect(await boardsFor("ws-1")("repo-1")).toEqual({
      kind: "integration_unavailable",
    });
    expect(await boardsFor("ws-1")("repo-1")).toEqual({
      kind: "boards",
      available: true,
      boards: [],
    });
  });

  // #937-T62 (from the re-review of #936)
  it("logs only the code of a failure, never its text, and answers failed", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const failure = Object.assign(new Error("GitHub said: secret-ish text"), {
      code: "GITHUB_APP_RATE_LIMITED",
    });
    wire({
      listBoards: async () => {
        throw failure;
      },
    });

    expect(await boardsFor("ws-1")("repo-1")).toEqual({ kind: "failed" });

    expect(logged).toHaveBeenCalledTimes(1);
    expect(logged.mock.calls[0]).toEqual([
      "[projects] reading the boards of a repository failed:",
      "GITHUB_APP_RATE_LIMITED",
    ]);
    expect(JSON.stringify(logged.mock.calls)).not.toContain("secret-ish");
  });

  // #937-T63
  it("logs unknown for a failure that carries no code", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    wire({
      listBoards: async () => {
        throw new Error("boom");
      },
    });

    expect(await boardsFor("ws-1")("repo-1")).toEqual({ kind: "failed" });

    expect(logged.mock.calls[0]?.[1]).toBe("unknown");
  });
});
