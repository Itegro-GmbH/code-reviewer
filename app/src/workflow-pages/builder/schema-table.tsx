// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";
// The fields of a result schema or of a trigger's input as a table (#926): "becomes the agent's finish tool" for a result. A name is
// committed when the box loses focus (a name that is taken or empty goes back), so typing a name does not rename on every key.
import { useState } from "react";
import { Button } from "../../components/button.tsx";
import { Checkbox } from "../../components/ui/checkbox.tsx";
import { Input } from "../../components/ui/input.tsx";
import { NativeSelect } from "../../components/native-select.tsx";
import {
  addRow,
  removeRow,
  renameRow,
  requireRow,
  retypeRow,
  rowsOf,
  SIMPLE_TYPES,
  type SchemaRow,
} from "./schema.ts";

function NameBox({
  row,
  label,
  onCommit,
}: {
  row: SchemaRow;
  label: string;
  onCommit: (name: string) => void;
}) {
  const [draft, setDraft] = useState<string | undefined>(undefined);
  return (
    <Input
      aria-label={`${label} field name`}
      value={draft ?? row.name}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => {
        if (draft !== undefined) onCommit(draft);
        setDraft(undefined);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
      }}
    />
  );
}

export function SchemaTable({
  label,
  hint,
  value,
  allowTicket,
  onChange,
}: {
  label: string;
  hint: string;
  value: unknown;
  /** The input of a manual or api trigger may have a field of the type `ticket`. */
  allowTicket?: boolean;
  /** `undefined` when the last field is removed from a result: the step then has none. */
  onChange: (next: unknown) => void;
}) {
  const rows = rowsOf(value);
  const types: readonly string[] =
    allowTicket === true ? [...SIMPLE_TYPES, "ticket"] : SIMPLE_TYPES;
  return (
    <div
      role="group"
      aria-label={label}
      className="flex flex-col gap-2"
      data-field={label}
    >
      <span className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-sm font-semibold">{label}</span>
        <span className="text-xs text-muted-foreground">{hint}</span>
      </span>
      {rows.map((row) => (
        <div
          key={row.name}
          className="grid grid-cols-[minmax(0,1fr)_7rem_auto_auto] items-center gap-2"
          data-row={row.name}
        >
          <NameBox
            row={row}
            label={label}
            onCommit={(name) =>
              onChange(renameRow(value, row.name, name.trim()))
            }
          />
          <NativeSelect
            aria-label={`${row.name} type`}
            value={row.type}
            disabled={row.nested}
            onChange={(event) =>
              onChange(retypeRow(value, row.name, event.target.value))
            }
          >
            {types.includes(row.type) ? null : (
              <option value={row.type}>{row.type}</option>
            )}
            {types.map((type) => (
              <option key={type} value={type}>
                {type}
              </option>
            ))}
          </NativeSelect>
          <label className="flex items-center gap-1 text-xs">
            <Checkbox
              checked={row.required}
              aria-label={`${row.name} required`}
              onCheckedChange={(checked) =>
                onChange(requireRow(value, row.name, checked === true))
              }
            />
            required
          </label>
          <Button
            variant="ghost"
            size="sm"
            aria-label={`Remove field ${row.name}`}
            onClick={() => {
              const next = removeRow(value, row.name);
              onChange(
                rowsOf(next).length === 0 && allowTicket !== true
                  ? undefined
                  : next,
              );
            }}
          >
            ×
          </Button>
        </div>
      ))}
      <Button
        variant="secondary"
        size="sm"
        className="self-start"
        onClick={() => onChange(addRow(value))}
      >
        Add a field
      </Button>
    </div>
  );
}
