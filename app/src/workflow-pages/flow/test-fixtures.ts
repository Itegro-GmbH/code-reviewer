// SPDX-License-Identifier: LicenseRef-Proprietary

// Fixtures for the tests of the lane flow: the shipped lane "Issue to PR" (the contract's example).
import { readFileSync } from "node:fs";
import { join } from "node:path";

export function shippedLane(): Record<string, unknown> {
  const file = join(
    import.meta.dirname,
    "../../../../contracts/examples/workflow/Workflow.json",
  );
  return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
}
