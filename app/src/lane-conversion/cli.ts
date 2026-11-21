// SPDX-License-Identifier: LicenseRef-Proprietary

// `pnpm lanes:convert`: the lane conversion of release A (#1105, ADR 0007) against the database of a deployment, run by the operator after
// `pnpm migrate` of the release (`docs/factory-bring-up.md`, "Convert the lanes"):
//
//   DATABASE_URL_MIGRATE=... pnpm --dir app lanes:convert --dry-run          # only report
//   DATABASE_URL_MIGRATE=... pnpm --dir app lanes:convert                    # write the new versions
//   ... --workspace <id>   only that workspace         ... --json   the report as one JSON document on stdout
//
// Safe to run again: lanes already in the new form are skipped. The exit code is 0 when the list of release A is empty (every lane that
// is not archived is in the new form, or was archived), 2 when lanes are on the list (the report names them and why), 1 when the job could
// not run (the configuration, the database). One run at a time: it holds an advisory lock.
//
// Runs under plain Node (`node --conditions=react-server`, see package.json), like `pnpm migrate`.
import { loadMigrationDatabaseConfig } from "../db/config.ts";
import { DatabaseError, errorCode } from "../db/errors.ts";
import {
  assertPostgresReachable,
  openPostgresDatabase,
  withPostgresAdvisoryLock,
} from "../db/postgres.ts";
import { readSchemaStatus } from "../db/schema-status.ts";
import { reportLines } from "./format.ts";
import { runLaneConversion } from "./run.ts";

export const LANE_CONVERSION_LOCK_KEY = "code-reviewer:lane-conversion";

type Env = Readonly<Record<string, string | undefined>>;
type Io = { out: (line: string) => void; err: (line: string) => void };

export type LaneConversionArgs = {
  dryRun: boolean;
  json: boolean;
  workspaceId?: string;
};

/** The flags of the command; undefined for anything it does not know (the caller prints the usage). */
export function parseArgs(
  argv: readonly string[],
): LaneConversionArgs | undefined {
  const args: LaneConversionArgs = { dryRun: false, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === "--dry-run") args.dryRun = true;
    else if (flag === "--json") args.json = true;
    else if (flag === "--workspace") {
      const id = argv[i + 1];
      if (id === undefined || id.startsWith("--") || id === "")
        return undefined;
      args.workspaceId = id;
      i += 1;
    } else return undefined;
  }
  return args;
}

const USAGE =
  "usage: pnpm lanes:convert [--dry-run] [--workspace <id>] [--json]";

/** Returns the exit code: 0 the list of release A is empty, 2 it is not, 1 the job could not run. */
export async function runLaneConversionCommand(
  env: Env,
  argv: readonly string[],
  io: Io,
): Promise<number> {
  const args = parseArgs(argv);
  if (args === undefined) {
    io.err(`[lanes:convert] LANE_CONVERSION_USAGE: ${USAGE}`);
    return 1;
  }
  try {
    const config = loadMigrationDatabaseConfig(env);
    const db = openPostgresDatabase(config);
    try {
      await assertPostgresReachable(db, config);
      if (!(await readSchemaStatus(db)).upToDate) {
        io.err(
          "[lanes:convert] LANE_CONVERSION_SCHEMA_BEHIND: the database is behind this version. Run pnpm migrate first.",
        );
        return 1;
      }
      const report = await withPostgresAdvisoryLock(
        db,
        LANE_CONVERSION_LOCK_KEY,
        () =>
          runLaneConversion({
            db,
            dryRun: args.dryRun,
            ...(args.workspaceId === undefined
              ? {}
              : { workspaceId: args.workspaceId }),
            warn: (line) => io.err(line),
          }),
      );
      if (args.json) io.out(JSON.stringify(report, null, 2));
      else for (const line of reportLines(report)) io.out(line);
      return report.notConverted.length === 0 ? 0 : 2;
    } finally {
      // Best effort: a failure to close must not hide the result.
      await db.destroy().catch(() => undefined);
    }
  } catch (error) {
    if (error instanceof DatabaseError) {
      io.err(`[lanes:convert] ${error.code}: ${error.message}`);
      return 1;
    }
    // The cause is not repeated: it could carry a connection string.
    const system = errorCode(error);
    io.err(
      `[lanes:convert] LANE_CONVERSION_FAILED: the conversion ended with an unexpected error${system === undefined ? "" : ` (${system})`}. Nothing of a lane that was being saved is kept half done; run it again.`,
    );
    return 1;
  }
}

// Runs only when started as the program, not when a test imports `runLaneConversionCommand`.
if (import.meta.main) {
  process.exitCode = await runLaneConversionCommand(
    process.env,
    process.argv.slice(2),
    {
      out: (line) => process.stdout.write(`${line}\n`),
      err: (line) => process.stderr.write(`${line}\n`),
    },
  );
}
