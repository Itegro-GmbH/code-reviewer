// SPDX-License-Identifier: LicenseRef-Proprietary

import { describe, expect, it, vi } from "vitest";
import type { Kysely } from "kysely";
import type { Database } from "../../db/schema.ts";
import { createToolServices } from "./services.ts";
import { testContext } from "./test-context.ts";

describe("the services seam of a tool context", () => {
  // #1144-T260
  it("hands a factory the token's workspace and user, acting as that person with no instance rank, and the database only when asked", () => {
    const database = vi.fn(() => ({}) as Kysely<Database>);
    const context = testContext({ database });
    const scope = context.services.use((s) => s);
    expect(scope.access.workspace.id).toBe("ws-acme");
    expect(scope.access.role).toBe("owner");
    expect(scope.access.user).toMatchObject({
      id: "user-ada",
      name: "Ada",
      isInstanceAdmin: false,
      githubLogin: null,
    });
    expect(scope.actor.label).toBe("Ada via Claude Code");
    // Nothing opened the database yet.
    expect(database).not.toHaveBeenCalled();
    scope.database();
    expect(database).toHaveBeenCalledTimes(1);
  });

  // #1144-T261
  it("builds a service once per call, however often a tool asks for it", () => {
    const { services } = testContext();
    const factory = vi.fn(() => ({ name: "lanes" }));
    expect(services.use(factory)).toBe(services.use(factory));
    expect(factory).toHaveBeenCalledTimes(1);
    const other = vi.fn(() => ({ name: "runs" }));
    expect(services.use(other)).not.toBe(services.use(factory));
  });

  // #1144-T262
  it("is made per request: another request gets its own services", () => {
    const factory = vi.fn(() => ({}));
    const scope = testContext().services.scope;
    const first = createToolServices(scope);
    const second = createToolServices(scope);
    expect(first.use(factory)).not.toBe(second.use(factory));
  });
});
