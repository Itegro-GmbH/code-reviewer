// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";
// The filter of the lane runs (#1078): status, project and lane, kept in the address (`?view=lanes&status=…&project=…&lane=…`), so it
// survives a reload and the Back button. The controls are controlled by the filter the server read from the address. The names of
// projects and lanes are somebody's words and are rendered as text.
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useId, useTransition } from "react";
import { Button } from "../components/button.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select.tsx";
import { WORKSPACE_RUN_STATUS_FILTERS } from "../db/workflow-run-filters.ts";
import type { LaneRunsQuery } from "./api.ts";
import { LANE_RUNS_COPY as COPY } from "./messages.ts";

/** The value of a select that means "do not filter by this field" (Radix reserves the empty string). */
const ANY = "any";

export type NamedOption = { id: string; name: string };

export function LaneRunsFilterToolbar({
  filter,
  projects,
  lanes,
}: {
  filter: LaneRunsQuery;
  projects: NamedOption[];
  lanes: NamedOption[];
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [pending, startTransition] = useTransition();
  const statusLabelId = useId();
  const projectLabelId = useId();
  const laneLabelId = useId();

  function apply(next: LaneRunsQuery): void {
    const params = new URLSearchParams({ view: "lanes" });
    for (const name of ["status", "project", "lane"] as const) {
      const value = next[name];
      if (value !== undefined) params.set(name, value);
    }
    // `push`, not `replace`: the Back button walks the filters a person tried.
    startTransition(() =>
      router.push(`${pathname}?${params.toString()}`, { scroll: false }),
    );
  }

  const active =
    filter.status !== undefined ||
    filter.project !== undefined ||
    filter.lane !== undefined;
  const choose = (name: "status" | "project" | "lane") => (value: string) =>
    apply({
      ...filter,
      ...(value === ANY ? { [name]: undefined } : { [name]: value }),
    });
  return (
    <div
      className="flex flex-wrap items-end gap-3"
      aria-busy={pending || undefined}
    >
      <FilterSelect
        labelId={statusLabelId}
        label={COPY.filterStatus}
        value={filter.status ?? ANY}
        onChange={choose("status")}
        anyLabel={COPY.anyStatus}
        options={WORKSPACE_RUN_STATUS_FILTERS.map((status) => ({
          id: status,
          name: COPY.statuses[status],
        }))}
      />
      <FilterSelect
        labelId={projectLabelId}
        label={COPY.filterProject}
        value={filter.project ?? ANY}
        onChange={choose("project")}
        anyLabel={COPY.anyProject}
        options={projects}
      />
      <FilterSelect
        labelId={laneLabelId}
        label={COPY.filterLane}
        value={filter.lane ?? ANY}
        onChange={choose("lane")}
        anyLabel={COPY.anyLane}
        options={lanes}
      />
      {active ? (
        <Button asChild variant="ghost">
          <Link href={`${pathname}?view=lanes`}>{COPY.resetFilter}</Link>
        </Button>
      ) : null}
    </div>
  );
}

function FilterSelect({
  labelId,
  label,
  value,
  onChange,
  anyLabel,
  options,
}: {
  labelId: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  anyLabel: string;
  options: NamedOption[];
}) {
  return (
    <div className="flex flex-col gap-1">
      <span
        id={labelId}
        className="text-xs font-semibold text-muted-foreground"
      >
        {label}
      </span>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger aria-labelledby={labelId} className="min-h-11 min-w-40">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ANY}>{anyLabel}</SelectItem>
          {options.map((option) => (
            <SelectItem key={option.id} value={option.id}>
              {option.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
