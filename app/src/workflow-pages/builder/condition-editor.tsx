// SPDX-License-Identifier: LicenseRef-Proprietary

// A condition as a form (#926): the operator, and its operands or the conditions inside it. It nests as the format does; how deep it may go
// is the validator's to say.
import { useState } from "react";
import { Button } from "../../components/button.tsx";
import { Input } from "../../components/ui/input.tsx";
import { NativeSelect } from "../../components/native-select.tsx";
import { isRecord } from "../../workflows/json.ts";
import {
  convertCondition,
  emptyCondition,
  operandFrom,
  operandKind,
  operandOfKind,
  operandText,
  pairOf,
  type OperandKind,
} from "./condition.ts";
import {
  CONDITION_OPERATORS,
  operatorOf,
  type ConditionOperator,
} from "./describe.ts";
import { ReferenceInput } from "./reference-control.tsx";

const OPERATOR_LABEL: Record<ConditionOperator, string> = {
  empty: "is empty",
  notEmpty: "is not empty",
  equals: "equals",
  notEquals: "does not equal",
  all: "all of",
  any: "any of",
  not: "not",
};

const KIND_LABEL: Record<OperandKind, string> = {
  text: "Text",
  number: "Number",
  boolean: "true/false",
};

/**
 * A number operand keeps what is typed as a draft while it is not a number yet (empty, a lone `-`): the document keeps the number it had
 * until what is typed is one, and a field left empty is 0.
 */
function NumberOperand({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (next: unknown) => void;
}) {
  const [draft, setDraft] = useState<
    { text: string; base: unknown } | undefined
  >(undefined);
  const shown =
    draft !== undefined && draft.base === value
      ? draft.text
      : operandText(value);
  return (
    <Input
      aria-label={label}
      type="text"
      inputMode="decimal"
      value={shown}
      onChange={(event) => {
        const text = event.target.value;
        const next = operandFrom(text, "number", value);
        setDraft({ text, base: next });
        if (next !== value) onChange(next);
      }}
      onBlur={() => {
        if (draft?.text.trim() === "") onChange(0);
        setDraft(undefined);
      }}
    />
  );
}

/** One operand: a text (a reference is one), a number or true/false, as the person chose; typing never changes the kind. */
function Operand({
  label,
  at,
  value,
  placeholder,
  onChange,
}: {
  label: string;
  at: string;
  value: unknown;
  placeholder: string;
  onChange: (next: unknown) => void;
}) {
  const kind = operandKind(value);
  return (
    <div className="flex items-start gap-2">
      <div className="min-w-0 flex-1">
        {kind === "boolean" ? (
          <NativeSelect
            aria-label={label}
            value={String(value === true)}
            onChange={(event) =>
              onChange(operandFrom(event.target.value, "boolean"))
            }
          >
            <option value="true">true</option>
            <option value="false">false</option>
          </NativeSelect>
        ) : kind === "number" ? (
          <NumberOperand
            label={label}
            value={value as number}
            onChange={onChange}
          />
        ) : (
          <ReferenceInput
            label={label}
            at={at}
            value={operandText(value)}
            placeholder={placeholder}
            onChange={(text) => onChange(operandFrom(text, "text"))}
          />
        )}
      </div>
      <NativeSelect
        aria-label={`${label} type`}
        value={kind}
        onChange={(event) =>
          onChange(operandOfKind(value, event.target.value as OperandKind))
        }
      >
        {(Object.keys(KIND_LABEL) as OperandKind[]).map((each) => (
          <option key={each} value={each}>
            {KIND_LABEL[each]}
          </option>
        ))}
      </NativeSelect>
    </div>
  );
}

export function ConditionEditor({
  label,
  at,
  value,
  onChange,
}: {
  label: string;
  /** Pointer of the condition in the document (`/steps/1/when`): what its operands can reach. */
  at: string;
  value: unknown;
  onChange: (next: Record<string, unknown>) => void;
}) {
  const operator = operatorOf(value);
  const body =
    isRecord(value) && operator !== undefined ? value[operator] : undefined;
  return (
    <div
      role="group"
      aria-label={label}
      className="flex flex-col gap-2 rounded-lg border border-line p-3"
    >
      <NativeSelect
        aria-label={`${label} operator`}
        value={operator ?? ""}
        onChange={(event) =>
          onChange(
            convertCondition(value, event.target.value as ConditionOperator),
          )
        }
      >
        {operator === undefined ? (
          <option value="" disabled>
            Choose an operator…
          </option>
        ) : null}
        {CONDITION_OPERATORS.map((each) => (
          <option key={each} value={each}>
            {OPERATOR_LABEL[each]}
          </option>
        ))}
      </NativeSelect>
      {operator === "empty" || operator === "notEmpty" ? (
        <ReferenceInput
          label={`${label} operand`}
          at={at}
          value={operandText(body)}
          placeholder="{{step.field}}"
          onChange={(text) =>
            onChange({ [operator]: operandFrom(text, "text") })
          }
        />
      ) : null}
      {operator === "equals" || operator === "notEquals" ? (
        <div className="flex flex-col gap-2">
          {([0, 1] as const).map((position) => (
            <Operand
              key={position}
              label={`${label} operand ${String(position + 1)}`}
              at={at}
              value={pairOf(body)[position]}
              placeholder={
                position === 0
                  ? "{{step.field}}"
                  : "a text, a number or {{reference}}"
              }
              onChange={(next) => {
                const pair = pairOf(body);
                pair[position] = next;
                onChange({ [operator]: pair });
              }}
            />
          ))}
        </div>
      ) : null}
      {operator === "all" || operator === "any" ? (
        <div className="flex flex-col gap-2">
          {(Array.isArray(body) ? (body as unknown[]) : []).map(
            (part, index) => (
              <div
                key={index}
                className="flex flex-col gap-1 border-l-2 border-line pl-3"
              >
                <ConditionEditor
                  label={`${label} ${String(index + 1)}`}
                  at={at}
                  value={part}
                  onChange={(next) => {
                    const list = [...(body as unknown[])];
                    list[index] = next;
                    onChange({ [operator]: list });
                  }}
                />
                <Button
                  variant="ghost"
                  size="sm"
                  className="self-start"
                  onClick={() =>
                    onChange({
                      [operator]: (body as unknown[]).filter(
                        (_, other) => other !== index,
                      ),
                    })
                  }
                >
                  Remove condition {index + 1}
                </Button>
              </div>
            ),
          )}
          <Button
            variant="secondary"
            size="sm"
            className="self-start"
            onClick={() =>
              onChange({
                [operator]: [
                  ...(Array.isArray(body) ? (body as unknown[]) : []),
                  emptyCondition(),
                ],
              })
            }
          >
            Add a condition
          </Button>
        </div>
      ) : null}
      {operator === "not" ? (
        <div className="border-l-2 border-line pl-3">
          <ConditionEditor
            label={`${label} inner`}
            at={at}
            value={body}
            onChange={(next) => onChange({ not: next })}
          />
        </div>
      ) : null}
    </div>
  );
}
