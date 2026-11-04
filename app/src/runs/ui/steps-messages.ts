// SPDX-License-Identifier: LicenseRef-Proprietary

// What the "What the agent did" section says (#745, live view): the headings, the words for the state of a tool call, and the
// notes. The texts of the agent itself (what it thought and said, the input of a tool) are not here: they are rendered as text.
export const STEPS_COPY = {
  title: "What the agent did",
  intro:
    "What the agent thought, said and did, one model call after the other. The output of a tool is not shown here. Everyone in the workspace can read this, and it can include what the agent read in the repository.",
  show: "Show what the agent did",
  follow: "Follow",
  followLabel: "Follow the newest step",
  thinking: "Thinking",
  input: "Input",
  waiting: "Waiting for the first step of the agent.",
  none: "The agent reported no steps for this run.",
  loading: "Loading the steps.",
  failed:
    "Updating the steps failed. This page shows the last steps it got; it keeps trying.",
  failedFirst: "The steps could not be loaded.",
  shortened:
    "The log was shortened: this turn made so many steps that only the name and status of later tool calls are kept.",
  underSecond: "under 1 s",
  stepRunning: "in progress",
  logLabel: "Steps of the agent",
} as const;

/** The state of a tool call in words. */
const TOOL_STATUS_TEXT = new Map<string, string>([
  ["pending", "waiting"],
  ["running", "running"],
  ["completed", "done"],
  ["error", "failed"],
  ["unknown", "unknown"],
]);

/** The words for a state; a state the page does not know is shown as it came, as text (a Map: no property of an object is a state). */
export function toolStatusText(status: string): string {
  return TOOL_STATUS_TEXT.get(status) ?? status;
}

/** "cut, 1,234 bytes": the mark under a text that the runner cut short. */
export function cutText(bytes: number): string {
  return `cut, ${new Intl.NumberFormat("en-US").format(bytes)} bytes`;
}

/** "Show earlier steps (240 hidden)". */
export function earlierText(hidden: number): string {
  return `Show earlier steps (${hidden} hidden)`;
}

/** "Step 3". */
export function stepNumberText(number: number): string {
  return `Step ${number}`;
}
