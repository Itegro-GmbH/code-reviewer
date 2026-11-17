// SPDX-License-Identifier: LicenseRef-Proprietary

// The picker of MCP servers (#1052): one checkbox per server, by name, in a labelled group. It is used twice, with different entries: on
// the lane card for the lane (the servers of the workspace) and in the inspector of an agent step (the servers of its lane). It shows what
// is wrong with a server (its last test failed, the workspace no longer has it, the lane does not name it) and writes nothing itself: the
// caller turns a toggle into an edit of the document (`mcp-edit.ts`).
import { Checkbox } from "../../components/ui/checkbox.tsx";
import { clip } from "../../workflows/issues.ts";
import { BUILDER_COPY } from "./copy.ts";

export type McpEntryState =
  | "ok"
  /** Never tested: nothing is known against it. */
  | "untested"
  /** The last connection test failed: a warning, the lane still saves. */
  | "failed"
  /** The lane (or step) names a server the workspace does not have. */
  | "missing"
  /** The step names a server its lane does not name. */
  | "outside";

export type McpEntry = {
  id: string;
  /** The name shown: the server's, or (for a missing one) its id. */
  name: string;
  state: McpEntryState;
  checked: boolean;
};

const NOTE: Record<McpEntryState, string | undefined> = {
  ok: undefined,
  untested: undefined,
  failed: BUILDER_COPY.mcpBroken,
  missing: BUILDER_COPY.mcpMissing,
  outside: BUILDER_COPY.mcpOutside,
};

export function McpPicker({
  name,
  label,
  hint,
  entries,
  onToggle,
}: {
  name: string;
  label: string;
  hint?: string;
  entries: readonly McpEntry[];
  onToggle: (id: string, checked: boolean) => void;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      data-field={name}
      className="flex flex-col gap-2"
    >
      <span className="text-sm font-semibold">{label}</span>
      {hint === undefined ? null : (
        <span className="text-xs text-muted-foreground">{hint}</span>
      )}
      <ul className="flex flex-col gap-1">
        {entries.map((entry) => {
          const note = NOTE[entry.state];
          const inputId = `${name}-${entry.id}`;
          return (
            <li key={entry.id} className="flex items-start gap-2">
              <Checkbox
                id={inputId}
                checked={entry.checked}
                aria-label={clip(entry.name)}
                onCheckedChange={(checked) =>
                  onToggle(entry.id, checked === true)
                }
              />
              <label
                htmlFor={inputId}
                className="flex min-w-0 flex-col text-sm"
              >
                <span className="break-words">{clip(entry.name)}</span>
                {note === undefined ? null : (
                  <span
                    className={
                      entry.state === "failed"
                        ? "text-xs text-warning"
                        : "text-xs text-danger"
                    }
                  >
                    {note}
                  </span>
                )}
              </label>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
