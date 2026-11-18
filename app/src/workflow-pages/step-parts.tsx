// SPDX-License-Identifier: LicenseRef-Proprietary

// The small pieces that tell one step run, shared by the step panel and by the plain list of steps (#873, #1079): a time, a link to GitHub
// that was checked, what a step cost with where the figure comes from, and what a step returned. Everything that came from outside (the
// values an agent returned, what an action got from GitHub) is rendered as text, and a link is made only through `github-link.ts`.
import type { ReactNode } from "react";
import { InfoHint } from "../components/info-hint.tsx";
import { formatUtc } from "../ui/format-time.ts";
import type { StepView } from "../workflow-runs/service.ts";
import {
  costBasisCopy,
  COST_COPY,
  CONTROL_COPY,
  COST_NOT_RUN_COPY,
  PAGE_COPY,
} from "./messages.ts";
import {
  actionResultOf,
  agentResultOf,
  controlResultOf,
  formatUsd,
  neverRan,
} from "./view.ts";

export function Time({ iso }: { iso: string | null }) {
  if (iso === null)
    return (
      <span className="text-muted-foreground">{PAGE_COPY.stepNotStarted}</span>
    );
  return <time dateTime={iso}>{formatUtc(iso)}</time>;
}

/** A link to GitHub that the view checked, or the text alone. The text is from outside and stays text. */
export function GithubLink({
  href,
  children,
}: {
  href: string | undefined;
  children: ReactNode;
}) {
  return href === undefined ? (
    <span className="break-all">{children}</span>
  ) : (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="break-all"
    >
      {children}
    </a>
  );
}

function CostBasisText({
  basis,
}: {
  basis: NonNullable<StepView["costBasis"]>;
}) {
  const copy = costBasisCopy(basis);
  return (
    <span className="inline-flex items-center gap-1">
      <span data-slot="cost-basis" data-basis={basis}>
        {copy.label}
      </span>
      <InfoHint label={`About the cost basis ${copy.label}`}>
        {copy.explanation}
      </InfoHint>
    </span>
  );
}

/** The cost of a step that no runner took: it never ran, so the basis of a figure does not apply. */
function NotRunText() {
  return (
    <span className="inline-flex items-center gap-1">
      <span data-slot="cost-basis" data-basis="not_run">
        {COST_NOT_RUN_COPY.label}
      </span>
      <InfoHint
        label={`About the cost of a step that ${COST_NOT_RUN_COPY.label}`}
      >
        {COST_NOT_RUN_COPY.explanation}
      </InfoHint>
    </span>
  );
}

/**
 * What a step cost, after the duration. A subscription turn (#856) was not billed: its figure is an estimate at API prices and reads
 * "≈ $0.42 through a subscription", or "no estimate, through a subscription" when Claude Code gave none (booked as 0). Any other
 * figure is "Cost $0.42 (reported)".
 */
export function StepCost({
  step,
  costUsd,
}: {
  step: StepView;
  costUsd: number;
}) {
  return (
    <>
      {" · "}
      {COST_COPY.stepCost} <StepCostText step={step} costUsd={costUsd} />
    </>
  );
}

/** The figure of a step's cost with where it comes from, without the word "Cost": for a place that has its own label. */
export function StepCostText({
  step,
  costUsd,
}: {
  step: StepView;
  costUsd: number;
}) {
  if (step.costBasis === "subscription") {
    return (
      <>
        <span data-slot="step-cost">
          {costUsd === 0
            ? COST_COPY.noEstimate
            : `${COST_COPY.approximately} ${formatUsd(costUsd)}`}
        </span>{" "}
        <CostBasisText basis="subscription" />
      </>
    );
  }
  return (
    <>
      <span data-slot="step-cost">{formatUsd(costUsd)}</span>
      {step.costBasis === null ? null : (
        <>
          {" ("}
          {neverRan(step) ? (
            <NotRunText />
          ) : (
            <CostBasisText basis={step.costBasis} />
          )}
          {")"}
        </>
      )}
    </>
  );
}

/** What an action step returned: the link, the number, whether it existed before. */
function ActionOutcome({
  step,
  repository,
}: {
  step: StepView;
  repository: string | undefined;
}) {
  const result = actionResultOf(step, repository);
  if (result === undefined) return null;
  return (
    <div data-slot="step-action-result" className="flex flex-col gap-1 text-sm">
      {result.pullRequests === undefined ? null : (
        <div data-slot="step-pull-requests" className="flex flex-col gap-1">
          <p className="font-semibold">{PAGE_COPY.stepPullRequests}</p>
          <ul className="flex flex-col gap-2">
            {result.pullRequests.map((pr) => (
              <li
                key={pr.fullName}
                data-state={pr.state}
                className="break-words"
              >
                <span>{pr.fullName}</span>{" "}
                {pr.state === "skipped" ? (
                  <span className="text-muted-foreground">
                    {PAGE_COPY.stepPrSkipped}
                    {pr.reason === undefined
                      ? ""
                      : `: ${PAGE_COPY.stepPrReason[pr.reason]}`}
                  </span>
                ) : (
                  <>
                    <GithubLink href={pr.url}>
                      {pr.number === undefined ? "" : `#${String(pr.number)}`}
                    </GithubLink>{" "}
                    <span className="text-muted-foreground">
                      {pr.state === "existing"
                        ? PAGE_COPY.stepPrExisting
                        : PAGE_COPY.stepPrOpened}
                    </span>
                  </>
                )}
                <span className="block text-xs text-muted-foreground">
                  {pr.head} → {pr.base}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {result.url === undefined && result.urlText === undefined ? null : (
        <p>
          <GithubLink href={result.url}>
            {result.url === undefined
              ? (result.urlText ?? "")
              : PAGE_COPY.stepLink}
          </GithubLink>
        </p>
      )}
      {result.number === undefined ? null : (
        <p>
          {PAGE_COPY.stepNumber}: <span>{result.number}</span>
        </p>
      )}
      {result.existing === undefined ? null : (
        <p className="text-muted-foreground">
          {result.existing ? PAGE_COPY.stepExisting : PAGE_COPY.stepCreated}
        </p>
      )}
    </div>
  );
}

/** What an agent step returned: what it said it did, the branch, and the rest of its output as JSON text in a collapsed block. */
function AgentOutcome({
  step,
  repository,
}: {
  step: StepView;
  repository: string | undefined;
}) {
  const result = agentResultOf(step, repository);
  if (result === undefined) return null;
  return (
    <div data-slot="step-agent-result" className="flex flex-col gap-2 text-sm">
      {result.summary === undefined ? null : (
        <p
          data-slot="step-agent-summary"
          className="break-words whitespace-pre-wrap"
        >
          {result.summary}
        </p>
      )}
      {result.repos === undefined ? null : (
        <div data-slot="step-agent-repos" className="flex flex-col gap-1">
          <p className="font-semibold">{PAGE_COPY.stepRepos}</p>
          <ul className="flex flex-col gap-2">
            {result.repos.map((repo) => (
              <li key={repo.fullName} className="break-words">
                <span>{repo.fullName}</span>{" "}
                <span className="text-muted-foreground">
                  {repo.branch === repo.base ? (
                    <>
                      {PAGE_COPY.stepRepoDirect} {repo.base}
                    </>
                  ) : (
                    <>
                      <GithubLink href={repo.branchUrl}>
                        {repo.branch}
                      </GithubLink>{" "}
                      {PAGE_COPY.stepRepoFrom} {repo.base}
                    </>
                  )}
                </span>
                <span className="block text-xs text-muted-foreground">
                  {PAGE_COPY.stepRepoCommits(repo.commits)},{" "}
                  {repo.pushed
                    ? PAGE_COPY.stepRepoPushed
                    : PAGE_COPY.stepRepoNotPushed}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {result.branch === undefined ? null : (
        <p>
          {PAGE_COPY.stepBranch}:{" "}
          <GithubLink href={result.branchUrl}>{result.branch}</GithubLink>
        </p>
      )}
      {result.fields === undefined ? null : (
        <details>
          <summary className="cursor-pointer text-muted-foreground">
            {PAGE_COPY.stepResultJson}
          </summary>
          <pre className="mt-2 max-h-96 overflow-auto font-mono text-xs break-words whitespace-pre-wrap">
            {JSON.stringify(result.fields, null, 2)}
          </pre>
        </details>
      )}
    </div>
  );
}

/** What a condition or a loop decided, in a sentence, and for a loop how many rounds it ran. */
function ControlOutcome({ step }: { step: StepView }) {
  const result = controlResultOf(step);
  if (result === undefined) return null;
  return (
    <div
      data-slot="step-control-result"
      className="flex flex-col gap-1 text-sm"
    >
      {result.taken === undefined ? null : (
        <p>{CONTROL_COPY.taken[result.taken]}</p>
      )}
      {result.exit === undefined ? null : (
        <p>{CONTROL_COPY.exit[result.exit]}</p>
      )}
      {result.rounds === undefined ? null : (
        <p className="text-muted-foreground">
          {CONTROL_COPY.rounds}: {result.rounds}
        </p>
      )}
    </div>
  );
}

/** What a step returned, by its kind. */
export function StepOutcome({
  step,
  repository,
}: {
  step: StepView;
  repository: string | undefined;
}) {
  return step.kind === "agent" ? (
    <AgentOutcome step={step} repository={repository} />
  ) : step.kind === "action" ? (
    <ActionOutcome step={step} repository={repository} />
  ) : (
    <ControlOutcome step={step} />
  );
}
