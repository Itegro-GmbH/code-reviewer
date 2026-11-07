// SPDX-License-Identifier: LicenseRef-Proprietary

// The words of the Profiles page and its drawer (#925), from the prototype of the factory. A field the profile format has no place for yet
// is shown disabled with a hint that says so: the drawer is the shape the page will have, not a promise the backend keeps today.
import type { ProfileHarness } from "../../runner-identity/harness.ts";

export const PROFILES_COPY = {
  title: "Profiles",
  description:
    "Who works and where: harness, model, key, instructions, rights and the runner. Limits are set per lane.",
  heading: (count: number) => `Profiles · ${String(count)}`,
  columns: {
    profile: "Profile",
    harness: "Harness · model",
    runner: "Runner",
    rights: "Rights",
    used: "Used by",
  },
  emptyTitle: "No profiles yet",
  emptyDescription:
    "A profile is written through the API for now (docs/profiles.md). The profiles of the workspace are listed here.",
  mayPush: "may push",
  readOnly: "read-only",
  hostedSandbox: "Hosted sandbox",
  runnerOwn: "Your runner",
  none: "–",
  version: (version: number) => `v${String(version)}`,
} as const;

export const DRAWER_COPY = {
  kind: (version: number) => `Profile · v${String(version)}`,
  close: "Close",
  loading: "Loading the profile",
  loadFailed: "The profile could not be loaded.",
  tryAgain: "Try again",
  harness: "Harness",
  model: "Model",
  modelHint:
    "The model of a saved version stays as it is. Choosing another one in the page comes later; until then write the profile through the API.",
  key: "API key",
  keyHint:
    "Which key pays for the agent is chosen with the workspace's LLM access and, for Claude Code, the login of the runner. A choice per profile comes later.",
  keyValue: "Set by the workspace",
  instructions: "Instructions",
  runsOn: "Runs on",
  runsOnHint:
    "Opencode runs on the hosted sandbox or a paired runner; Claude Code only on a runner you paired under Runners. A choice per profile comes later.",
  mayPush: "May push branches",
  mayAsk: "May end a turn with a question",
  mayAskHint: "Every profile may ask today; a switch per profile comes later.",
  save: "Save as new version",
  saving: "Saving the new version",
  saved: (version: number) => `Saved as version ${String(version)}.`,
  duplicate: "Duplicate",
  duplicateHint: "Duplicating comes with the lane rework.",
  footnote:
    "Lanes pin a profile version; a new version changes nothing in running lanes.",
  conflict:
    "The profile has a newer version than the one on screen. Close the drawer and open it again.",
  saveFailed:
    "The new version was not saved. Check the instructions and try again.",
} as const;

export const HARNESS_LABEL: Record<ProfileHarness, string> = {
  opencode: "opencode",
  "claude-code": "claude-code · your subscription",
};
