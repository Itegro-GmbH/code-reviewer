// SPDX-License-Identifier: LicenseRef-Proprietary

// `pnpm lanes:convert`: the lane conversion of release A (#1105, ADR 0007) against the database of a deployment, run by the operator after
// `pnpm migrate` of the release (`docs/factory-bring-up.md`, "Convert the lanes"):
//
//   DATABASE_URL_MIGRATE=... pnpm --dir app lanes:convert --dry-run          # only report
//   DATABASE_URL_MIGRATE=... pnpm --dir app lanes:convert                    # write the new versions
//   ... --workspace <id>   only that workspace         ... --json   the report as one JSON document on stdout
//
// Safe to run again: lanes already in the new form are skipped. Exit codes (`exit-code.ts`, one function of the report):
//   0  nothing is left: no lane would change or is listed, no workspace failed. A real run over all workspaces that exits 0 is the gate of
//      release B (the list of release A is empty); a dry run that exits 0 only says nothing would change; a `--workspace` run that exits 0
//      says so about that workspace only. The last line of the report says which of the three it is.
//   1  the job could not run (the configuration, the database, an unknown --workspace) or it ended early; a partial report is out first
//   2  lanes are on the list of release A (or a workspace failed): the report names them and why
//   3  a dry run only: the real run would convert or archive lanes, so the release is not ready
// One line per lane is printed as soon as it is done (stdout, or stderr with --json), so a crash loses no record of what was written.
// One run at a time: it holds an advisory lock.
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
import { exitCodeOf, LANE_CONVERSION_EXIT } from "./exit-code.ts";
import { reportLines } from "./format.ts";
import { LaneConversionError, runLaneConversion } from "./run.ts";
import type { LaneConversionReport } from "./types.ts";

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

/** Returns the exit code (`exit-code.ts`): 0 nothing left, 1 the job could not run or ended early, 2 lanes on the list, 3 a dry run with work pending. */
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
  // Kept outside the lock so that a failure after the job finished (the lock connection dropped) still has the report to print.
  let report: LaneConversionReport | undefined;
  const emit = (final: LaneConversionReport) => {
    if (args.json) io.out(JSON.stringify(final, null, 2));
    else for (const line of reportLines(final)) io.out(line);
  };
  try {
    const config = loadMigrationDatabaseConfig(env);
    const db = openPostgresDatabase(config);
    try {
      await assertPostgresReachable(db, config);
      if (!(await readSchemaStatus(db)).upToDate) {
        io.err(
          "[lanes:convert] LANE_CONVERSION_SCHEMA_BEHIND: the database is behind this version. Run pnpm migrate first.",
        );
        return LANE_CONVERSION_EXIT.failed;
      }
      await withPostgresAdvisoryLock(db, LANE_CONVERSION_LOCK_KEY, async () => {
        report = await runLaneConversion({
          db,
          dryRun: args.dryRun,
          ...(args.workspaceId === undefined
            ? {}
            : { workspaceId: args.workspaceId }),
          warn: (line) => io.err(line),
          // The lines of the lanes go to stdout, but stdout is one JSON document with --json.
          progress: (line) => (args.json ? io.err(line) : io.out(line)),
        });
      });
      if (report === undefined) return LANE_CONVERSION_EXIT.failed;
      emit(report);
      return exitCodeOf(report);
    } finally {
      // Best effort: a failure to close must not hide the result.
      await db.destroy().catch(() => undefined);
    }
  } catch (error) {
    if (error instanceof LaneConversionError) {
      io.err(`[lanes:convert] ${error.code}: ${error.message}`);
      return LANE_CONVERSION_EXIT.failed;
    }
    if (error instanceof DatabaseError) {
      io.err(`[lanes:convert] ${error.code}: ${error.message}`);
      return LANE_CONVERSION_EXIT.failed;
    }
    // The cause is not repeated: it could carry a connection string.
    const system = errorCode(error);
    if (report !== undefined) {
      // The job ran, and then the lock failed (its connection was lost): the work ran unprotected. The report of what was done is out
      // before the error, marked as not complete, so it is not lost and not mistaken for a clean run.
      const done: LaneConversionReport = {
        ...report,
        complete: false,
        aborted: report.aborted ?? {
          code: system ?? "lock_lost",
          message:
            "The advisory lock failed after the work was done, so it may have run beside another run. Run it again and read the result.",
        },
      };
      emit(done);
    }
    io.err(
      `[lanes:convert] LANE_CONVERSION_FAILED: the conversion ended with an unexpected error${system === undefined ? "" : ` (${system})`}. Nothing of a lane that was being saved is kept half done; run it again.`,
    );
    return LANE_CONVERSION_EXIT.failed;
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
