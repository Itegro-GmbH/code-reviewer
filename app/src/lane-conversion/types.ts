// SPDX-License-Identifier: LicenseRef-Proprietary

// The vocabulary of the lane conversion (#1105, ADR 0007, release A, steps 2 to 4): why a lane is not converted, and the report the
// operator reads. The codes are stable: the report is read by a person today and by a script (the check before release B) tomorrow.
import type { ModelChoice } from "../db/implementer-model-choice.ts";

/** Why a step, or a whole lane, was not converted. The lane keeps its current version and is listed with these. */
export const CONVERSION_REASON_CODES = [
  /** The profile of a step is archived: its values are not resolved on a guess. */
  "profile_archived",
  /** No profile of that name. */
  "profile_missing",
  /** The profile exists, the pinned version does not. */
  "profile_version_missing",
  /** The step and its profile name no environment at all (a profile version saved before #919, a step that wrote none). */
  "environment_missing",
  /** The environment the step or its profile names is not one of the workspace any more. */
  "environment_not_found",
  /** A hosted environment of a size no hosted runner type offers (1 vCPU): there is no runner to name. */
  "environment_size_unsupported",
  /** A runner environment whose labels no self-hosted runner of the workspace has. */
  "runner_none_match",
  /** A runner environment whose labels more than one self-hosted runner has: the owner decides which, the migration never picks. */
  "runner_several_match",
  /** The document is not a workflow document the conversion can read (not JSON, or no object). */
  "document_unreadable",
  /** The converted document does not pass the validator of a save; `issues` has the codes. */
  "validation_failed",
  /** Somebody saved the lane while it was converted; run the conversion again. */
  "version_conflict",
  /** The lane holds the most versions it may. */
  "version_limit_reached",
  /** The lane names an MCP server that is gone. */
  "mcp_server_missing",
  /** The save failed in a way that has no code of its own (the database); the error is in the log. */
  "save_failed",
] as const;
export type ConversionReasonCode = (typeof CONVERSION_REASON_CODES)[number];

/** A runner a person can choose, for the list of candidates. */
export type RunnerCandidate = { id: string; name: string };

export type ConversionReason = {
  code: ConversionReasonCode;
  /** The step the reason is about; left out for a reason about the lane. */
  stepId?: string;
  /** What the operator needs to decide, in a sentence. Never a secret. */
  message: string;
  /** `runner_several_match`: the runners that have all the labels. */
  candidates?: RunnerCandidate[];
  /** `validation_failed`: the codes of the validator's issues (each once, in the order found), with their places. */
  issues?: { code: string; path: string }[];
};

/** What a profile version said, as the conversion needs it. */
export type ProfileValues = {
  name: string;
  version: number;
  description: string;
  model: ModelChoice;
  instructions: string;
  canPush: boolean;
  /** The JSON text of the default result schema, or null. */
  defaultResult: string | null;
  harness: string;
  /** The environment the version runs in; null for a version saved before profiles had one. */
  environmentId: string | null;
};

export type ProfileLookup =
  | { kind: "found"; profile: ProfileValues }
  | { kind: "archived" | "missing" | "version_missing" };

/** An environment of the workspace, as the conversion needs it. */
export type EnvironmentValues = {
  id: string;
  name: string;
  kind: "hosted" | "runner";
  vcpus: number | null;
  setupScript: string;
  labels: readonly string[];
  network: { mode: "off" | "list" | "open"; hosts: readonly string[] };
};

export type HostedRunnerValues = { id: string; name: string; vcpus: number };
export type SelfHostedRunnerValues = {
  id: string;
  name: string;
  labels: readonly string[];
};

/** What the conversion asks of the world. Plain functions, so the rules are tested without a database. */
export type ConversionWorld = {
  /** The profile a reference names: the newest version for a bare name, else the version pinned. */
  profile(name: string, version: number | undefined): Promise<ProfileLookup>;
  /** The environment with that id, or the one with that name (case ignored); undefined when there is none. */
  environment(by: {
    id?: string;
    name?: string;
  }): Promise<EnvironmentValues | undefined>;
  hostedRunners(): readonly HostedRunnerValues[];
  /** The self-hosted runners that are not revoked. */
  selfHostedRunners(): readonly SelfHostedRunnerValues[];
};

/** What happened to one lane. */
export const LANE_OUTCOMES = [
  /** A new version with the values inline was saved. */
  "converted",
  /** Dry run: the document converts and passes the validator; nothing was saved. */
  "would_convert",
  /** No step names a profile or an environment: nothing to do (also what a lane converted before reads). */
  "already_inline",
  /** The lane is on the list of release A: it keeps its version. */
  "not_converted",
  /** Not archived and no project: archived. */
  "archived_without_project",
  /** Dry run: the lane would be archived. */
  "would_archive_without_project",
  /** The lane was deleted or archived by somebody between the moment the run listed it and the moment it was looked at. Nothing was done. */
  "lane_gone",
] as const;
export type LaneOutcome = (typeof LANE_OUTCOMES)[number];

/** A note on a lane that does not keep it from being converted or archived but that the operator should read. */
export const LANE_WARNING_CODES = [
  /**
   * The model of a step the conversion wrote (it came from the profile) was **not** checked against the workspace's model rule
   * (`model_not_allowed`, the rule of a save): the check needs the workspace's keys and the catalog entitlements, which a script run with
   * the migrate URL cannot read without decrypting the keys. The next save of the lane by the app may refuse the model.
   */
  "model_unchecked",
  /** The lane has no project and was archived (or would be): a trigger or an MCP assignment that still points at it no longer runs it. */
  "archived_without_project",
] as const;
export type LaneWarningCode = (typeof LANE_WARNING_CODES)[number];

export type LaneWarning = {
  code: LaneWarningCode;
  /** The step the warning is about; left out for a warning about the lane. */
  stepId?: string;
  /** In a sentence. Never a secret: a model is named by its provider and model id, or by the id of the catalog entry. */
  message: string;
};

export type LaneReportEntry = {
  workspaceId: string;
  laneId: string;
  laneName: string;
  projectId: string | null;
  outcome: LaneOutcome;
  /** `converted`: the version saved; `would_convert`: the version a run would save. */
  version?: number;
  /** How many agent steps were written inline (`converted`, `would_convert`). */
  steps?: number;
  reasons: ConversionReason[];
  /** Notes that do not stop the lane from being converted or archived (`converted`, `would_convert`, the archived lanes). */
  warnings: LaneWarning[];
};

/** A workspace the run could not read or finish (a failure outside the handling of one lane). It is on the list: run again. */
export type WorkspaceFailure = {
  workspaceId: string;
  /** The database error code or the error's name, never its text (it could carry a connection string). */
  code: string;
  message: string;
};

/** What the run covered: the whole instance, or the one workspace `--workspace` named. Only the first can say "the list is empty". */
export type ReportScope =
  { kind: "all" } | { kind: "workspace"; workspaceId: string };

export type LaneConversionReport = {
  dryRun: boolean;
  scope: ReportScope;
  /**
   * False when the run ended early (an error outside the handling of a workspace, or the lock was lost): what is in the report is what
   * was done up to then, and the lanes of the workspaces that were not reached are not in it.
   */
  complete: boolean;
  /** Why the run ended early, when it did. */
  aborted?: { code: string; message: string };
  /** The workspaces the run was asked to cover, and how many of them it reached. */
  workspaces: number;
  workspacesReached: number;
  workspaceFailures: WorkspaceFailure[];
  /** Every lane that is not archived and was looked at, in the order of the workspaces. */
  lanes: LaneReportEntry[];
  /**
   * The list of release A (ADR 0007, "Migration path"): the lanes that still hold a profile or an environment and could not be converted.
   * Release B ships when it is empty.
   */
  notConverted: LaneReportEntry[];
  /** Lanes without a project that were archived (or, in a dry run, would be). */
  archivedWithoutProject: LaneReportEntry[];
  /** The lanes that carry a warning, converted or not. */
  warned: LaneReportEntry[];
  /** The lanes that disappeared while the run was going. */
  gone: LaneReportEntry[];
  counts: Record<LaneOutcome, number>;
};
