// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";
// A label, one control and its message, wired the way the checks of the accessibility tests expect (#756-T07): the label names the
// control, a refusal is `aria-invalid` and described by its own sentence (the only description while it shows), and the hint
// describes the control while there is no refusal.
import { useId, type ReactNode } from "react";
import { FieldLabel } from "../../components/ui/field.tsx";

export type ControlProps = {
  id: string;
  "aria-invalid": boolean;
  "aria-describedby": string | undefined;
};

export function FormField({
  name,
  label,
  hint,
  error,
  aside,
  children,
}: {
  /** The `data-field` of the wrapper. */
  name: string;
  label: string;
  hint?: ReactNode;
  error?: string | undefined;
  /** Shown at the right of the label (the character counter). */
  aside?: ReactNode;
  children: (control: ControlProps) => ReactNode;
}) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  return (
    <div data-field={name} className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <FieldLabel htmlFor={id}>{label}</FieldLabel>
        {aside}
      </div>
      {children({
        id,
        "aria-invalid": error !== undefined,
        "aria-describedby":
          error !== undefined
            ? errorId
            : hint !== undefined
              ? hintId
              : undefined,
      })}
      {error !== undefined ? (
        <p id={errorId} className="text-sm text-destructive">
          {error}
        </p>
      ) : hint !== undefined ? (
        <p id={hintId} className="text-sm text-muted-foreground">
          {hint}
        </p>
      ) : null}
    </div>
  );
}
