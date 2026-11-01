// SPDX-License-Identifier: LicenseRef-Proprietary

// The copy for the codes of the binding (the UI translates a code to copy, never the other way round): what
// the connections page and the result page say after a flow, what a failed call says, and how the approval
// page words the evidence. Nothing here names another workspace, a token or an address of GitHub.
import type { ProductIdentity } from "../../product-identity/identity.ts";
import {
  describeTransportFailure,
  GENERIC_FAILURE,
} from "../../ui/transport-messages.ts";
import { GITHUB_NOT_CONFIGURED_COPY } from "../../config-status/notices.ts";
import { ROLE_NOT_ALLOWED } from "../../copy/messages.ts";
import type { BindingResultCode } from "../errors.ts";
import type { ConnectAvailability } from "../service.ts";
import type { RoleResult } from "../../db/installation-link-request.ts";

export type ResultTone = "success" | "info" | "error";

export const resultCopy = (
  product: ProductIdentity,
): Record<BindingResultCode, { tone: ResultTone; text: string }> => ({
  linked: {
    tone: "success",
    text: `GitHub is connected. The repositories of the installation are listed under ${product.qaAreaName}.`,
  },
  picker_ready: {
    tone: "info",
    text: "Choose the installation to connect.",
  },
  waiting_for_github_approval: {
    tone: "info",
    text: "GitHub asked the owners of the account to approve the installation. Nothing is connected yet. Once they have approved, use Link an existing installation.",
  },
  waiting_for_instance_admin: {
    tone: "info",
    text: `Nothing is connected yet. GitHub did not let the app check your role in the organization, so a ${product.name} admin has to approve the connection. You will see the decision below.`,
  },
  state_invalid: {
    tone: "error",
    text: "That link is no longer valid (it may have expired or been used already). Start again with Connect GitHub.",
  },
  workspace_role_required: {
    tone: "error",
    text: "Only an Owner or Admin of the workspace can connect GitHub.",
  },
  github_app_not_configured: {
    tone: "error",
    text: GITHUB_NOT_CONFIGURED_COPY,
  },
  user_authorization_not_configured: {
    tone: "error",
    text: `Connecting GitHub is not available yet: a ${product.name} admin has to finish setting up the GitHub App (its sign in with GitHub).`,
  },
  access_denied: {
    tone: "error",
    text: "You did not authorize the app at GitHub, so nothing was connected.",
  },
  github_authorization_required: {
    tone: "error",
    text: "GitHub did not accept your authorization. Authorize again with Connect GitHub.",
  },
  github_unreachable: {
    tone: "error",
    text: "GitHub could not be reached or answered something unexpected. Nothing was connected. Try again in a moment.",
  },
  installation_id_invalid: {
    tone: "error",
    text: "GitHub did not say which installation to connect. Start again with Connect GitHub.",
  },
  installation_not_accessible: {
    tone: "error",
    text: `That installation is not one ${product.name} can connect for you: your GitHub account cannot use it, or ${product.name} has not heard of it yet. If it was installed just now, wait a moment and try again.`,
  },
  not_installation_admin: {
    tone: "error",
    text: "Only the owner of a personal account, or an owner of the organization, can connect its installation. Ask an owner of the organization to connect it.",
  },
  installation_already_linked: {
    tone: "error",
    text: "That installation is connected already and cannot be connected here.",
  },
  identity_belongs_to_other_user: {
    tone: "error",
    text: "That GitHub account belongs to another user.",
  },
  github_identity_mismatch: {
    tone: "error",
    text: "You have linked another GitHub account to your account than the one that authorized. Authorize with the account you linked.",
  },
  picker_invalid: {
    tone: "error",
    text: "That choice is no longer in the list. Open the list again.",
  },
  integration_not_found: {
    tone: "error",
    text: "That connection does not exist in this workspace.",
  },
  rate_limited: {
    tone: "error",
    text: "Too many attempts. Wait a few minutes and try again.",
  },
  unavailable: {
    tone: "error",
    text: "Something went wrong and nothing was connected. Try again.",
  },
});

export const availabilityCopy = (
  product: ProductIdentity,
): Record<Exclude<ConnectAvailability, "available">, string> => ({
  app_not_configured: GITHUB_NOT_CONFIGURED_COPY,
  user_authorization_not_configured: `Connecting GitHub is not available yet. A ${product.name} admin sets up the sign in with GitHub of the GitHub App in the admin portal.`,
  needs_approval: `${product.name} cannot check your rights on GitHub, so a ${product.name} admin approves every connection. Connect GitHub sends the request.`,
});

/** The "how it works" text of the Connect card, behind its disclosure (#176). */
export const CONNECT_HELP_COPY =
  "You connect an installation of the GitHub App if you own the account it is on: a personal account, or an organization you are an owner of. GitHub asks you to authorize the app, which proves that.";

export function describeResultCode(
  product: ProductIdentity,
  code: string,
): {
  tone: ResultTone;
  text: string;
} | null {
  const copy = resultCopy(product);
  return Object.hasOwn(copy, code) ? copy[code as BindingResultCode] : null;
}

/** The sentence for a failed call of the page (a code of the routes, or a transport failure). */
export function describeBindingFailure(
  product: ProductIdentity,
  code: string,
): string {
  return (
    describeResultCode(product, code)?.text ??
    describeTransportFailure(product, code) ??
    (code === "forbidden" ? ROLE_NOT_ALLOWED : GENERIC_FAILURE)
  );
}

export const ROLE_RESULT_COPY: Record<RoleResult, string> = {
  admin: "Owner of the account",
  member: "Member of the organization, not an owner",
  not_a_member: "Not a member of the organization",
  unreadable: "Could not be read",
  unavailable: "Was not asked (the app cannot check anyone's rights)",
};

const ROLE_DETAIL_COPY: Record<string, string> = {
  forbidden:
    "GitHub refused: the app probably lacks the organization permission Members",
  unexpected: "GitHub answered something the app cannot read",
  user_authorization_not_configured:
    "the GitHub App has no sign in with GitHub configured",
};

export function describeRoleDetail(detail: string | null): string | null {
  if (detail === null) return null;
  return ROLE_DETAIL_COPY[detail] ?? null;
}

/** How the decision on a request is told to the people who asked. */
export const requestStatusCopy = (product: ProductIdentity) =>
  ({
    pending: `Waiting for a ${product.name} admin`,
    approved: "Approved",
    denied: `Denied by a ${product.name} admin`,
    withdrawn: "Connected in the meantime",
  }) as const;

export const APPROVAL_FAILURE_COPY: Record<string, string> = {
  request_not_found: "That request does not exist any more.",
  request_not_pending: "That request was decided already. Reload the page.",
  requester_not_admin:
    "The person who asked is not an Owner or Admin of the workspace any more. Deny the request.",
  installation_already_linked:
    "That installation is connected to a workspace already. The request was closed.",
  installation_not_accessible:
    "GitHub does not know that installation any more. Deny the request.",
  github_unreachable: "GitHub could not be reached. Try again in a moment.",
  unavailable: "Something went wrong. Try again.",
};

export function describeApprovalFailure(
  product: ProductIdentity,
  code: string,
): string {
  return (
    APPROVAL_FAILURE_COPY[code] ??
    describeTransportFailure(product, code) ??
    GENERIC_FAILURE
  );
}

/** Using an installation is not administering its account: outside collaborators can use it too. */
export const TOKEN_CAN_ACCESS_COPY =
  "Yes (outside collaborators can use an installation too, so this alone does not show that they administer the account)";
