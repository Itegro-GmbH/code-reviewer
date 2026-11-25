// SPDX-License-Identifier: LicenseRef-Proprietary
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // The repository's rule (AGENTS.md, "Keep the load low"): at most four workers, fewer on request.
    maxWorkers: Number(process.env.TEST_MAX_WORKERS ?? 2),
  },
});
