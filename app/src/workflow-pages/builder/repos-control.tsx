// SPDX-License-Identifier: LicenseRef-Proprietary

// The repository list of an agent step (#1094, epic #1090, ADR 0006): one block per repository with a picker over the workspace's
// repositories, a picker over the branches of that repository for the base, and a text for the optional branch (`feature/{{trigger.ticket.key}}`).
// A repository or a base that is a reference, or one the lists do not hold, is typed in a `ReferenceControl` (they are targets, #1092). Every
// field writes straight into the document (`repos-edit.ts`); the validator says what is wrong with it.
import { useEffect, useState } from "react";
import { Button } from "../../components/button.tsx";
import {
  REPOS_BASE_ROOTS,
  REPOS_BRANCH_ROOTS,
  REPOS_REPO_ROOTS,
} from "../../workflows/connectors.ts";
import { SelectControl } from "./controls.tsx";
import { BUILDER_COPY } from "./copy.ts";
import type { Doc, Pointer } from "./document.ts";
import { ReferenceControl } from "./reference-control.tsx";
import {
  SESSION_REPOS_MAX,
  addRepoEntry,
  changeRepoEntry,
  removeRepoEntry,
  repoEntries,
  type RepoEntry,
} from "./repos-edit.ts";
import { useRepoChoices, type RepoChoices } from "./repos-context.tsx";

const OTHER = "\u0000other";

function RepoBlock({
  index,
  pointer,
  entry,
  choices,
  onChange,
  onRemove,
}: {
  index: number;
  pointer: Pointer;
  entry: RepoEntry;
  choices: RepoChoices;
  onChange: (change: Partial<RepoEntry>) => void;
  onRemove: () => void;
}) {
  const known = choices.repositories.find(
    (candidate) =>
      candidate.fullName.toLowerCase() === entry.repo.trim().toLowerCase(),
  );
  const pickable =
    choices.status === "ready" && choices.repositories.length > 0;
  // Picked from the list, unless the person chose to type, the value is a reference, or it names a repository the list does not hold.
  const [typeRepo, setTypeRepo] = useState(false);
  const customRepo =
    typeRepo ||
    entry.repo.includes("{{") ||
    (entry.repo !== "" && known === undefined);
  const [customBase, setCustomBase] = useState(false);
  const knownId = known?.id;
  const { loadBranches } = choices;
  // The branches of a repository that is picked are asked for once.
  useEffect(() => {
    if (knownId !== undefined) loadBranches(knownId);
  }, [knownId, loadBranches]);
  const branches =
    knownId === undefined ? undefined : choices.branchesOf(knownId);
  const branchList = typeof branches === "object" ? branches : undefined;
  const baseInList =
    entry.base === "" || branchList?.branches.includes(entry.base) === true;
  const baseCustom = customBase || !baseInList;
  const at = `${pointer}/repos/${String(index)}`;
  const n = index + 1;
  return (
    <fieldset
      data-field={`repo-${String(index)}`}
      className="flex flex-col gap-3 rounded-lg border border-line p-3"
    >
      <legend className="px-1 text-sm font-semibold">
        {`${BUILDER_COPY.reposPick} ${String(n)}`}
      </legend>
      {pickable && !customRepo ? (
        <SelectControl
          name={`repo-pick-${String(index)}`}
          label={`${BUILDER_COPY.reposPick} ${String(n)}`}
          value={known?.fullName ?? ""}
          options={[
            ...(known === undefined
              ? [{ value: "", label: "Choose a repository…", disabled: true }]
              : []),
            ...choices.repositories.map((repository) => ({
              value: repository.fullName,
              label: repository.writeGranted
                ? repository.fullName
                : `${repository.fullName} (${BUILDER_COPY.reposReadOnly})`,
            })),
            { value: OTHER, label: BUILDER_COPY.reposOther },
          ]}
          onChange={(next) => {
            if (next === OTHER) {
              setTypeRepo(true);
              return;
            }
            // A new repository has other branches: the base is chosen again.
            setCustomBase(false);
            onChange({ repo: next, base: "" });
          }}
        />
      ) : (
        <>
          <ReferenceControl
            name={`repo-${String(index)}-repo`}
            label={`${BUILDER_COPY.reposPick} ${String(n)} (owner/name)`}
            at={`${at}/repo`}
            value={entry.repo}
            target={REPOS_REPO_ROOTS}
            placeholder="owner/name, or one {{reference}}"
            onChange={(repo) => onChange({ repo })}
          />
          {pickable ? (
            <Button
              variant="ghost"
              size="sm"
              className="self-start"
              onClick={() => {
                // What was typed is not one of the repositories: the pick starts again.
                setTypeRepo(false);
                if (known === undefined) onChange({ repo: "", base: "" });
              }}
            >
              Pick from the workspace&apos;s repositories
            </Button>
          ) : choices.status === "failed" ? (
            <p className="text-xs text-warning">
              {BUILDER_COPY.reposLoadFailed}
            </p>
          ) : null}
        </>
      )}
      {known !== undefined && branchList !== undefined && !baseCustom ? (
        <SelectControl
          name={`repo-base-${String(index)}`}
          label={`${BUILDER_COPY.reposBase} ${String(n)}`}
          value={entry.base}
          options={[
            {
              value: "",
              label: `${BUILDER_COPY.reposBaseDefault} (${branchList.defaultBranch})`,
            },
            ...branchList.branches.map((branch) => ({
              value: branch,
              label: branch,
            })),
            { value: OTHER, label: BUILDER_COPY.reposBaseOther },
          ]}
          {...(branchList.truncated
            ? {
                hint: "Only the first branches are listed; use the other choice for the rest.",
              }
            : {})}
          onChange={(next) => {
            if (next === OTHER) {
              setCustomBase(true);
              return;
            }
            onChange({ base: next });
          }}
        />
      ) : (
        <ReferenceControl
          name={`repo-${String(index)}-base`}
          label={`${BUILDER_COPY.reposBase} ${String(n)} (optional)`}
          at={`${at}/base`}
          value={entry.base}
          target={REPOS_BASE_ROOTS}
          placeholder="the default branch of the repository"
          onChange={(base) => onChange({ base })}
        />
      )}
      <ReferenceControl
        name={`repo-${String(index)}-branch`}
        label={`${BUILDER_COPY.reposBranch} ${String(n)}`}
        at={`${at}/branch`}
        value={entry.branch}
        target={REPOS_BRANCH_ROOTS}
        placeholder="work directly on the base branch"
        hint={BUILDER_COPY.reposBranchHint}
        onChange={(branch) => onChange({ branch })}
      />
      <Button
        variant="destructive"
        size="sm"
        className="self-start"
        aria-label={`${BUILDER_COPY.reposRemove} ${String(n)}`}
        onClick={onRemove}
      >
        {BUILDER_COPY.reposRemove}
      </Button>
    </fieldset>
  );
}

/** The `repos` of an agent step; a step that continues a session shows why it has none. */
export function ReposControl({
  doc,
  pointer,
  node,
  continued,
  onChange,
}: {
  doc: Doc;
  pointer: Pointer;
  node: Doc;
  continued: boolean;
  onChange: (doc: Doc) => void;
}) {
  const choices = useRepoChoices();
  const entries = repoEntries(node);
  if (continued && entries.length === 0)
    return (
      <p className="text-xs text-muted-foreground">
        {BUILDER_COPY.reposContinued}
      </p>
    );
  return (
    <div
      role="group"
      aria-label={BUILDER_COPY.reposTitle}
      data-field="repos"
      className="flex flex-col gap-3"
    >
      <span className="text-sm font-semibold">{BUILDER_COPY.reposTitle}</span>
      <span className="text-xs text-muted-foreground">
        {BUILDER_COPY.reposHint}
      </span>
      {entries.map((entry, index) => (
        <RepoBlock
          // The position is the identity of an entry: nothing else in it is unique or stable while it is typed.
          key={index}
          index={index}
          pointer={pointer}
          entry={entry}
          choices={choices}
          onChange={(change) =>
            onChange(changeRepoEntry(doc, pointer, entries, index, change))
          }
          onRemove={() =>
            onChange(removeRepoEntry(doc, pointer, entries, index))
          }
        />
      ))}
      {entries.length >= SESSION_REPOS_MAX ? (
        <p className="text-xs text-muted-foreground">
          {BUILDER_COPY.reposLimit(SESSION_REPOS_MAX)}
        </p>
      ) : (
        <Button
          variant="secondary"
          size="sm"
          className="self-start"
          disabled={continued}
          onClick={() => onChange(addRepoEntry(doc, pointer, entries))}
        >
          {BUILDER_COPY.reposAdd}
        </Button>
      )}
    </div>
  );
}
