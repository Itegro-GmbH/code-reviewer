// SPDX-License-Identifier: LicenseRef-Proprietary

// The copy for the codes of the routes of the Claude Code OAuth token (the UI translates a code to copy, never the other way round). No
// sentence here contains a value.
import type { ProductIdentity } from "../../product-identity/identity.ts";
import { NOT_AVAILABLE_TO_YOU } from "../../copy/messages.ts";
import {
  describeTransportFailure,
  GENERIC_FAILURE,
} from "../../ui/transport-messages.ts";
import type { ClaudeCodeTokenIssueCode } from "../claude-code-token.ts";

const ISSUE_COPY: Record<ClaudeCodeTokenIssueCode, string> = {
  token_invalid:
    "That does not look like a Claude Code token: it is one line of printable characters without spaces, at most 4096. Copy it again from the output of `claude setup-token`.",
  token_required: "Enter the token. There is no saved token to keep.",
};

export function describeClaudeCodeTokenIssue(code: string): string {
  return Object.hasOwn(ISSUE_COPY, code)
    ? ISSUE_COPY[code as ClaudeCodeTokenIssueCode]
    : GENERIC_FAILURE;
}

const FAILURE_COPY: Record<string, string> = {
  forbidden:
    "Only an Admin or an Owner of this workspace can change the token.",
  not_found: NOT_AVAILABLE_TO_YOU,
  cross_site_request:
    "The request did not come from this page. Reload it and try again.",
  unsupported_content_type: GENERIC_FAILURE,
  body_too_large: "That is far too long for a token.",
  invalid_input: "The token could not be saved. Check the field.",
};

export function describeClaudeCodeTokenFailure(
  product: ProductIdentity,
  code: string,
): string {
  return (
    describeTransportFailure(product, code) ??
    FAILURE_COPY[code] ??
    GENERIC_FAILURE
  );
}
