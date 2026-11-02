// SPDX-License-Identifier: LicenseRef-Proprietary

// The command behind `pnpm snapshot:build` (#330): arguments and environment in, a record file out. The
// platform token is read from the environment (`VERCEL_TOKEN` with `VERCEL_TEAM_ID` and `VERCEL_PROJECT_ID`, or
// none to use the OIDC token of the environment), handed to the platform client and to nothing else, and
// masked in every line this command prints. A refusal names the option or variable, never its value.
//
// Exit status: 0 the snapshot passed every check and the record was written; 1 the run failed (the log has the
// stable code) and no record exists; 2 the command was used wrongly and nothing was created.
import { createLogger } from "../core/logger.ts";
import type { Logger } from "../core/types.ts";
import { resolveConfig } from "./config.ts";
import type { PipelineConfig } from "./config.ts";
import { SnapshotPipelineError } from "./errors.ts";
import { runPipeline } from "./pipeline.ts";
import type { SnapshotService } from "./service.ts";
import type { VercelCredentials } from "./vercel-service.ts";

export type { VercelCredentials } from "./vercel-service.ts";

export type CliDeps = {
  env: Readonly<Record<string, string | undefined>>;
  stdout(text: string): void;
  stderr(line: string): void;
  readFile(path: string): Uint8Array;
  writeFile(path: string, text: string): void;
  removeFile(path: string): void;
  createService(
    credentials: VercelCredentials | undefined,
  ): SnapshotService | Promise<SnapshotService>;
  clock?: () => Date;
  signal?: AbortSignal;
};

const COMMIT = /^[0-9a-f]{7,64}$/;
const OPTION_NAME = /^--[a-z0-9-]{1,32}$/;
const VALUE_OPTIONS = [
  "--context",
  "--vm-prepare",
  "--sysbox-prepare",
  "--out",
  "--target",
  "--dockerfile",
  "--image-tag",
  "--docker-version",
  "--buildx-version",
  "--commit",
  "--keep",
  "--pin-snapshot",
] as const;
// Which option sets which configuration field, to name the option when a value is refused.
const OPTION_OF_FIELD: Record<string, string> = {
  target: "--target",
  dockerfile: "--dockerfile",
  imageTag: "--image-tag",
  dockerVersion: "--docker-version",
  buildxVersion: "--buildx-version",
  keep: "--keep",
  pinnedSnapshotIds: "--pin-snapshot",
};

class UsageError extends Error {
  readonly option: string;

  constructor(option: string) {
    super("usage");
    this.option = option;
  }
}

type Parsed = {
  context: string;
  vmPrepare: string;
  sysboxPrepare: string;
  out: string;
  commit?: string;
  overrides: Partial<PipelineConfig>;
};

function parse(argv: readonly string[]): Parsed {
  const values = new Map<string, string[]>();
  let skipRetention = false;
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index] ?? "";
    if (name === "--skip-retention") {
      skipRetention = true;
      index -= 1;
      continue;
    }
    if (!(VALUE_OPTIONS as readonly string[]).includes(name))
      throw new UsageError(OPTION_NAME.test(name) ? name : "unknown option");
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--"))
      throw new UsageError(name);
    values.set(name, [...(values.get(name) ?? []), value]);
  }
  const one = (name: string): string | undefined => values.get(name)?.at(-1);
  const required = (name: string): string => {
    const value = one(name);
    if (!value) throw new UsageError(name);
    return value;
  };
  const commit = one("--commit");
  if (commit !== undefined && !COMMIT.test(commit))
    throw new UsageError("--commit");
  const keep = one("--keep");
  const overrides: Partial<PipelineConfig> = {
    ...(one("--target") === undefined ? {} : { target: one("--target") }),
    ...(one("--dockerfile") === undefined
      ? {}
      : { dockerfile: one("--dockerfile") }),
    ...(one("--image-tag") === undefined
      ? {}
      : { imageTag: one("--image-tag") }),
    ...(one("--docker-version") === undefined
      ? {}
      : { dockerVersion: one("--docker-version") }),
    ...(one("--buildx-version") === undefined
      ? {}
      : { buildxVersion: one("--buildx-version") }),
    ...(skipRetention ? { retention: false } : {}),
    ...(keep === undefined ? {} : { keep: Number(keep) }),
    ...(values.has("--pin-snapshot")
      ? { pinnedSnapshotIds: values.get("--pin-snapshot") }
      : {}),
  };
  return {
    context: required("--context"),
    vmPrepare: required("--vm-prepare"),
    sysboxPrepare: required("--sysbox-prepare"),
    out: required("--out"),
    ...(commit === undefined ? {} : { commit }),
    overrides,
  };
}

function credentialsFrom(
  env: CliDeps["env"],
): VercelCredentials | undefined | { missing: string } {
  const token = env.VERCEL_TOKEN;
  if (!token) return undefined;
  if (!env.VERCEL_TEAM_ID) return { missing: "VERCEL_TEAM_ID" };
  if (!env.VERCEL_PROJECT_ID) return { missing: "VERCEL_PROJECT_ID" };
  return {
    token,
    teamId: env.VERCEL_TEAM_ID,
    projectId: env.VERCEL_PROJECT_ID,
  };
}

export async function runCli(
  argv: readonly string[],
  deps: CliDeps,
): Promise<number> {
  const secrets = [deps.env.VERCEL_TOKEN, deps.env.VERCEL_OIDC_TOKEN].filter(
    (value): value is string => !!value,
  );
  const logger: Logger = createLogger(deps.stderr, secrets);

  let parsed: Parsed;
  let config: PipelineConfig;
  try {
    parsed = parse(argv);
    config = resolveConfig(parsed.overrides);
  } catch (error) {
    if (error instanceof UsageError) {
      logger.error("usage_invalid", { option: error.option });
      return 2;
    }
    if (error instanceof SnapshotPipelineError) {
      logger.error("usage_invalid", {
        option: OPTION_OF_FIELD[error.detail[0] ?? ""] ?? "option",
      });
      return 2;
    }
    throw error;
  }

  const credentials = credentialsFrom(deps.env);
  if (credentials && "missing" in credentials) {
    logger.error("configuration_invalid", { variable: credentials.missing });
    return 2;
  }

  let context: Uint8Array;
  let vmPrepare: Uint8Array;
  let sysboxPrepare: Uint8Array;
  try {
    context = deps.readFile(parsed.context);
  } catch {
    logger.error("usage_invalid", { option: "--context" });
    return 2;
  }
  try {
    vmPrepare = deps.readFile(parsed.vmPrepare);
  } catch {
    logger.error("usage_invalid", { option: "--vm-prepare" });
    return 2;
  }
  try {
    sysboxPrepare = deps.readFile(parsed.sysboxPrepare);
  } catch {
    logger.error("usage_invalid", { option: "--sysbox-prepare" });
    return 2;
  }

  // A record of an earlier run must not outlive a failed one: no record means no snapshot to configure.
  deps.removeFile(parsed.out);
  try {
    const service = await deps.createService(credentials);
    const { record, warnings } = await runPipeline(
      { service, logger, clock: deps.clock, signal: deps.signal },
      {
        config,
        context,
        vmPrepareScript: new TextDecoder().decode(vmPrepare),
        sysboxPrepareScript: new TextDecoder().decode(sysboxPrepare),
        commit: parsed.commit,
      },
    );
    for (const warning of warnings) logger.warn(warning);
    const text = `${JSON.stringify(record, null, 2)}\n`;
    deps.writeFile(parsed.out, text);
    deps.stdout(text);
    return 0;
  } catch (error) {
    // A pipeline error has been logged with its code by the pipeline; anything else gets a code, never its text.
    if (!(error instanceof SnapshotPipelineError))
      logger.error("unexpected_error");
    return 1;
  }
}
