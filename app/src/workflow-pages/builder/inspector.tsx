// SPDX-License-Identifier: LicenseRef-Proprietary

// The inspector (#926): the fields of the selected node, by kind, and what the validator found at it. Every field writes straight into the
// document; a list field keeps the text being typed as a draft only while it parses to the value in the document. A field that can
// hold a reference is a `ReferenceControl` (#927): `{{…}}` typed or picked, shown as chips, stored as typed.
import { useState, type Ref } from "react";
import { Button } from "../../components/button.tsx";
import { Checkbox } from "../../components/ui/checkbox.tsx";
import { FormField } from "../../implementer/ui/form-field.tsx";
import { Input } from "../../components/ui/input.tsx";
import { canonicalJson, isRecord } from "../../workflows/json.ts";
import { LOOP_ROUNDS_MAX } from "../../workflows/limits.ts";
import { START_BRANCH_ROOTS } from "../../workflows/connectors.ts";
import type { ReachWants } from "../../workflows/reach.ts";
import { TRIGGER_KINDS } from "../../workflows/triggers.ts";
import {
  CONNECTOR_NAMES,
  controlOf,
  inputsOf,
  specOf,
  textOfValue,
  valueOfText,
  withConnector,
  type Control,
} from "./action-fields.ts";
import type { ReachLookup } from "./api.ts";
import { ConditionEditor } from "./condition-editor.tsx";
import { BUILDER_COPY, KIND_HELP } from "./copy.ts";
import { SelectControl, Stepper, TextControl } from "./controls.tsx";
import { describeNode } from "./describe.ts";
import { ReachProvider } from "./reach-context.tsx";
import { ReferenceControl } from "./reference-control.tsx";
import {
  agentIds,
  canMove,
  hasEnvironment,
  isInLoop,
  isTriggerPointer,
  kindOf,
  nodeAt,
  patchNode,
  setAt,
  withTriggerKind,
  type Doc,
  type Pointer,
} from "./document.ts";
import type { Problem } from "./problems.ts";
import { ProblemList } from "./problem-list.tsx";
import { SchemaTable } from "./schema-table.tsx";

export type ProfileOption = { name: string; version: number };

type Change = (doc: Doc) => void;

type FieldsProps = {
  doc: Doc;
  pointer: Pointer;
  node: Doc;
  problems: readonly Problem[];
  profiles: readonly ProfileOption[];
  onChange: Change;
};

function textOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function TriggerFields({ doc, pointer, node, onChange }: FieldsProps) {
  const kind = textOf(node.kind);
  const kinds: readonly string[] = (
    TRIGGER_KINDS as readonly string[]
  ).includes(kind)
    ? TRIGGER_KINDS.filter(
        (each) => each !== "github.issueLabeled" || kind === each,
      )
    : [...TRIGGER_KINDS.filter((each) => each !== "github.issueLabeled"), kind];
  const patch = (fields: Record<string, unknown>) =>
    onChange(patchNode(doc, pointer, fields));
  return (
    <>
      <SelectControl
        name="kind"
        label="Kind"
        value={kind}
        options={kinds.map((each) => ({
          value: each,
          label: each === "" ? "choose…" : each,
        }))}
        onChange={(next) => onChange(withTriggerKind(doc, pointer, next))}
        hint="Changing the kind starts the fields of the new kind."
      />
      {kind === "ticket.labeled" || kind === "github.issueLabeled" ? (
        <TextControl
          name="label"
          label="Label"
          value={textOf(node.label)}
          onChange={(label) => patch({ label })}
          hint="The label that starts the lane."
        />
      ) : null}
      {kind === "schedule" ? (
        <TextControl
          name="cron"
          label="Cron"
          value={textOf(node.cron)}
          onChange={(cron) => patch({ cron })}
          hint="Five fields separated by one space. Reserved: nothing starts a run from it yet."
        />
      ) : null}
      {kind === "manual" || kind === "api" ? (
        <SchemaTable
          label="Input"
          hint="what the caller hands in"
          value={node.input}
          allowTicket
          onChange={(input) => patch({ input })}
        />
      ) : null}
    </>
  );
}

function ProfileControl({
  node,
  profiles,
  onChange,
  doc,
  pointer,
}: FieldsProps) {
  const value = textOf(node.profile);
  if (profiles.length === 0)
    return (
      <TextControl
        name="profile"
        label="Profile"
        value={value}
        onChange={(profile) => onChange(patchNode(doc, pointer, { profile }))}
        placeholder="name or name@version"
      />
    );
  const options = profiles.flatMap((profile) => [
    { value: profile.name, label: `${profile.name} · newest` },
    {
      value: `${profile.name}@${String(profile.version)}`,
      label: `${profile.name} · v${String(profile.version)}`,
    },
  ]);
  const known = options.some((option) => option.value === value);
  return (
    <SelectControl
      name="profile"
      label="Profile"
      value={value}
      options={[
        ...(value === ""
          ? [{ value: "", label: "Choose a profile…", disabled: true }]
          : known
            ? []
            : [{ value, label: value }]),
        ...options,
      ]}
      onChange={(profile) => onChange(patchNode(doc, pointer, { profile }))}
      hint="Who works and where: harness, model, key, instructions, rights and the runner."
    />
  );
}

function SessionControl({ doc, pointer, node, onChange }: FieldsProps) {
  const session = node.session;
  const continued =
    isRecord(session) && typeof session.continue === "string"
      ? session.continue
      : undefined;
  const ids = agentIds(doc);
  const targets =
    continued === undefined || ids.includes(continued)
      ? ids
      : [continued, ...ids];
  return (
    <>
      <SelectControl
        name="session"
        label="Session"
        value={continued === undefined ? "new" : "continue"}
        options={[
          { value: "new", label: "A new session" },
          { value: "continue", label: "Continue the session of a step" },
        ]}
        onChange={(next) =>
          onChange(
            patchNode(doc, pointer, {
              session:
                next === "new"
                  ? "new"
                  : {
                      continue:
                        ids.find((id) => id !== node.id) ?? ids[0] ?? "",
                    },
            }),
          )
        }
        hint="Continuing keeps the context, in a new sandbox. The step must use the same profile and environment."
      />
      {continued === undefined ? null : (
        <SelectControl
          name="session-step"
          label="Continue the session of"
          value={continued}
          options={targets.map((id) => ({ value: id, label: id }))}
          onChange={(id) =>
            onChange(patchNode(doc, pointer, { session: { continue: id } }))
          }
        />
      )}
    </>
  );
}

function InstructionControl({ doc, pointer, node, onChange }: FieldsProps) {
  const instruction = node.instruction;
  const patch = (value: unknown) =>
    onChange(patchNode(doc, pointer, { instruction: value }));
  if (isRecord(instruction))
    return (
      <>
        <ReferenceControl
          name="instruction-first"
          wants="text"
          label="Instruction, first round"
          at={`${pointer}/instruction/first`}
          value={textOf(instruction.first)}
          multiline
          onChange={(first) => patch({ ...instruction, first })}
        />
        <ReferenceControl
          name="instruction-next"
          wants="text"
          label="Instruction, next rounds"
          at={`${pointer}/instruction/next`}
          value={textOf(instruction.next)}
          multiline
          hint="From round two on, previous.* has the values of the round before."
          onChange={(next) => patch({ ...instruction, next })}
        />
        <Button
          variant="ghost"
          size="sm"
          className="self-start"
          onClick={() => patch(textOf(instruction.first))}
        >
          Same instruction in every round
        </Button>
      </>
    );
  return (
    <>
      <ReferenceControl
        name="instruction"
        wants="text"
        label="Instruction"
        at={`${pointer}/instruction`}
        value={textOf(instruction)}
        multiline
        onChange={patch}
      />
      {isInLoop(doc, pointer) ? (
        <Button
          variant="ghost"
          size="sm"
          className="self-start"
          onClick={() =>
            patch({ first: textOf(instruction), next: textOf(instruction) })
          }
        >
          Different instruction from round two
        </Button>
      ) : null}
    </>
  );
}

function AgentFields(props: FieldsProps) {
  const { doc, pointer, node, problems, onChange } = props;
  const continued = isRecord(node.session);
  const showEnvironment =
    hasEnvironment(node) ||
    problems.some((problem) => problem.path.endsWith("/environment"));
  return (
    <>
      <ProfileControl {...props} />
      <SessionControl {...props} />
      <ReferenceControl
        name="branch"
        label="Start branch"
        at={`${pointer}/branch`}
        value={textOf(node.branch)}
        target={START_BRANCH_ROOTS}
        disabled={continued}
        placeholder="the base branch of the run"
        hint={
          continued
            ? "A step that continues a session keeps that session's branch, so this one is not used. It stays for when the session is new again; until then the lane is not valid."
            : "The branch a session of its own starts from: a literal, or one reference to a trusted value."
        }
        onChange={(branch) =>
          onChange(
            patchNode(doc, pointer, {
              branch: branch === "" ? undefined : branch,
            }),
          )
        }
      />
      <InstructionControl {...props} />
      {showEnvironment ? (
        <TextControl
          name="environment"
          label="Environment"
          value={textOf(node.environment)}
          target="literal"
          hint="Deprecated: the profile says where it runs (#919). Clear the field to use the profile's runner."
          onChange={(environment) =>
            onChange(
              patchNode(doc, pointer, {
                environment: environment === "" ? undefined : environment,
              }),
            )
          }
        />
      ) : null}
      <SchemaTable
        label="Result"
        hint="becomes the agent's finish tool"
        value={node.result}
        onChange={(result) => onChange(patchNode(doc, pointer, { result }))}
      />
    </>
  );
}

/**
 * An action input as text. What is typed is kept as typed while it still stands for the value in the document (a list's newline at the
 * end, a space after a whole reference, `007`); the document gets the parsed value on every change. It lets go of the draft on blur, when
 * the value was changed from elsewhere, or as soon as the draft no longer stands for the value.
 */
function ValueControl({
  name,
  label,
  at,
  control,
  required,
  value,
  multiline,
  target,
  wants,
  placeholder,
  onChange,
}: {
  name: string;
  label: string;
  at: string;
  control: Control;
  required: boolean;
  value: unknown;
  multiline: boolean;
  target?: readonly string[];
  wants?: ReachWants;
  placeholder?: string;
  onChange: (value: unknown) => void;
}) {
  const [draft, setDraft] = useState<string | undefined>(undefined);
  const stands =
    draft !== undefined &&
    canonicalJson(valueOfText(control, draft, required)) ===
      canonicalJson(value);
  if (draft !== undefined && !stands) setDraft(undefined);
  return (
    <ReferenceControl
      name={name}
      label={label}
      at={at}
      value={stands ? draft : textOfValue(value)}
      multiline={multiline}
      {...(target === undefined ? {} : { target })}
      {...(wants === undefined ? {} : { wants })}
      {...(placeholder === undefined ? {} : { placeholder })}
      onChange={(text) => {
        setDraft(text);
        onChange(valueOfText(control, text, required));
      }}
      onBlur={() => setDraft(undefined)}
    />
  );
}

function ActionFields({ doc, pointer, node, onChange }: FieldsProps) {
  const connector = textOf(node.connector);
  const spec = specOf(connector);
  const names =
    spec === undefined && connector !== ""
      ? [connector, ...CONNECTOR_NAMES]
      : CONNECTOR_NAMES;
  return (
    <>
      <SelectControl
        name="connector"
        label="Connector"
        value={connector}
        options={[
          ...(connector === ""
            ? [{ value: "", label: "Choose a connector…", disabled: true }]
            : []),
          ...names.map((name) => ({ value: name, label: name })),
        ]}
        onChange={(next) =>
          onChange(setAt(doc, pointer, withConnector(node, next)))
        }
        hint={spec?.description ?? "What the action does."}
      />
      {spec === undefined
        ? null
        : inputsOf(spec).map(([name, input]) => {
            const control = controlOf(name, input);
            const label = `${name}${input.required ? "" : " (optional)"}`;
            if (control === "boolean")
              return (
                <div
                  key={name}
                  data-field={name}
                  className="flex items-center gap-2"
                >
                  <Checkbox
                    id={`${pointer}-${name}`}
                    checked={node[name] === true}
                    onCheckedChange={(checked) =>
                      onChange(
                        patchNode(doc, pointer, {
                          [name]: checked === true ? true : undefined,
                        }),
                      )
                    }
                  />
                  <label
                    htmlFor={`${pointer}-${name}`}
                    className="text-sm font-semibold"
                  >
                    {name}
                  </label>
                </div>
              );
            return (
              <ValueControl
                key={`${pointer}-${name}`}
                name={name}
                label={label}
                at={pointer}
                control={control}
                required={input.required === true}
                value={node[name]}
                multiline={
                  control === "longText" ||
                  control === "list" ||
                  control === "listOrText"
                }
                {...(input.target === undefined
                  ? {}
                  : { target: input.target })}
                {...(input.target === undefined && input.type.kind === "string"
                  ? { wants: "text" as const }
                  : {})}
                {...(control === "list" || control === "listOrText"
                  ? { placeholder: "one entry to a line, or one {{reference}}" }
                  : control === "numberOrText"
                    ? { placeholder: "a number, or one {{reference}}" }
                    : {})}
                onChange={(next) =>
                  onChange(patchNode(doc, pointer, { [name]: next }))
                }
              />
            );
          })}
    </>
  );
}

function LoopFields({ doc, pointer, node, onChange }: FieldsProps) {
  const rounds = typeof node.maxRounds === "number" ? node.maxRounds : 1;
  return (
    <>
      <Stepper
        label="Max rounds"
        hint="1 to 10"
        value={rounds}
        min={1}
        max={LOOP_ROUNDS_MAX}
        onChange={(maxRounds) =>
          onChange(patchNode(doc, pointer, { maxRounds }))
        }
      />
      <div className="flex flex-col gap-2">
        <span className="text-sm font-semibold">Until</span>
        <ConditionEditor
          label="Until"
          at={`${pointer}/until`}
          value={node.until}
          onChange={(until) => onChange(patchNode(doc, pointer, { until }))}
        />
      </div>
    </>
  );
}

function IfFields({ doc, pointer, node, onChange }: FieldsProps) {
  return (
    <div className="flex flex-col gap-2">
      <span className="text-sm font-semibold">When</span>
      <ConditionEditor
        label="When"
        at={`${pointer}/when`}
        value={node.when}
        onChange={(when) => onChange(patchNode(doc, pointer, { when }))}
      />
    </div>
  );
}

export function Inspector({
  doc,
  pointer,
  problems,
  profiles,
  lookup,
  headingRef,
  onChange,
  onRemove,
  onMove,
}: {
  doc: Doc;
  pointer: Pointer;
  problems: readonly Problem[];
  profiles: readonly ProfileOption[];
  /** What the fields ask for the values they can reach: the builder binds it to its document and lane. */
  lookup: ReachLookup;
  /** The builder moves focus here when a card is picked. */
  headingRef: Ref<HTMLHeadingElement>;
  onChange: Change;
  onRemove: () => void;
  onMove: (direction: -1 | 1) => void;
}) {
  const node = nodeAt(doc, pointer);
  const kind = kindOf(doc, pointer);
  if (node === undefined || kind === undefined)
    return (
      <section
        aria-label="Inspector"
        className="rounded-xl border border-line p-4"
      >
        <p className="text-sm text-muted-foreground">
          {BUILDER_COPY.inspectorEmpty}
        </p>
      </section>
    );
  const described = describeNode(node, kind);
  const fields: FieldsProps = {
    doc,
    pointer,
    node,
    problems,
    profiles,
    onChange,
  };
  return (
    <ReachProvider lookup={lookup}>
      <section
        aria-label="Inspector"
        data-node={pointer}
        className="flex flex-col gap-4 rounded-xl border border-line-strong bg-surface p-4"
      >
        <div className="flex flex-col gap-1">
          <span className="text-xs font-semibold text-muted-foreground uppercase">
            {described.kindLabel}
          </span>
          <h2
            ref={headingRef}
            tabIndex={-1}
            className="text-base font-semibold break-words outline-none"
          >
            {described.title}
          </h2>
        </div>
        <FormField
          name="id"
          label={BUILDER_COPY.idLabel}
          hint={BUILDER_COPY.idHint}
        >
          {(control) => (
            <Input
              {...control}
              value={textOf(node.id)}
              onChange={(event) =>
                onChange(patchNode(doc, pointer, { id: event.target.value }))
              }
            />
          )}
        </FormField>
        <p className="text-sm text-muted-foreground">{KIND_HELP[kind]}</p>
        {kind === "trigger" ? <TriggerFields {...fields} /> : null}
        {kind === "agent" ? <AgentFields {...fields} /> : null}
        {kind === "action" ? <ActionFields {...fields} /> : null}
        {kind === "loop" ? <LoopFields {...fields} /> : null}
        {kind === "if" ? <IfFields {...fields} /> : null}
        {problems.length === 0 ? null : (
          <ProblemList
            doc={doc}
            problems={problems}
            onChange={onChange}
            heading={BUILDER_COPY.errorsHeading}
          />
        )}
        {isTriggerPointer(pointer) ? null : (
          <div className="flex flex-wrap gap-2">
            <Button variant="destructive" size="sm" onClick={onRemove}>
              {BUILDER_COPY.remove}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              disabled={!canMove(doc, pointer, -1)}
              onClick={() => onMove(-1)}
            >
              {BUILDER_COPY.moveUp}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              disabled={!canMove(doc, pointer, 1)}
              onClick={() => onMove(1)}
            >
              {BUILDER_COPY.moveDown}
            </Button>
          </div>
        )}
      </section>
    </ReachProvider>
  );
}
