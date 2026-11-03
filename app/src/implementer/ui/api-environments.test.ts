// SPDX-License-Identifier: LicenseRef-Proprietary

import { describe, expect, it } from "vitest";
import { createImplementerApi } from "./api.ts";

describe("the form's call for the environments (#818)", () => {
  // #818-T47
  it("asks for the picker's list, the one without the scripts, in the workspace of the page", async () => {
    const urls: string[] = [];
    const api = createImplementerApi(async (url) => {
      urls.push(url);
      return Response.json({ environments: [], maximum: 50 });
    }, "acme");

    const result = await api.environments();

    expect(result.ok).toBe(true);
    expect(urls).toEqual(["/api/w/acme/environments?view=picker"]);
  });
});
