// SPDX-License-Identifier: LicenseRef-Proprietary

// The triggers of format v1 (#833) and what each one hands to the first step: `{{trigger.<field>}}`.
import type { ResultSchema } from "./result-schema.ts";
import { objectTypeOf } from "./result-schema.ts";
import {
  NUMBER,
  STRING,
  listOf,
  objectOf,
  type ObjectType,
} from "./value-type.ts";

export const TRIGGER_KINDS = ["manual", "github.issueLabeled"] as const;
export type TriggerKind = (typeof TRIGGER_KINDS)[number];

/** The keys of the trigger node, besides `kind`. */
export const TRIGGER_FIELDS: Record<TriggerKind, readonly string[]> = {
  manual: ["input"],
  "github.issueLabeled": ["label"],
};

const ISSUE = objectOf({
  number: NUMBER,
  title: STRING,
  body: STRING,
  url: STRING,
  labels: listOf(STRING),
});

const REPO = objectOf({
  fullName: STRING,
  owner: STRING,
  name: STRING,
  defaultBranch: STRING,
});

/** The event of a trigger as a value: manual hands in what its `input` schema declares, an issue label hands the issue and the repository. */
export function triggerOutput(
  kind: TriggerKind,
  input: ResultSchema | undefined,
): ObjectType {
  if (kind === "github.issueLabeled")
    return objectOf({ issue: ISSUE, repo: REPO });
  const fields = input === undefined ? objectOf({}) : objectTypeOf(input);
  return {
    kind: "object",
    fields: { input: { type: fields, required: true } },
  };
}
