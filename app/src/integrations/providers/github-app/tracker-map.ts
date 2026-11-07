// SPDX-License-Identifier: LicenseRef-Proprietary

// Turns GitHub's issue and pull request JSON (the REST answers and the `issue` and `pull_request` objects of the webhooks, which have one
// shape) into the `TrackerItemFields` of the ticket mirror (#923), and the check suites of a commit into one state. Nothing is mapped to a
// vocabulary of our own: the state, the reason and the type are GitHub's words. Returns null for an object that lacks what the mirror
// needs, so the caller can report an unexpected answer instead of caching garbage.
import { isRecord } from "./guards.ts";
import { TRACKER_EXCERPT_CHARS, type TrackerItemFields } from "../../types.ts";

const TITLE_MAX_CHARS = 1000;
const LABELS_MAX = 100;
const ASSIGNEES_MAX = 20;
/** GitHub's own limit on the issues one pull request closes is far below this; the cap keeps a crafted description bounded. */
const CLOSES_MAX = 50;

function cut(text: string, max: number): string {
  const characters = Array.from(text);
  return characters.length <= max ? text : characters.slice(0, max).join("");
}

// GitHub's keywords that close an issue when a pull request with them merges: close(s/d), fix(es/ed), resolve(s/d), then `#12` or
// `owner/repo#12`. A reference to another repository is not counted: the mirror holds one repository's tickets.
const CLOSING =
  /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b:?[ \t]+((?:[\w.-]+\/[\w.-]+)?#\d+)/gi;

/** The issues of `repoFullName` a pull request description closes, ascending, without duplicates. */
export function closedIssueNumbers(
  body: string,
  repoFullName: string,
): number[] {
  const numbers = new Set<number>();
  for (const match of body.matchAll(CLOSING)) {
    const reference = match[1] as string;
    const hash = reference.indexOf("#");
    const owner = reference.slice(0, hash);
    if (owner !== "" && owner.toLowerCase() !== repoFullName.toLowerCase())
      continue;
    numbers.add(Number(reference.slice(hash + 1)));
    if (numbers.size >= CLOSES_MAX) break;
  }
  return [...numbers].sort((a, b) => a - b);
}

/** The number at the end of the API address of an issue of `repoFullName`; null for another repository or no issue address. */
function sameRepositoryIssue(url: string, repoFullName: string): number | null {
  const match = /\/repos\/([^/]+\/[^/]+)\/issues\/(\d+)$/.exec(url);
  if (match === null) return null;
  return (match[1] as string).toLowerCase() === repoFullName.toLowerCase()
    ? Number(match[2])
    : null;
}

type ItemOptions = {
  /** The object is a pull request itself (a `pull_request` webhook), not an issue that may be one (`pull_request` key). */
  pullRequest?: boolean;
};

export function toTrackerItem(
  json: unknown,
  repoFullName: string,
  options: ItemOptions = {},
): TrackerItemFields | null {
  if (!isRecord(json)) return null;
  if (
    typeof json.number !== "number" ||
    !Number.isInteger(json.number) ||
    json.number < 1 ||
    typeof json.node_id !== "string" ||
    json.node_id === "" ||
    typeof json.title !== "string" ||
    typeof json.updated_at !== "string" ||
    Number.isNaN(Date.parse(json.updated_at)) ||
    (json.state !== "open" && json.state !== "closed")
  )
    return null;

  const isPullRequest =
    options.pullRequest === true || isRecord(json.pull_request);
  const nested = isRecord(json.pull_request) ? json.pull_request : {};
  const merged =
    isPullRequest &&
    (json.merged === true ||
      typeof json.merged_at === "string" ||
      typeof nested.merged_at === "string");
  const body = typeof json.body === "string" ? json.body : "";

  const labels = Array.isArray(json.labels)
    ? json.labels.flatMap((label: unknown) =>
        isRecord(label) && typeof label.name === "string" && label.name !== ""
          ? [
              {
                name: cut(label.name, 100),
                color: typeof label.color === "string" ? label.color : "",
              },
            ]
          : [],
      )
    : [];
  const assignees = Array.isArray(json.assignees)
    ? json.assignees.flatMap((user: unknown) =>
        isRecord(user) && typeof user.login === "string" && user.login !== ""
          ? [{ login: user.login }]
          : [],
      )
    : [];

  const type =
    isRecord(json.type) && typeof json.type.name === "string"
      ? json.type.name
      : null;
  const stateReason = merged
    ? "merged"
    : typeof json.state_reason === "string"
      ? json.state_reason
      : null;

  let parentNumber: number | null | undefined;
  if (!isPullRequest && "parent_issue_url" in json)
    parentNumber =
      typeof json.parent_issue_url === "string"
        ? sameRepositoryIssue(json.parent_issue_url, repoFullName)
        : null;

  return {
    number: json.number,
    nodeId: json.node_id,
    kind: isPullRequest ? "pull_request" : "issue",
    state: json.state,
    stateReason,
    type: isPullRequest ? null : type,
    title: cut(json.title, TITLE_MAX_CHARS),
    bodyExcerpt: cut(body, TRACKER_EXCERPT_CHARS),
    labels: labels.slice(0, LABELS_MAX),
    assignees: assignees.slice(0, ASSIGNEES_MAX),
    ...(parentNumber === undefined ? {} : { parentNumber }),
    closes: isPullRequest ? closedIssueNumbers(body, repoFullName) : [],
    updatedAt: new Date(Date.parse(json.updated_at)).toISOString(),
  };
}

/** A check suite as far as the state of a commit needs it. */
export type CheckSuiteFacts = { status: string; conclusion: string | null };

// The conclusions that mean "something is wrong", worst first: one of them decides the state of the commit.
const BAD_CONCLUSIONS = [
  "failure",
  "timed_out",
  "startup_failure",
  "action_required",
  "cancelled",
  "stale",
] as const;

/**
 * The state of the checks of one commit, in GitHub's own words, from its check suites: a suite that went wrong decides (the worst
 * conclusion above), else a suite that is not done (`in_progress`, `queued`), else `success` when one succeeded, else the first
 * conclusion that is left (`neutral`, `skipped`). Null when the commit has no check suite. The same rule serves the webhook and the
 * full sync, so a rebuilt cache holds what the webhooks wrote.
 */
export function checksStateOf(
  suites: readonly CheckSuiteFacts[],
): string | null {
  if (suites.length === 0) return null;
  for (const bad of BAD_CONCLUSIONS)
    if (
      suites.some(
        (suite) => suite.status === "completed" && suite.conclusion === bad,
      )
    )
      return bad;
  const open = suites.filter((suite) => suite.status !== "completed");
  if (open.length > 0)
    return open.some((suite) => suite.status === "in_progress")
      ? "in_progress"
      : "queued";
  if (suites.some((suite) => suite.conclusion === "success")) return "success";
  return suites.find((suite) => suite.conclusion !== null)?.conclusion ?? null;
}

/** The suites of `GET /repos/{owner}/{repo}/commits/{ref}/check-suites`; null for an answer that is not that. */
export function toCheckSuites(json: unknown): CheckSuiteFacts[] | null {
  if (!isRecord(json) || !Array.isArray(json.check_suites)) return null;
  const suites: CheckSuiteFacts[] = [];
  for (const suite of json.check_suites as unknown[]) {
    if (!isRecord(suite) || typeof suite.status !== "string") return null;
    suites.push({
      status: suite.status,
      conclusion:
        typeof suite.conclusion === "string" ? suite.conclusion : null,
    });
  }
  return suites;
}
