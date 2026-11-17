// SPDX-License-Identifier: LicenseRef-Proprietary

// The lane card (#926), right column under the inspector: the limits of the lane (what it may spend, how long one turn may run), its
// versions, and one sentence about ask. The limits are the document's `budgetUsd` and `turnTimeLimitMinutes` (#918); a limit left out
// shows the default the engine uses, and is written into the document when it is changed.
import {
  BUDGET_DEFAULT_USD,
  BUDGET_OPERATOR_MAX_USD,
  TURN_TIME_LIMIT_MINUTES_DEFAULT,
  TURN_TIME_LIMIT_MINUTES_MAX,
  TURN_TIME_LIMIT_MINUTES_MIN,
} from "../../workflows/limits.ts";
import { formatUtc } from "../../ui/format-time.ts";
import { BUILDER_COPY } from "./copy.ts";
import { Stepper } from "./controls.tsx";
import { setAt, type Doc } from "./document.ts";
import {
  laneMcpEntries,
  withLaneServer,
  type McpServerOption,
} from "./mcp-edit.ts";
import { McpPicker } from "./mcp-picker.tsx";

export type VersionEntry = { version: number; savedAt: string };

export function LaneCard({
  doc,
  version,
  versions,
  mcpServers = [],
  mcpHref,
  onChange,
}: {
  doc: Doc;
  version: number;
  versions: readonly VersionEntry[];
  /** The MCP servers of the workspace (#1052): what the lane may name. Left out: none. */
  mcpServers?: readonly McpServerOption[];
  /** Where the MCP servers are managed, for the link shown when the workspace has none. */
  mcpHref?: string;
  onChange: (doc: Doc) => void;
}) {
  const entries = laneMcpEntries(doc, mcpServers);
  const budget =
    typeof doc.budgetUsd === "number" ? doc.budgetUsd : BUDGET_DEFAULT_USD;
  const turn =
    typeof doc.turnTimeLimitMinutes === "number"
      ? doc.turnTimeLimitMinutes
      : TURN_TIME_LIMIT_MINUTES_DEFAULT;
  return (
    <section
      aria-label={BUILDER_COPY.laneCardTitle}
      className="flex flex-col gap-4 rounded-xl border border-line-strong bg-surface p-4"
    >
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-base font-semibold">
          {BUILDER_COPY.laneCardTitle}
        </h2>
        <span className="text-xs text-muted-foreground">v{version}</span>
      </div>
      <Stepper
        label={BUILDER_COPY.budgetTitle}
        hint={BUILDER_COPY.budgetHint}
        value={budget}
        min={5}
        max={BUDGET_OPERATOR_MAX_USD}
        step={5}
        onChange={(next) => onChange(setAt(doc, "/budgetUsd", next))}
      />
      <Stepper
        label={BUILDER_COPY.turnTitle}
        hint={BUILDER_COPY.turnHint}
        value={turn}
        min={TURN_TIME_LIMIT_MINUTES_MIN}
        max={TURN_TIME_LIMIT_MINUTES_MAX}
        step={5}
        onChange={(next) => onChange(setAt(doc, "/turnTimeLimitMinutes", next))}
      />
      {entries.length > 0 ? (
        <McpPicker
          name="lane-mcp"
          label={BUILDER_COPY.mcpTitle}
          hint={BUILDER_COPY.mcpLaneHint}
          entries={entries}
          onToggle={(id, checked) => onChange(withLaneServer(doc, id, checked))}
        />
      ) : (
        <p className="text-xs text-muted-foreground">
          {BUILDER_COPY.mcpNone}{" "}
          {mcpHref === undefined ? null : (
            <a href={mcpHref} className="underline">
              {BUILDER_COPY.mcpPageLink}
            </a>
          )}
        </p>
      )}
      <div className="flex flex-col gap-1">
        <h3 className="text-sm font-semibold">{BUILDER_COPY.versions}</h3>
        <ul className="flex flex-col gap-1 text-xs text-muted-foreground">
          {versions.map((entry) => (
            <li key={entry.version} className="flex justify-between gap-2">
              <span>
                v{entry.version}
                {entry.version === version
                  ? ` · ${BUILDER_COPY.versionCurrent}`
                  : ""}
              </span>
              <time dateTime={entry.savedAt}>{formatUtc(entry.savedAt)}</time>
            </li>
          ))}
        </ul>
      </div>
      <p className="text-xs text-muted-foreground">
        {BUILDER_COPY.askSentence}
      </p>
    </section>
  );
}
