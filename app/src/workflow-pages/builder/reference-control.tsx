// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";
// A text field that can hold references (#927). The text stays what it always was, `{{step.field}}` typed or picked, and is stored
// exactly as it stands; every reference in it is also shown as a chip (category · name, × removes it), and a + at the right opens the
// picker under the field and inserts the value at the cursor. A target field (one trusted value) shows its reference as the one chip
// in place of the box and greys the + out until the chip is removed; a field that takes a literal only has no picker. Without a
// pointing device nothing is lost: the box is always there for the keyboard and for a screen reader.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "../../components/button.tsx";
import { Input } from "../../components/ui/input.tsx";
import { Textarea } from "../../components/ui/textarea.tsx";
import {
  FormField,
  type ControlProps,
} from "../../implementer/ui/form-field.tsx";
import type { ReachEntry } from "../../workflows/reach.ts";
import { chipsOf, withReference, withoutChip, type Chip } from "./chips.ts";
import { PICKER_COPY, describeTargetRule } from "./copy.ts";
import { TargetMark } from "./controls.tsx";
import { useReachLookup } from "./reach-context.tsx";
import { ReferencePicker } from "./reference-picker.tsx";

function ChipView({
  chip,
  onRemove,
  disabled,
}: {
  chip: Chip;
  onRemove: () => void;
  disabled: boolean;
}) {
  return (
    <span
      data-slot="chip"
      data-category={chip.category}
      className="inline-flex max-w-full items-center gap-1 rounded-full bg-raised py-0.5 pr-1 pl-3 text-xs font-semibold"
    >
      <span className="min-w-0 truncate" title={chip.title}>
        {chip.label}
      </span>
      <button
        type="button"
        aria-label={PICKER_COPY.removeChip(chip.label)}
        disabled={disabled}
        onClick={onRemove}
        className="grid size-5 shrink-0 place-items-center rounded-full hover:bg-raised-strong disabled:opacity-50"
      >
        <span aria-hidden>×</span>
      </button>
    </span>
  );
}

export type ReferenceInputProps = {
  /** The name of the field: the + and the chips are named after it. */
  label: string;
  /** Pointer of the text in the document, for what it can reach: the node, or `…/instruction/next` or `…/when`. */
  at: string;
  value: string;
  onChange: (text: string) => void;
  onBlur?: () => void;
  multiline?: boolean;
  /** A target field: the roots it takes (`[]`: a literal only). Left out: free text. */
  target?: readonly string[];
  disabled?: boolean;
  placeholder?: string;
  /** The wiring of a `FormField`; a field without one names itself with `label`. */
  control?: ControlProps;
};

export function ReferenceInput({
  label,
  at,
  value,
  onChange,
  onBlur,
  multiline,
  target,
  disabled,
  placeholder,
  control,
}: ReferenceInputProps) {
  const lookup = useReachLookup();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  const selection = useRef({ start: 0, end: 0 });
  const restore = useRef<{ caret?: number } | undefined>(undefined);
  const chips = chipsOf(value);
  const single = target !== undefined && target.length > 0;
  const literalOnly = target !== undefined && target.length === 0;
  const full = single && chips.length > 0;
  const onlyChip =
    single && chips.length === 1 && value.trim() === chips[0]?.source
      ? chips[0]
      : undefined;
  const picking = disabled !== true && !literalOnly && !full;

  useEffect(() => {
    const pending = restore.current;
    if (pending === undefined || open) return;
    restore.current = undefined;
    const element = field.current;
    if (element === null) return;
    element.focus();
    if (pending.caret !== undefined)
      element.setSelectionRange(pending.caret, pending.caret);
  }, [open, value]);

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent): void => {
      if (
        event.target instanceof Node &&
        box.current?.contains(event.target) !== true
      )
        setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);

  const openPicker = (): void => {
    const element = field.current;
    selection.current = {
      start: element?.selectionStart ?? value.length,
      end: element?.selectionEnd ?? value.length,
    };
    setOpen(true);
  };

  const pick = (entry: ReachEntry): void => {
    const next = withReference(value, selection.current, entry.insert, single);
    restore.current = { caret: next.caret };
    setOpen(false);
    onChange(next.text);
  };

  const remove = (chip: Chip): void => {
    restore.current = { caret: chip.start };
    onChange(withoutChip(value, chip));
  };

  const shared = {
    ...(control ?? { "aria-label": label }),
    ref: field,
    value,
    disabled: disabled === true,
    ...(placeholder === undefined ? {} : { placeholder }),
    onChange: (event: { target: { value: string } }) =>
      onChange(event.target.value),
    ...(onBlur === undefined ? {} : { onBlur }),
  };

  return (
    <div
      ref={box}
      data-slot="reference-input"
      className="relative flex flex-col gap-2"
    >
      <div className="flex items-start gap-2">
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          {onlyChip === undefined ? null : (
            <span className="flex min-h-10 items-center rounded-lg border border-input bg-background px-2">
              <ChipView
                chip={onlyChip}
                disabled={disabled === true}
                onRemove={() => remove(onlyChip)}
              />
            </span>
          )}
          {multiline === true ? (
            <Textarea
              {...shared}
              rows={4}
              className={onlyChip === undefined ? undefined : "sr-only"}
            />
          ) : (
            <Input
              {...shared}
              className={onlyChip === undefined ? undefined : "sr-only"}
            />
          )}
        </div>
        <Button
          variant="secondary"
          size="sm"
          className="h-10 shrink-0"
          aria-label={PICKER_COPY.insertInto(label)}
          aria-haspopup="dialog"
          aria-expanded={open}
          disabled={!picking}
          title={full ? PICKER_COPY.oneValueDone : undefined}
          onClick={() => (open ? setOpen(false) : openPicker())}
        >
          +
        </Button>
      </div>
      {onlyChip !== undefined || chips.length === 0 ? null : (
        <ul
          aria-label={PICKER_COPY.variablesIn(label)}
          className="flex flex-wrap gap-1"
        >
          {chips.map((chip) => (
            <li key={`${chip.start}-${chip.source}`} className="max-w-full">
              <ChipView
                chip={chip}
                disabled={disabled === true}
                onRemove={() => remove(chip)}
              />
            </li>
          ))}
        </ul>
      )}
      {open ? (
        <ReferencePicker
          label={label}
          at={at}
          {...(target === undefined ? {} : { target })}
          lookup={lookup}
          onPick={pick}
          onClose={(restoreFocus) => {
            if (restoreFocus) restore.current = {};
            setOpen(false);
          }}
        />
      ) : null}
    </div>
  );
}

/** A labelled `ReferenceInput`: the label, the target mark, the hint and, for a target, the rule of the field. */
export function ReferenceControl({
  name,
  label,
  hint,
  ...input
}: Omit<ReferenceInputProps, "control"> & {
  /** The `data-field` of the wrapper. */
  name: string;
  hint?: ReactNode;
}) {
  const target = input.target;
  const shownHint =
    target === undefined ? (
      hint
    ) : (
      <>
        {hint === undefined ? null : <span className="block">{hint}</span>}
        <span data-slot="target-rule" className="block">
          {describeTargetRule(target)}
        </span>
      </>
    );
  return (
    <FormField
      name={name}
      label={label}
      {...(shownHint === undefined ? {} : { hint: shownHint })}
      aside={
        target === undefined ? undefined : (
          <TargetMark literalOnly={target.length === 0} />
        )
      }
    >
      {(control) => (
        <ReferenceInput label={label} {...input} control={control} />
      )}
    </FormField>
  );
}
