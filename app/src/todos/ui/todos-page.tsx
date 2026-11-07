// SPDX-License-Identifier: LicenseRef-Proprietary

// The content of the ToDos page (#925): the prototype's two lists, "Open" and "Done", and the line that says who answers. Until the
// ticket source and the answer panel exist (#923, #924) both are empty and say what will appear here.
import Link from "next/link";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "../../components/ui/empty.tsx";
import { workspacePath } from "../../workspaces/paths.ts";
import { TODO_COPY } from "./messages.ts";

export function TodosPageContent({
  workspaceSlug,
  open = [],
}: {
  workspaceSlug: string;
  /** Titles of the open ToDos; none until the answer flow exists. */
  open?: readonly string[];
}) {
  return (
    <div className="flex flex-col gap-8">
      <section aria-labelledby="todos-open" className="flex flex-col gap-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="todos-open" className="text-lg leading-7 font-semibold">
            {TODO_COPY.open(open.length)}
          </h2>
          <p className="text-sm text-muted-foreground">{TODO_COPY.hint}</p>
        </div>
        {open.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>{TODO_COPY.emptyTitle}</EmptyTitle>
              <EmptyDescription>
                {TODO_COPY.emptyDescription}{" "}
                <Link href={workspacePath(workspaceSlug, "/projects")}>
                  {TODO_COPY.toProjects}
                </Link>
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : null}
      </section>
      <section aria-labelledby="todos-done" className="flex flex-col gap-3">
        <h2 id="todos-done" className="text-lg leading-7 font-semibold">
          {TODO_COPY.done(0)}
        </h2>
        <p className="text-sm text-muted-foreground">{TODO_COPY.doneEmpty}</p>
      </section>
    </div>
  );
}
