// SPDX-License-Identifier: LicenseRef-Proprietary

// The small controls of the inspector and the lane card (#926): a text with its label and the "target" mark, a stepper, a select. Colours
// come from the theme only; every control has a name a screen reader can read.
import type { ReactNode } from "react";
import { Button } from "../../components/button.tsx";
import { Badge } from "../../components/ui/badge.tsx";
import { Input } from "../../components/ui/input.tsx";
import { Textarea } from "../../components/ui/textarea.tsx";
import { NativeSelect } from "../../components/native-select.tsx";
import { FormField } from "../../implementer/ui/form-field.tsx";
import { BUILDER_COPY } from "./copy.ts";

export function TargetMark({ literalOnly }: { literalOnly?: boolean }) {
  return (
    <Badge variant="secondary" data-slot="target-mark">
      {literalOnly ? BUILDER_COPY.targetLiteral : BUILDER_COPY.target}
    </Badge>
  );
}

export function TextControl({
  name,
  label,
  value,
  onChange,
  onBlur,
  hint,
  multiline,
  target,
  disabled,
  placeholder,
}: {
  name: string;
  label: string;
  value: string;
  onChange: (text: string) => void;
  onBlur?: () => void;
  hint?: ReactNode;
  multiline?: boolean;
  /** `true`: a target (one value); `"literal"`: a target that takes a literal only. */
  target?: boolean | "literal";
  disabled?: boolean;
  placeholder?: string;
}) {
  return (
    <FormField
      name={name}
      label={label}
      {...(hint === undefined ? {} : { hint })}
      aside={
        target === undefined || target === false ? undefined : (
          <TargetMark literalOnly={target === "literal"} />
        )
      }
    >
      {(control) =>
        multiline === true ? (
          <Textarea
            {...control}
            rows={4}
            value={value}
            disabled={disabled === true}
            placeholder={placeholder ?? "text, with {{variables}}"}
            onChange={(event) => onChange(event.target.value)}
            {...(onBlur === undefined ? {} : { onBlur })}
          />
        ) : (
          <Input
            {...control}
            value={value}
            disabled={disabled === true}
            {...(placeholder === undefined ? {} : { placeholder })}
            onChange={(event) => onChange(event.target.value)}
            {...(onBlur === undefined ? {} : { onBlur })}
          />
        )
      }
    </FormField>
  );
}

export function SelectControl({
  name,
  label,
  value,
  options,
  onChange,
  hint,
  disabled,
}: {
  name: string;
  label: string;
  value: string;
  options: readonly { value: string; label: string; disabled?: boolean }[];
  onChange: (value: string) => void;
  hint?: ReactNode;
  disabled?: boolean;
}) {
  return (
    <FormField
      name={name}
      label={label}
      {...(hint === undefined ? {} : { hint })}
    >
      {(control) => (
        <NativeSelect
          {...control}
          value={value}
          disabled={disabled === true}
          onChange={(event) => onChange(event.target.value)}
        >
          {options.map((option) => (
            <option
              key={option.value}
              value={option.value}
              disabled={option.disabled === true}
            >
              {option.label}
            </option>
          ))}
        </NativeSelect>
      )}
    </FormField>
  );
}

export function Stepper({
  label,
  hint,
  value,
  min,
  max,
  step = 1,
  onChange,
}: {
  label: string;
  hint?: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (value: number) => void;
}) {
  const clamp = (next: number): number => Math.min(max, Math.max(min, next));
  return (
    <div
      role="group"
      aria-label={label}
      className="flex items-center justify-between gap-3"
      data-field={label}
    >
      <span className="flex min-w-0 flex-col">
        <span className="text-sm font-semibold">{label}</span>
        {hint === undefined ? null : (
          <span className="text-xs text-muted-foreground">{hint}</span>
        )}
      </span>
      <span className="flex items-center gap-2">
        <Button
          variant="secondary"
          size="sm"
          aria-label={`${BUILDER_COPY.less} ${label.toLowerCase()}`}
          disabled={value <= min}
          onClick={() => onChange(clamp(value - step))}
        >
          −
        </Button>
        <output
          className="min-w-8 text-center text-sm font-semibold"
          aria-label={`${label} value`}
        >
          {value}
        </output>
        <Button
          variant="secondary"
          size="sm"
          aria-label={`${BUILDER_COPY.more} ${label.toLowerCase()}`}
          disabled={value >= max}
          onClick={() => onChange(clamp(value + step))}
        >
          +
        </Button>
      </span>
    </div>
  );
}
