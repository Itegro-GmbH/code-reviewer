// SPDX-License-Identifier: LicenseRef-Proprietary

// Fills the models.dev catalog of the app under test the way the daily fetch does, with the committed fixture and no network
// (src/test-support/e2e-models-dev-child.ts). The journeys never write rows themselves.
import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const CHILD = resolve(
  process.cwd(),
  "src/test-support/e2e-models-dev-child.ts",
);

/**
 * Runs the fetch of the catalog once on the database of the app, with the committed copy of the public catalog or, when
 * given, a fixture file of the journey's own.
 */
export async function fetchModelsDevCatalog(
  databaseUrl: string,
  fixtureFile?: string,
): Promise<void> {
  await run(
    process.execPath,
    [
      "--no-warnings",
      "--conditions=react-server",
      CHILD,
      "fetch",
      databaseUrl,
      ...(fixtureFile === undefined
        ? []
        : [resolve(process.cwd(), fixtureFile)]),
    ],
    { cwd: process.cwd() },
  );
}
