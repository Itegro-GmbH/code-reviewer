// SPDX-License-Identifier: LicenseRef-Proprietary

// The copy of the environments page (#818). The routes answer with stable codes; this is where a code becomes a sentence (the UI
// translates codes, never the other way round). Nothing a response carried is put into a sentence except the one number it names
// (the maximum). A code this file does not know gets the transport sentence or the generic one; `messages.test.ts` fails for a
// code of the routes without a sentence of its own.
import {
  CROSS_SITE_REQUEST_RELOAD_PAGE,
  INVALID_VALUES,
  REQUEST_NOT_UNDERSTOOD,
} from "../../../copy/messages.ts";
import type { ProductIdentity } from "../../../product-identity/identity.ts";
import {
  describeTransportFailure,
  GENERIC_FAILURE,
} from "../../../ui/transport-messages.ts";
import {
  ENVIRONMENT_ERROR_CODES,
  type EnvironmentErrorCode,
  type EnvironmentIssue,
} from "../errors.ts";
import {
  ENVIRONMENT_NAME_MAX_LENGTH,
  SETUP_SCRIPT_MAX_BYTES,
} from "../limits.ts";

/** The words of the labels, hints and states of the page. */
export const PAGE_COPY = {
  title: "Environments",
  description:
    "A start configuration for an Implementer task: a size and a setup script.",
  empty:
    "No environment yet. A task without one runs on the standard: 2 vCPU, 4 GB, no setup script.",
  emptyMember:
    "No environment yet. A task without one runs on the standard: 2 vCPU, 4 GB, no setup script. Owners and Admins can add environments.",
  newEnvironment: "New environment",
  edit: "Edit",
  delete: "Delete",
  save: "Save",
  saving: "Saving",
  cancel: "Cancel",
  loading: "Loading",
  tryAgain: "Try again",
  name: "Name",
  nameHint: `Up to ${ENVIRONMENT_NAME_MAX_LENGTH} characters. Each name is used once in the workspace.`,
  size: "Size",
  sizeHint: "The size of the VM the task runs in. 2 GB of memory per vCPU.",
  script: "Setup script",
  scriptHint:
    "Setup scripts do not run yet: the text is saved, and a task does nothing with it for now. Once they run, the script will run as root with full internet access, in its own container with no secrets, and the agent will start afterwards with its own restricted network. The text is stored as written and shown to every member. Keep secrets out of it: there is no secrets field.",
  scriptsNotRunning:
    "Setup scripts do not run yet. They are saved with the environment, and nothing is done with them when a task starts.",
  scriptLabelShown: "Setup script",
  noScript: "No setup script",
  saved: "The environment was saved.",
  deleted: "The environment was deleted.",
  deleteTitle: "Delete this environment?",
  deleteConfirm: "Yes, delete it",
  deleteNote:
    "Tasks that started with it keep what they used. This cannot be undone.",
} as const;

const FIELD_COPY: Record<
  EnvironmentIssue["field"],
  Record<EnvironmentIssue["code"], string>
> = {
  name: {
    required: "Give the environment a name.",
    invalid: "A name is one line without control characters.",
    too_long: `A name can have at most ${ENVIRONMENT_NAME_MAX_LENGTH} characters.`,
  },
  vcpus: {
    required: "Choose a size.",
    invalid: "Choose one of the sizes in the list.",
    too_long: "Choose one of the sizes in the list.",
  },
  setupScript: {
    required: "Enter the script or leave the field empty.",
    invalid:
      "The script contains a character that cannot be saved (a NUL byte, or half of a character). Remove it and try again.",
    too_long: `The script is over ${SETUP_SCRIPT_MAX_BYTES / 1024} KB. Shorten it.`,
  },
};

/** The sentence for one issue of a refused body: the field and the code it was refused with. */
export function describeFieldIssue(
  field: EnvironmentIssue["field"],
  code: string,
): string {
  const copy = FIELD_COPY[field];
  return code === "required" || code === "too_long" ? copy[code] : copy.invalid;
}

/** An answer that was not a success, as much of it as a sentence may use. */
export type EnvironmentFailure = {
  code: string;
  status?: number | null;
  /** On `ENVIRONMENT_LIMIT_REACHED`: how many a workspace may hold. */
  maximum?: unknown;
};

const failureCopy = (
  failure: EnvironmentFailure,
): Record<EnvironmentErrorCode, string> => ({
  ENVIRONMENT_REQUEST_INVALID: INVALID_VALUES,
  ENVIRONMENT_CROSS_SITE_REQUEST: CROSS_SITE_REQUEST_RELOAD_PAGE,
  ENVIRONMENT_BODY_TOO_LARGE:
    "The environment is too large to send. Shorten the script and try again.",
  ENVIRONMENT_CONTENT_TYPE_UNSUPPORTED: REQUEST_NOT_UNDERSTOOD,
  ENVIRONMENT_NOT_FOUND:
    "This environment does not exist any more. Reload the page.",
  ENVIRONMENT_NAME_TAKEN:
    "This workspace has an environment with that name already. Choose another name.",
  ENVIRONMENT_LIMIT_REACHED:
    typeof failure.maximum === "number" && Number.isFinite(failure.maximum)
      ? `A workspace can hold ${failure.maximum} environments. Delete one you do not need and try again.`
      : "The workspace holds as many environments as it may. Delete one you do not need and try again.",
});

function hasCopy(code: string): code is EnvironmentErrorCode {
  return (ENVIRONMENT_ERROR_CODES as readonly string[]).includes(code);
}

/** The sentence for the code an answer carried (or a transport code). */
export function describeEnvironmentFailure(
  product: ProductIdentity,
  failure: EnvironmentFailure,
): string {
  if (hasCopy(failure.code)) return failureCopy(failure)[failure.code];
  return (
    describeTransportFailure(product, failure.code, failure.status) ??
    GENERIC_FAILURE
  );
}
