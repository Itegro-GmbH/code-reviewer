// SPDX-License-Identifier: LicenseRef-Proprietary

// The services of the runner tools (#1147): the SAME ones the routes below `/api/w/:workspace/runners` build, and the repository the lane
// validator reads the runners a step may name from (`NamedRunnersRepository`), for the workspace of the token.
import { createNamedRunnersRepository } from "../../../db/repositories/named-runners-repository.ts";
import type { NamedRunnersRepository } from "../../../db/repositories/named-runners-repository.ts";
import type { NamedRunner } from "../../../named-runners/types.ts";
import {
  RunnerFleetError,
  type RunnerFleetErrorCode,
} from "../../../runner-fleet/errors.ts";
import { runnerFleetServiceFor } from "../../../runner-fleet/shared.ts";
import type {
  RunnerFleetService,
  RunnerView,
} from "../../../runner-fleet/service.ts";
import { ToolError, type ToolErrorCode } from "../errors.ts";
import type { ServiceFactory } from "../services.ts";

/** The runner fleet the routes use: the self-hosted runners with their state, registration tokens, revoking and renaming. */
export const runnerFleetService: ServiceFactory<RunnerFleetService> = ({
  access,
}) => runnerFleetServiceFor(access.workspace.id);

/** Every runner a lane step can name: the hosted runners (one for each type of the provided sandbox) and the self-hosted ones. */
export const namedRunnersService: ServiceFactory<NamedRunnersRepository> = ({
  access,
  database,
}) => createNamedRunnersRepository(database(), access.workspace.id);

const CODE_OF: Record<RunnerFleetErrorCode, ToolErrorCode> = {
  RUNNER_FLEET_CROSS_SITE_REQUEST: "internal_error",
  RUNNER_FLEET_NOT_FOUND: "not_found",
  RUNNER_FLEET_TOKEN_LIMIT_REACHED: "limit_reached",
  RUNNER_FLEET_NAME_INVALID: "invalid_input",
  RUNNER_FLEET_NAME_TAKEN: "conflict",
};

/** Runs a call of the runner fleet service and turns its own refusal into the tool's code (the service's code stays in `details.code`). */
export async function fleetService<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (!(error instanceof RunnerFleetError)) throw error;
    const code = CODE_OF[error.code];
    if (code === "internal_error") throw error;
    throw new ToolError(code, error.message, {
      code: error.code,
      ...(error.maximum === undefined ? {} : { maximum: error.maximum }),
    });
  }
}

export const NO_SUCH_RUNNER = "There is no such runner in this workspace.";

/**
 * Where a hosted runner runs. The type of a hosted runner is a size of one provided sandbox; the placement says which provider's. A hosted
 * runner carries its own `placement` (`vercel` or, #1158, `cloudflare`), shown as it is.
 */
export function placementOf(runner: NamedRunner): string {
  return runner.kind === "self_hosted" ? "self_hosted" : runner.placement;
}

/**
 * One runner as the tools answer it. `id` is what a lane step's `runner` field takes (`update_lane`). A hosted runner has a fixed size
 * (`vcpus`) and a `concurrency`, and is `available` (`unavailable` for a Cloudflare size the operator switched off); a self-hosted one has `status` (`online`, `update_needed`, `offline`, or `revoked`),
 * its `labels` and what it was last seen with. `detail` adds the manifest (what the machine announces: harnesses, logins, models).
 */
export function runnerAnswer(
  runner: NamedRunner,
  status: Map<string, RunnerView>,
  detail: boolean,
): Record<string, unknown> {
  if (runner.kind === "hosted")
    return {
      id: runner.id,
      name: runner.name,
      kind: "hosted",
      placement: placementOf(runner),
      vcpus: runner.vcpus,
      concurrency: runner.concurrency,
      // #1158: a Cloudflare size the operator switched off keeps its runner (a lane may name it) but nothing may start on it.
      status: runner.available ? "available" : "unavailable",
    };
  const view = status.get(runner.id);
  return {
    id: runner.id,
    name: runner.name,
    kind: "self_hosted",
    placement: "self_hosted",
    status: runner.revokedAt !== null ? "revoked" : (view?.status ?? "offline"),
    labels: runner.labels,
    baseVersion: runner.baseVersion,
    limits: runner.limits,
    lastSeenAt: runner.lastSeenAt,
    ...(view === undefined ? {} : { createdAt: view.createdAt }),
    ...(runner.revokedAt === null ? {} : { revokedAt: runner.revokedAt }),
    ...(detail ? { manifest: runner.manifest } : {}),
  };
}

/** The state of the self-hosted runners by id, read from the fleet service (the one the runners page reads). */
export async function statusById(
  fleet: RunnerFleetService,
): Promise<Map<string, RunnerView>> {
  return new Map((await fleet.list()).runners.map((r) => [r.id, r]));
}
