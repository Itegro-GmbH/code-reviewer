// SPDX-License-Identifier: LicenseRef-Proprietary

// The words of the Profiles page and its drawer (#925), from the prototype of the factory. A field the profile format has no place for yet
// is shown disabled with a hint that says so: the drawer is the shape the page will have, not a promise the backend keeps today. Where a
// profile runs is the profile's own field (#919), an environment of the workspace; the key is read from the model.
import type { ProfileHarness } from "../../runner-identity/harness.ts";

export const PROFILES_COPY = {
  title: "Profiles",
  description:
    "Who works and where: harness, model, key, instructions, rights and the runner. Limits are set per lane.",
  heading: (count: number) => `Profiles · ${String(count)}`,
  columns: {
    profile: "Profile",
    harness: "Harness · model",
    runner: "Runs on",
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
  noEnvironment: "Not set",
  environmentGone: "Environment removed – choose another",
  noEnvironmentHint: "Saved before profiles had an environment",
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
    "The key follows the model: a managed model runs on the platform's key, a model of your own key on the key of the workspace's LLM access, Claude Code on the login of the runner.",
  keyManaged: "Platform key (managed model)",
  keyOwn: (provider: string) => `Your own key · ${provider}`,
  keyRunnerLogin: "Login of the runner (your subscription)",
  instructions: "Instructions",
  runsOn: "Runs on",
  runsOnHint:
    "An environment of the workspace: a hosted sandbox or a runner you paired under Runners. Claude Code runs only on a runner, and a runner works with your own key.",
  runsOnNone: "Choose an environment",
  runsOnKind: (kind: "hosted" | "runner") =>
    kind === "runner" ? "runner" : "hosted",
  runsOnRequired:
    "This version was saved before profiles had an environment. Choose one to save a new version.",
  runsOnGone: "Environment removed – choose another",
  runsOnNeedsRunnerAndOwnKey:
    "This harness needs your own runner and your own key; the model is managed — change the model through the API until the model picker is enabled.",
  runsOnNeedsRunner:
    "This harness runs only on a runner. Choose an environment that runs on a runner.",
  runsOnNeedsOwnKey:
    "A runner works with your own key, and the model of this profile is a managed one. Choose a hosted environment.",
  noEnvironments:
    "The workspace has no environment yet. Create one under Environments first.",
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
