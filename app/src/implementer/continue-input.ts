// SPDX-License-Identifier: LicenseRef-Proprietary

// Checks the body that continues an Implementer session (#841). Like `start-input.ts` it trusts no type: every field is looked at as
// `unknown`, and a refusal names the field and a code that never holds the value. A field that is LEFT OUT means "as the last turn had
// it"; `null` means "none" (an environment, a profile, a cost limit). The choice itself is the service's.
import type { ModelChoice } from "../db/implementer-model-choice.ts";
import { CLIENT_REQUEST_ID } from "../jobs/job-input.ts";
import { REVIEW_SETTING_LIMITS } from "../review-settings/settings.ts";
import { parseProfileRef } from "../workflows/resolver.ts";
import type { ImplementerIssue } from "./errors.ts";
import {
  INSTRUCTION_MAX_LENGTH,
  readInstruction,
  readModel,
  CONTROL_OR_NEWLINE,
  ID_MAX_LENGTH,
  WORKFLOW_REQUEST_ID_PREFIX,
  type InputTrust,
} from "./start-input.ts";

export type ContinueInput = {
  instruction: string;
  clientRequestId: string;
  /** Undefined: the last turn's model. */
  model: ModelChoice | undefined;
  /** Undefined: the last turn's cost limit; null: none. */
  costLimitCents: number | null | undefined;
  /** Undefined: the copy the last turn made; null: no environment; a string: that environment of the workspace as it is now. */
  environmentId: string | null | undefined;
  /** Undefined: the profile copy the last turn had; null: none; else the name and a version (null: the newest). */
  profile: { name: string; version: number | null } | null | undefined;
};

export type ContinueInputCheck =
  | { ok: true; value: ContinueInput }
  | { ok: false; issues: ImplementerIssue[] };

export { INSTRUCTION_MAX_LENGTH };

export function validateContinueInput(
  body: unknown,
  trust: InputTrust = {},
): ContinueInputCheck {
  const fields: Record<string, unknown> =
    typeof body === "object" && body !== null && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : {};
  const issues: ImplementerIssue[] = [];
  const refuse = (
    field: ImplementerIssue["field"],
    code: ImplementerIssue["code"],
  ) => void issues.push({ field, code });
  const given = (name: string) => name in fields && fields[name] !== undefined;

  const checkedInstruction = readInstruction(fields.instruction);
  if (checkedInstruction !== "ok") refuse("instruction", checkedInstruction);

  let profile: ContinueInput["profile"];
  if (given("profile")) {
    const ref = fields.profile;
    if (ref === null) profile = null;
    else if (typeof ref !== "string") refuse("profile", "invalid");
    else if (ref === "") refuse("profile", "required");
    else {
      const parsed = parseProfileRef(ref);
      if (parsed === undefined) refuse("profile", "invalid");
      else profile = { name: parsed.name, version: parsed.version ?? null };
    }
  }

  let model: ModelChoice | undefined;
  if (given("model")) {
    // A profile brings the model and the cost limit of its version, as for the first turn.
    if (typeof profile === "object" && profile !== null)
      refuse("model", "not_with_profile");
    else {
      model = readModel(fields.model);
      if (model === undefined) refuse("model", "invalid");
    }
  }

  let costLimitCents: ContinueInput["costLimitCents"];
  if (given("costLimitCents")) {
    const cost = fields.costLimitCents;
    if (typeof profile === "object" && profile !== null)
      refuse("costLimitCents", "not_with_profile");
    else if (cost === null) costLimitCents = null;
    else if (
      typeof cost !== "number" ||
      !Number.isSafeInteger(cost) ||
      cost < REVIEW_SETTING_LIMITS.maxCostCents.min ||
      cost > REVIEW_SETTING_LIMITS.maxCostCents.max
    )
      refuse("costLimitCents", "invalid");
    else costLimitCents = cost;
  }

  let environmentId: ContinueInput["environmentId"];
  if (given("environmentId")) {
    const id = fields.environmentId;
    if (id === null) environmentId = null;
    else if (typeof id !== "string") refuse("environmentId", "invalid");
    else if (id === "") refuse("environmentId", "required");
    else if (id.length > ID_MAX_LENGTH || CONTROL_OR_NEWLINE.test(id))
      refuse("environmentId", "invalid");
    else environmentId = id;
  }

  const requestId = fields.clientRequestId;
  if (requestId === undefined || requestId === "")
    refuse("clientRequestId", "required");
  else if (typeof requestId !== "string") refuse("clientRequestId", "invalid");
  else if (requestId.length > 200) refuse("clientRequestId", "too_long");
  else if (!CLIENT_REQUEST_ID.test(requestId))
    refuse("clientRequestId", "invalid");
  else if (
    trust.workflowStep !== true &&
    requestId.startsWith(WORKFLOW_REQUEST_ID_PREFIX)
  )
    refuse("clientRequestId", "request_id_reserved");

  if (issues.length > 0) return { ok: false, issues };
  return {
    ok: true,
    value: {
      instruction: fields.instruction as string,
      clientRequestId: requestId as string,
      model,
      costLimitCents,
      environmentId,
      profile,
    },
  };
}
