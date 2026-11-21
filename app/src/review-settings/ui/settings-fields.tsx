// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";
// The field widgets of the review settings form (#174): a labelled control, the hint of the field, its
// error and the row that says where the value comes from ("Set for this project", "Global default",
// "Built-in value") with the "Reset to default" action that takes an own value back. The three cards
// of the form (`model-fieldset`, `review-fieldset`, `when-fieldset`) build their fields from these,
// so the markup and the accessible wiring live in one place. Values typed by people (a model name, the
// project rules) are rendered as text, never as markup.
import { createContext, useContext, useId, type ReactNode } from "react";
import { Badge } from "../../components/ui/badge.tsx";
import { Checkbox } from "../../components/ui/checkbox.tsx";
import { Card, CardContent } from "../../components/ui/card.tsx";
import {
  FieldDescription,
  FieldLabel,
  FieldLegend,
  FieldSet,
  FieldTitle,
} from "../../components/ui/field.tsx";
import { Input } from "../../components/ui/input.tsx";
import { Textarea } from "../../components/ui/textarea.tsx";
import { cn } from "../../lib/utils.ts";
import type {
  ProjectDynamicSettingField,
  ReviewSettingField,
} from "../settings.ts";
import type { SettingsFormModel } from "./form-model.ts";
import type { BooleanField, FormState, TextField } from "./form-state.ts";
import type { ReviewCommand } from "../../integrations/types.ts";

/** The one name of the per-field action that takes an own value back to the layer below (#174). */
export const RESET_LABEL = "Reset to default";

/** Where the value of a field in force comes from: this layer, or the one below it. */
export function sourceText(
  model: SettingsFormModel,
  state: FormState,
  field: ReviewSettingField,
): string {
  if (state.overridden[field])
    return model.mode === "project"
      ? "Set for this project"
      : "Changed from the built-in value";
  if (model.mode === "global") return "Built-in value";
  return model.sources[field] === "global"
    ? "Global default"
    : "Built-in value";
}

/** The source of a field plus, while the person set it here, the action that takes it back. */
export type SettingsOrigin = {
  source: string;
  /** The visible text of the reset action, or null while the field follows the layer below. */
  resetLabel: string | null;
  resetAriaLabel: string;
  onReset: () => void;
};

export function settingsOrigin({
  model,
  state,
  name,
  label,
  onReset,
}: {
  model: SettingsFormModel;
  state: FormState;
  name: ReviewSettingField;
  /** What the reset action names, so one screen never shows two identical accessible names. */
  label: string;
  onReset: () => void;
}): SettingsOrigin {
  return {
    source: sourceText(model, state, name),
    resetLabel: state.overridden[name] ? RESET_LABEL : null,
    resetAriaLabel: `${RESET_LABEL} for ${label}`,
    onReset,
  };
}

/**
 * Whether the card a control sits in is disabled (read only, or busy). A fieldset disables its controls in a browser, but the buttons that
 * change a value (a reset, "Edit skill") also say it themselves and ignore a click, so a read only form cannot be changed by one of them.
 */
export const FieldsDisabledContext = createContext(false);

export function Origin({ origin }: { origin: SettingsOrigin }) {
  const disabled = useContext(FieldsDisabledContext);
  return (
    <span className="flex flex-wrap items-center gap-2">
      <Badge variant="neutral">{origin.source}</Badge>
      {origin.resetLabel !== null ? (
        <button
          type="button"
          disabled={disabled}
          onClick={() => {
            if (!disabled) origin.onReset();
          }}
          aria-label={origin.resetAriaLabel}
          className={cn(
            "inline-flex min-h-8 cursor-pointer items-center rounded-sm px-1 text-xs font-semibold text-foreground pointer-coarse:min-h-11 disabled:cursor-not-allowed disabled:opacity-50",
          )}
        >
          {origin.resetLabel}
        </button>
      ) : null}
    </span>
  );
}

type FieldBase = {
  name: ReviewSettingField | ProjectDynamicSettingField;
  label: string;
  hint?: ReactNode;
  error?: string;
  origin: SettingsOrigin;
};

function ids(id: string, hasHint: boolean, hasError: boolean) {
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy =
    [hasHint ? hintId : null, hasError ? errorId : null]
      .filter(Boolean)
      .join(" ") || undefined;
  return { hintId, errorId, describedBy };
}

function FieldEnding({
  hint,
  error,
  hintId,
  errorId,
}: {
  hint?: ReactNode;
  error?: string;
  hintId: string;
  errorId: string;
}) {
  return (
    <>
      {hint !== undefined ? (
        <FieldDescription id={hintId}>{hint}</FieldDescription>
      ) : null}
      {error !== undefined ? (
        <p id={errorId} className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </>
  );
}

export function SettingsTextField({
  name,
  label,
  hint,
  error,
  origin,
  value,
  onChange,
  inputMode,
  placeholder,
}: FieldBase & {
  value: string;
  onChange: (value: string) => void;
  inputMode?: "numeric" | "decimal";
  placeholder?: string;
}) {
  const id = useId();
  const { hintId, errorId, describedBy } = ids(
    id,
    hint !== undefined,
    error !== undefined,
  );
  return (
    <div data-field={name} className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <FieldLabel htmlFor={id}>{label}</FieldLabel>
        <Origin origin={origin} />
      </div>
      <Input
        id={id}
        type="text"
        autoComplete="off"
        spellCheck={false}
        value={value}
        aria-invalid={error !== undefined}
        aria-describedby={describedBy}
        onChange={(event) => onChange(event.target.value)}
        {...(inputMode === undefined ? {} : { inputMode })}
        {...(placeholder === undefined ? {} : { placeholder })}
      />
      <FieldEnding
        hint={hint}
        error={error}
        hintId={hintId}
        errorId={errorId}
      />
    </div>
  );
}

export function SettingsTextareaField({
  name,
  label,
  hint,
  error,
  origin,
  value,
  onChange,
  rows,
}: FieldBase & {
  value: string;
  onChange: (value: string) => void;
  rows: number;
}) {
  const id = useId();
  const { hintId, errorId, describedBy } = ids(
    id,
    hint !== undefined,
    error !== undefined,
  );
  return (
    <div data-field={name} className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <FieldLabel htmlFor={id}>{label}</FieldLabel>
        <Origin origin={origin} />
      </div>
      <Textarea
        id={id}
        rows={rows}
        value={value}
        aria-invalid={error !== undefined}
        aria-describedby={describedBy}
        onChange={(event) => onChange(event.target.value)}
      />
      <FieldEnding
        hint={hint}
        error={error}
        hintId={hintId}
        errorId={errorId}
      />
    </div>
  );
}

export function SettingsCheckboxField({
  name,
  label,
  hint,
  error,
  origin,
  checked,
  onChange,
}: FieldBase & { checked: boolean; onChange: (checked: boolean) => void }) {
  const id = useId();
  const { hintId, errorId, describedBy } = ids(
    id,
    hint !== undefined,
    error !== undefined,
  );
  return (
    <div data-field={name} className="flex flex-col gap-2">
      <div className="flex items-start gap-3">
        <Checkbox
          id={id}
          checked={checked}
          aria-describedby={describedBy}
          onCheckedChange={(value) => onChange(value === true)}
          className="mt-0.5"
        />
        <div className="flex flex-1 flex-wrap items-center justify-between gap-2">
          <FieldLabel htmlFor={id}>{label}</FieldLabel>
          <Origin origin={origin} />
        </div>
      </div>
      <FieldEnding
        hint={hint}
        error={error}
        hintId={hintId}
        errorId={errorId}
      />
    </div>
  );
}

export function SettingsCommandsField({
  name,
  label,
  error,
  origin,
  commands,
  selected,
  onToggle,
}: Omit<FieldBase, "hint"> & {
  commands: readonly ReviewCommand[];
  selected: readonly ReviewCommand[];
  onToggle: (command: ReviewCommand, allowed: boolean) => void;
}) {
  const id = useId();
  const labelId = `${id}-label`;
  const errorId = `${id}-error`;
  return (
    <div
      role="group"
      aria-labelledby={labelId}
      aria-describedby={error !== undefined ? errorId : undefined}
      data-field={name}
      className="flex flex-col gap-2"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <FieldTitle id={labelId}>{label}</FieldTitle>
        <Origin origin={origin} />
      </div>
      <div className="flex flex-wrap gap-x-6 gap-y-2">
        {commands.map((command) => {
          const commandId = `${id}-${command}`;
          return (
            <div key={command} className="flex items-center gap-2">
              <Checkbox
                id={commandId}
                checked={selected.includes(command)}
                onCheckedChange={(value) => onToggle(command, value === true)}
              />
              <FieldLabel htmlFor={commandId}>/{command}</FieldLabel>
            </div>
          );
        })}
      </div>
      {error !== undefined ? (
        <p id={errorId} className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/**
 * The shell of one card of the form: the shadcn Card around a `FieldSet` whose `FieldLegend` holds the
 * card's one `h2`. The legend names the group of fields (the rulebook keeps `<fieldset><legend>` for
 * a concept), and the heading inside it keeps the h1 → h2 hierarchy of the page.
 */
export function SettingsCard({
  title,
  disabled,
  children,
}: {
  title: string;
  disabled: boolean;
  children: ReactNode;
}) {
  return (
    <Card>
      <CardContent>
        <FieldSet disabled={disabled} className="gap-6">
          {/* A legend takes no part in the fieldset's gap, so it brings its own space. */}
          <FieldLegend className="mb-4">
            <h2 className="text-lg leading-7 font-semibold tracking-normal">
              {title}
            </h2>
          </FieldLegend>
          <FieldsDisabledContext.Provider value={disabled}>
            {children}
          </FieldsDisabledContext.Provider>
        </FieldSet>
      </CardContent>
    </Card>
  );
}

/** What a card of the form does with a changed field; the container owns the state behind it. */
export type SettingsFieldHandlers = {
  setText: (name: TextField, value: string) => void;
  setBoolean: (name: BooleanField, value: boolean) => void;
  setCommand: (command: ReviewCommand, allowed: boolean) => void;
  /** Takes a field back to the value of the layer below. */
  reset: (name: ReviewSettingField) => void;
};

/** What every card of the form reads: the values in force, the problems and the handlers. */
export type SettingsFieldsetProps = {
  model: SettingsFormModel;
  state: FormState;
  errors: Partial<Record<string, string>>;
  disabled: boolean;
  handlers: SettingsFieldHandlers;
};
