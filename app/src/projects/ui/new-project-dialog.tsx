// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";
// The "New project" dialog (#925, prototype): one ticket source and an optional board. A project is a repository of the GitHub App for
// now, so the ticket source is the choice of a repository that is not a project yet, and "Create" switches it on (the route that
// the project switch uses) and opens its cockpit. The board has no backend yet (the ticket source, #923) and is shown disabled with
// its hint. Only an Admin or an Owner may create a project (`manage_projects`); the page leaves the button out for a Member. Where the GitHub
// App is not configured nothing can be switched on: the button is disabled and the reason stands next to it (`blockedReason`, the text of the project switch).
import { useRouter } from "next/navigation";
import { useId, useMemo, useState } from "react";
import { Button } from "../../components/button.tsx";
import { NativeSelect } from "../../components/native-select.tsx";
import { StatusRegion } from "../../components/status-region.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "../../components/ui/dialog.tsx";
import { Label } from "../../components/ui/label.tsx";
import { useProductIdentity } from "../../product-identity/context.tsx";
import { browserProjectsApi, type ProjectsApi } from "./api.ts";
import { NEW_PROJECT_COPY, PROJECT_COPY } from "./cockpit-messages.ts";
import { projectPath } from "./project-cards.tsx";
import { describeFailure } from "./messages.ts";

export type NewProjectChoice = { repositoryId: string; fullName: string };

export function NewProjectDialog({
  workspaceSlug,
  choices,
  blockedReason = null,
  api: apiProp,
}: {
  workspaceSlug: string;
  /** The repositories that are not a project yet and can be read. */
  choices: readonly NewProjectChoice[];
  /** Why no project can be created now (the GitHub App is not configured); the button is disabled and says so. */
  blockedReason?: string | null;
  /** Only tests pass this. */
  api?: ProjectsApi;
}) {
  const product = useProductIdentity();
  const router = useRouter();
  const defaultApi = useMemo(
    () => browserProjectsApi(workspaceSlug),
    [workspaceSlug],
  );
  const api = apiProp ?? defaultApi;
  const sourceId = useId();
  const boardId = useId();
  const boardHintId = useId();
  const blockedId = useId();
  const [open, setOpen] = useState(false);
  const [repositoryId, setRepositoryId] = useState("");
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function create() {
    if (repositoryId === "" || pending) return;
    setPending(true);
    setProblem(null);
    const result = await api.setActive(repositoryId, true);
    setPending(false);
    if (!result.ok) {
      setProblem(describeFailure(product, result.code));
      return;
    }
    setOpen(false);
    router.push(projectPath(workspaceSlug, repositoryId));
  }

  if (blockedReason !== null)
    return (
      <div className="flex flex-col items-end gap-1">
        <Button disabled aria-describedby={blockedId}>
          {PROJECT_COPY.newProject}
        </Button>
        <p id={blockedId} className="text-xs text-muted-foreground">
          {blockedReason}
        </p>
      </div>
    );
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>{PROJECT_COPY.newProject}</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{NEW_PROJECT_COPY.title}</DialogTitle>
          <DialogDescription>{NEW_PROJECT_COPY.description}</DialogDescription>
        </DialogHeader>
        {choices.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {NEW_PROJECT_COPY.none}
          </p>
        ) : (
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1">
              <Label htmlFor={sourceId}>{NEW_PROJECT_COPY.ticketSource}</Label>
              <NativeSelect
                id={sourceId}
                value={repositoryId}
                onChange={(event) => setRepositoryId(event.target.value)}
              >
                <option value="">{NEW_PROJECT_COPY.chooseRepository}</option>
                {choices.map((choice) => (
                  <option key={choice.repositoryId} value={choice.repositoryId}>
                    {NEW_PROJECT_COPY.githubIssuesOf(choice.fullName)}
                  </option>
                ))}
                <option disabled>{NEW_PROJECT_COPY.jira}</option>
              </NativeSelect>
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor={boardId}>{NEW_PROJECT_COPY.board}</Label>
              <NativeSelect
                id={boardId}
                disabled
                aria-describedby={boardHintId}
                value=""
                onChange={() => undefined}
              >
                <option value="">{NEW_PROJECT_COPY.noRepository}</option>
              </NativeSelect>
              <p id={boardHintId} className="text-xs text-muted-foreground">
                {NEW_PROJECT_COPY.boardHint}
              </p>
            </div>
          </div>
        )}
        {problem !== null ? (
          <p role="alert" className="text-sm text-destructive">
            {problem}
          </p>
        ) : null}
        <StatusRegion>{pending ? NEW_PROJECT_COPY.creating : ""}</StatusRegion>
        <DialogFooter>
          <Button variant="secondary" onClick={() => setOpen(false)}>
            {NEW_PROJECT_COPY.cancel}
          </Button>
          <Button
            disabled={repositoryId === "" || pending}
            loading={pending}
            loadingLabel={NEW_PROJECT_COPY.creating}
            onClick={() => void create()}
          >
            {NEW_PROJECT_COPY.create}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
