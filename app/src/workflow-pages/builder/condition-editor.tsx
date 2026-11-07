// SPDX-License-Identifier: LicenseRef-Proprietary

// A condition as a form (#926): the operator, and its operands or the conditions inside it. It nests as the format does; how deep it may go
// is the validator's to say.
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

/** One operand: a text (a reference is one), a number or true/false, as the person chose; typing never changes the kind. */
function Operand({
  label,
  value,
  placeholder,
  onChange,
}: {
  label: string;
  value: unknown;
  placeholder: string;
  onChange: (next: unknown) => void;
}) {
  const kind = operandKind(value);
  return (
    <div className="flex items-center gap-2">
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
      ) : (
        <Input
          aria-label={label}
          type={kind === "number" ? "number" : "text"}
          value={operandText(value)}
          placeholder={placeholder}
          onChange={(event) =>
            onChange(operandFrom(event.target.value, kind, value))
          }
        />
      )}
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
  value,
  onChange,
}: {
  label: string;
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
        <Input
          aria-label={`${label} operand`}
          value={operandText(body)}
          placeholder="{{step.field}}"
          onChange={(event) =>
            onChange({ [operator]: operandFrom(event.target.value, "text") })
          }
        />
      ) : null}
      {operator === "equals" || operator === "notEquals" ? (
        <div className="flex flex-col gap-2">
          {([0, 1] as const).map((at) => (
            <Operand
              key={at}
              label={`${label} operand ${String(at + 1)}`}
              value={pairOf(body)[at]}
              placeholder={
                at === 0
                  ? "{{step.field}}"
                  : "a text, a number or {{reference}}"
              }
              onChange={(next) => {
                const pair = pairOf(body);
                pair[at] = next;
                onChange({ [operator]: pair });
              }}
            />
          ))}
        </div>
      ) : null}
      {operator === "all" || operator === "any" ? (
        <div className="flex flex-col gap-2">
          {(Array.isArray(body) ? (body as unknown[]) : []).map((part, at) => (
            <div
              key={at}
              className="flex flex-col gap-1 border-l-2 border-line pl-3"
            >
              <ConditionEditor
                label={`${label} ${String(at + 1)}`}
                value={part}
                onChange={(next) => {
                  const list = [...(body as unknown[])];
                  list[at] = next;
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
                      (_, index) => index !== at,
                    ),
                  })
                }
              >
                Remove condition {at + 1}
              </Button>
            </div>
          ))}
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
            value={body}
            onChange={(next) => onChange({ not: next })}
          />
        </div>
      ) : null}
    </div>
  );
}
