// SPDX-License-Identifier: LicenseRef-Proprietary

// A program the Playwright journeys run (node runs this file directly, TypeScript types are stripped;
// `--conditions=react-server` lets `server-only` pass) to fill the models.dev catalog of the app under test the way the daily
// fetch does: through the real fetch service (parse, address check, plan, guard, one transaction) on the app's database, with
// the committed fixture of `fakes/fixtures/models-dev/` as the body and the names resolved to a public address, so nothing
// leaves the machine and no row is written by hand. The app is a separate process with the same file open (WAL), so the
// providers and models show up in its pages.
//
//   fetch <db> [<fixture file>]    -> {"status": "applied" | "failed" | "skipped", ...}
//
// The fixture is the committed copy of the catalog by default; a journey whose models are made up (the Implementer's lane,
// `fakes/fixtures/models-dev/implementer-lane.json`) names its own.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { openPostgresDatabase } from "../db/postgres.ts";
import { createModelsDevService } from "../models-dev/service.ts";

const [command, databaseUrl, fixtureFile] = process.argv.slice(2);
if (command !== "fetch" || !databaseUrl)
  throw new Error("Usage: e2e-models-dev-child.ts fetch <db> [<fixture file>]");

const FIXTURE =
  fixtureFile ??
  join(
    import.meta.dirname,
    "..",
    "..",
    "..",
    "fakes",
    "fixtures",
    "models-dev",
    "api.json",
  );

const db = openPostgresDatabase({ url: databaseUrl, poolMax: 2 });
try {
  const service = createModelsDevService({
    db,
    settings: () => ({
      enabled: true,
      url: "https://models.dev/api.json",
      warnings: [],
    }),
    fetchImpl: () =>
      Promise.resolve(
        new Response(readFileSync(FIXTURE), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    resolveHost: () => Promise.resolve(["93.184.216.34"]),
    log: { info: () => undefined, error: () => undefined },
  });
  const outcome = await service.refresh();
  console.log(JSON.stringify(outcome));
  if (outcome.status !== "applied")
    throw new Error(`The catalog was not filled: ${outcome.status}`);
} finally {
  await db.destroy();
}
