// SPDX-License-Identifier: LicenseRef-Proprietary

// How the lane builder groups the values a step can reach (#927): the categories of the picker and the name a chip shows. Pure, and used
// by the server (which sorts the answer into categories) and by the browser (which shows a reference it finds in a text as a chip), so
// the two never disagree about where a value belongs.
export const REACH_CATEGORIES = [
  "ticket",
  "input",
  "steps",
  "loop",
  "run",
  "failure",
] as const;
export type ReachCategory = (typeof REACH_CATEGORIES)[number];

export const REACH_CATEGORY_LABEL: Record<ReachCategory, string> = {
  ticket: "Ticket",
  input: "Trigger input",
  steps: "Steps before",
  loop: "This loop",
  run: "Lane and run",
  failure: "Failure",
};

/** The roots under `trigger` that are about the ticket: `ticket`, and `issue` and `repo` as lanes written before #916 read them. */
const TICKET_FIELDS: readonly string[] = ["ticket", "issue", "repo"];

/** The category of a reference by its path (`["trigger", "ticket", "title"]`): where the picker lists it and what its chip says. */
export function categoryOfPath(path: readonly string[]): ReachCategory {
  const [root, field] = path;
  if (root === "previous") return "loop";
  if (root === "failure") return "failure";
  if (root !== "trigger") return "steps";
  if (field === "input") return "input";
  return field !== undefined && TICKET_FIELDS.includes(field)
    ? "ticket"
    : "run";
}

/**
 * What a chip or a row of the picker calls a value, without the category it is shown under: `title` for `trigger.ticket.title`,
 * `ticket` for the ticket itself, `reason` for `trigger.input.reason`, `review.findings` for a step.
 */
export function nameOfPath(path: readonly string[]): string {
  const category = categoryOfPath(path);
  const [, field, ...rest] = path;
  switch (category) {
    case "ticket":
      return field === "ticket" && rest.length > 0
        ? rest.join(".")
        : path.slice(1).join(".");
    case "input":
      return rest.length > 0 ? rest.join(".") : "input";
    case "run":
      return path.slice(1).join(".");
    case "loop":
    case "failure":
      return path.slice(1).join(".");
    case "steps":
      return path.join(".");
  }
}
