// SPDX-License-Identifier: LicenseRef-Proprietary

import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestDatabase } from "../test-support/test-database.ts";

const database = vi.hoisted(() => ({ current: undefined as unknown }));
vi.mock("../db/startup.ts", () => ({
  getDatabase: () => {
    if (database.current === undefined) throw new Error("no database");
    return database.current;
  },
}));

const { healthResponse } = await import("./response.ts");

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("GET /api/health", () => {
  // #731-T09
  it("reports the product and the capabilities of a deployment that sets nothing: today's code-review.com", async () => {
    database.current = (await createTestDatabase()).db;

    const response = await healthResponse();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: "ok",
      product: "code-review-com",
      capabilities: ["billing", "dynamic-review", "review"],
    });
  });

  // #731-T09
  it("reports the set of the factory deployment", async () => {
    database.current = (await createTestDatabase()).db;
    vi.stubEnv("PRODUCT_ID", "factory");
    vi.stubEnv("PRODUCT_CAPABILITIES", "review,dynamic-review");

    const body = await (await healthResponse()).json();

    expect(body).toEqual({
      status: "ok",
      product: "factory",
      capabilities: ["dynamic-review", "review"],
    });
  });

  // #747-T06
  it("reports implementer in the set of a factory deployment that enables it", async () => {
    database.current = (await createTestDatabase()).db;
    vi.stubEnv("PRODUCT_ID", "factory");
    vi.stubEnv("PRODUCT_CAPABILITIES", "review,dynamic-review,implementer");

    const response = await healthResponse();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: "ok",
      product: "factory",
      capabilities: ["dynamic-review", "implementer", "review"],
    });
  });

  // #747-T06
  it("answers 503 for implementer on code-review.com and never reports it", async () => {
    database.current = (await createTestDatabase()).db;
    vi.stubEnv("PRODUCT_CAPABILITIES", "review,dynamic-review,implementer");

    const response = await healthResponse();

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ status: "error" });
  });

  it("answers 503 and names no product when the capability settings cannot be read", async () => {
    database.current = (await createTestDatabase()).db;
    vi.stubEnv("PRODUCT_CAPABILITIES", "nonsense");

    const response = await healthResponse();

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ status: "error" });
  });

  it("keeps the error answer, with the facts, when the database cannot be read", async () => {
    database.current = undefined;

    const response = await healthResponse();

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      status: "error",
      product: "code-review-com",
    });
  });
});
