// SPDX-License-Identifier: LicenseRef-Proprietary

// What the validator found, as a list of cards (#926): the code, where, the sentence, the names that would do, and the one-click fix where
// there is one. Used for a node in the inspector and for the errors that belong to no node, under the header of the builder.
import { Button } from "../../components/button.tsx";
import { Badge } from "../../components/ui/badge.tsx";
import { setAt, type Doc } from "./document.ts";
import { fixOf, type Problem } from "./problems.ts";

export function ProblemList({
  doc,
  problems,
  onChange,
  heading,
  severity = "error",
}: {
  doc: Doc;
  problems: readonly Problem[];
  onChange: (doc: Doc) => void;
  heading: string;
  /** `warning`: the cards are the warning colours and name a warning (#973); the default is an error. */
  severity?: "error" | "warning";
}) {
  const warning = severity === "warning";
  return (
    <section aria-label={heading} className="flex flex-col gap-2">
      {problems.map((problem, at) => {
        const fix = fixOf(doc, problem);
        return (
          <div
            key={`${problem.path}-${problem.code}-${String(at)}`}
            role="group"
            aria-label={`${warning ? "Warning" : "Error"} ${problem.code}`}
            data-slot="problem"
            className={`flex flex-col gap-2 rounded-lg border p-3 text-sm ${warning ? "border-warning bg-warning-soft" : "border-danger bg-danger-soft"}`}
          >
            <span className="flex flex-wrap items-center gap-2">
              <Badge variant={warning ? "warning" : "danger"}>
                {problem.code}
              </Badge>
              <code className="text-xs break-all text-muted-foreground">
                {problem.path === "" ? "/" : problem.path}
              </code>
            </span>
            <span>{problem.message}</span>
            {problem.available === undefined ||
            problem.available.length === 0 ? null : (
              <span className="flex flex-wrap gap-1" aria-label="Available">
                {problem.available.map((name) => (
                  <Badge key={name} variant="neutral">
                    {name}
                  </Badge>
                ))}
              </span>
            )}
            {fix === undefined ? null : (
              <Button
                variant="secondary"
                size="sm"
                className="self-start"
                onClick={() => onChange(setAt(doc, fix.pointer, fix.value))}
              >
                Use “{fix.replacement}”
              </Button>
            )}
          </div>
        );
      })}
    </section>
  );
}
