// SPDX-License-Identifier: LicenseRef-Proprietary

// The copy of the runners page (#854). The routes answer with stable codes; this is where a code becomes a sentence (the UI translates
// codes, never the other way round). Nothing a response carried is put into a sentence except the one number it names (the maximum).
// `messages.test.ts` fails for a code of the routes without a sentence of its own.
import { CROSS_SITE_REQUEST_RELOAD_PAGE } from "../../copy/messages.ts";
import type { ProductIdentity } from "../../product-identity/identity.ts";
import {
  describeTransportFailure,
  GENERIC_FAILURE,
} from "../../ui/transport-messages.ts";
import {
  RUNNER_FLEET_ERROR_CODES,
  type RunnerFleetErrorCode,
} from "../errors.ts";
import type { RunnerStatus } from "../service.ts";

export const PAGE_COPY = {
  title: "Runners",
  description:
    "Machines of your own that take the jobs of this workspace. A runner connects from your network; nothing reaches it from outside.",
  loading: "Loading",
  tryAgain: "Try again",
  empty: "No runner yet. Owners and Admins can add one.",
  addRunner: "Add a runner",
  tokenTitle: "Registration token",
  tokenNote:
    "The token is valid for one hour and works once. It is shown now and not kept: copy the command and run it on the machine.",
  tokenCommandLabel: "Command",
  tokenExpires: "Valid until",
  tokenDismiss: "Done",
  revoke: "Revoke",
  revokeTitle: "Revoke this runner?",
  revokeNote:
    "It stops getting jobs at once and cannot connect again. A job it is running is not taken from it, but it can no longer report the result.",
  revokeConfirm: "Revoke",
  cancel: "Cancel",
  revoked: "The runner was revoked.",
  labels: "Labels",
  noLabels: "No labels",
  base: "Base",
  harnesses: "Harnesses",
  noHarnesses: "None announced",
  capabilities: "Capabilities",
  lastSeen: "Last seen",
  minimum: (version: string) =>
    `Runners older than base ${version} get no jobs until they are updated.`,
  ready: "ready",
  notReady: "not ready",
} as const;

export const STATUS_COPY: Record<RunnerStatus, string> = {
  online: "Online",
  update_needed: "Update needed",
  offline: "Offline",
};

/** The command that registers a runner with a token. */
export function registerCommand(token: string): string {
  return `factory-runner register --token ${token}`;
}

export type RunnerFleetFailure = {
  code: string;
  status?: number | null;
  /** On `RUNNER_FLEET_TOKEN_LIMIT_REACHED`: how many unused tokens a workspace may hold. */
  maximum?: unknown;
};

const failureCopy = (
  failure: RunnerFleetFailure,
): Record<RunnerFleetErrorCode, string> => ({
  RUNNER_FLEET_CROSS_SITE_REQUEST: CROSS_SITE_REQUEST_RELOAD_PAGE,
  RUNNER_FLEET_NOT_FOUND:
    "This runner does not exist any more, or it was revoked already. Reload the page.",
  RUNNER_FLEET_TOKEN_LIMIT_REACHED:
    typeof failure.maximum === "number" && Number.isFinite(failure.maximum)
      ? `The workspace holds ${failure.maximum} registration tokens that nobody used yet. Use one, or wait an hour for them to run out.`
      : "The workspace holds as many unused registration tokens as it may. Use one, or wait an hour for them to run out.",
});

function hasCopy(code: string): code is RunnerFleetErrorCode {
  return (RUNNER_FLEET_ERROR_CODES as readonly string[]).includes(code);
}

/** The sentence for the code an answer carried (or a transport code). */
export function describeRunnerFleetFailure(
  product: ProductIdentity,
  failure: RunnerFleetFailure,
): string {
  if (hasCopy(failure.code)) return failureCopy(failure)[failure.code];
  return (
    describeTransportFailure(product, failure.code, failure.status) ??
    GENERIC_FAILURE
  );
}
