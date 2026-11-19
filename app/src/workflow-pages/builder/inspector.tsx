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
import { laneMcpServers } from "../../workflows/mcp.ts";
import { START_BRANCH_ROOTS } from "../../workflows/connectors.ts";
import type { ReachWants } from "../../workflows/reach.ts";
import { TRIGGER_KINDS } from "../../workflows/triggers.ts";
import {
  CONNECTOR_NAMES,
  controlOf,
  inputRequired,
  inputsOf,
  isPullRequestStep,
  specOf,
  withPullRequestRepos,
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
  agentIdsWithRepos,
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
import {
  stepMcpEntries,
  withStepServer,
  type McpServerOption,
} from "./mcp-edit.ts";
import { McpPicker } from "./mcp-picker.tsx";
import { ReposControl } from "./repos-control.tsx";

export type ProfileOption = { name: string; version: number };

type Change = (doc: Doc) => void;

type FieldsProps = {
  doc: Doc;
  pointer: Pointer;
  node: Doc;
  problems: readonly Problem[];
  profiles: readonly ProfileOption[];
  /** The status names of the project's board (#1036), for the fields of a status trigger; empty: none to offer, the name is typed. */
  statuses: readonly string[];
  /** The MCP servers of the workspace (#1052), for the picker of an agent step. */
  mcpServers: readonly McpServerOption[];
  onChange: Change;
};

function textOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * The name of a board status (#1036): a choice among the names of the project's board, with the current name kept as an option when the
 * board has no such name (nothing is rewritten), or typed when the project has no board to offer. `optional`: "any" stands for none.
 */
function StatusControl({
  name,
  label,
  value,
  statuses,
  optional,
  hint,
  onChange,
}: {
  name: string;
  label: string;
  value: string;
  statuses: readonly string[];
  optional?: boolean;
  hint: string;
  onChange: (value: string) => void;
}) {
  if (statuses.length === 0)
    return (
      <TextControl
        name={name}
        label={label}
        value={value}
        onChange={onChange}
        hint={hint}
      />
    );
  return (
    <SelectControl
      name={name}
      label={label}
      value={value}
      options={[
        ...(optional === true ? [{ value: "", label: "any status" }] : []),
        ...(value === "" || statuses.includes(value)
          ? []
          : [{ value, label: value }]),
        ...statuses.map((status) => ({ value: status, label: status })),
      ]}
      onChange={onChange}
      hint={hint}
    />
  );
}

function TriggerFields({
  doc,
  pointer,
  node,
  statuses,
  onChange,
}: FieldsProps) {
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
      {kind === "ticket.statusChanged" ? (
        <>
          <StatusControl
            name="to"
            label="Moved into"
            value={textOf(node.to)}
            statuses={statuses}
            hint="The status that starts the lane, as the board names it. Whoever moves a ticket into it starts a run, the lane's own moves included: the lane must not move a ticket into this status itself."
            onChange={(to) => patch({ to })}
          />
          <StatusControl
            name="from"
            label="Moved out of"
            value={textOf(node.from)}
            statuses={statuses}
            optional
            hint="Optional: only a move out of this status starts the lane."
            onChange={(from) => patch({ from: from === "" ? undefined : from })}
          />
          {statuses.length === 0 ? (
            <p role="note" className="text-sm text-muted-foreground">
              A move starts no run until the lane&apos;s project has chosen a
              board: only moves on that board count. Choose one in the
              project&apos;s settings.
            </p>
          ) : null}
        </>
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

/** The MCP servers of an agent step (#1052): the lane's servers to narrow to, or the sentence that the lane names none. */
function McpControl({ doc, pointer, node, mcpServers, onChange }: FieldsProps) {
  const entries = stepMcpEntries(doc, node, mcpServers);
  if (entries.length === 0)
    return (
      <p className="text-xs text-muted-foreground">
        {BUILDER_COPY.mcpStepLaneEmpty}
      </p>
    );
  const lane = laneMcpServers(doc);
  return (
    <>
      <McpPicker
        name={`mcp-${pointer}`}
        label={BUILDER_COPY.mcpStepTitle}
        hint={BUILDER_COPY.mcpStepHint}
        entries={entries}
        onToggle={(id, checked) =>
          onChange(withStepServer(doc, pointer, lane, id, checked))
        }
      />
      {entries.every((entry) => !entry.checked) ? (
        <p className="text-xs text-muted-foreground">
          {BUILDER_COPY.mcpStepNone}
        </p>
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
      <ReposControl
        doc={doc}
        pointer={pointer}
        node={node}
        continued={continued}
        onChange={onChange}
      />
      <InstructionControl {...props} />
      <McpControl {...props} />
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

const OTHER_REPOS = "__other__";

/**
 * The `repos` of a pull request step (#1094): a choice among the agent steps that have repositories (`{{<id>.repos}}`), "one branch" for the
 * single form, or another reference typed. Choosing one takes `head` and `base` out of the document (the validator refuses them next to
 * `repos`); choosing "one branch" puts the empty `head` back.
 */
function PullRequestReposControl({
  doc,
  pointer,
  node,
  onChange,
}: Pick<FieldsProps, "doc" | "pointer" | "node" | "onChange">) {
  const ids = agentIdsWithRepos(doc);
  const references = ids.map((id) => `{{${id}.repos}}`);
  const [custom, setCustom] = useState(false);
  const current = typeof node.repos === "string" ? node.repos : undefined;
  const typed =
    node.repos !== undefined &&
    (current === undefined || !references.includes(current));
  const selected =
    node.repos === undefined && !custom
      ? ""
      : typed || custom
        ? OTHER_REPOS
        : (current ?? "");
  const write = (repos: string): void =>
    onChange(setAt(doc, pointer, withPullRequestRepos(node, repos)));
  return (
    <>
      <SelectControl
        name="repos"
        label="Repositories (optional)"
        value={selected}
        options={[
          { value: "", label: "One branch of the repository of the run" },
          ...ids.map((id) => ({
            value: `{{${id}.repos}}`,
            label: `Every repository of step ${id}`,
          })),
          { value: OTHER_REPOS, label: "Another reference" },
        ]}
        onChange={(next) => {
          if (next === OTHER_REPOS) {
            setCustom(true);
            return;
          }
          setCustom(false);
          write(next);
        }}
        hint="One pull request for every repository of an agent step that has its own branch with commits, each into its own base. Then the step takes no head and no base."
      />
      {selected === OTHER_REPOS ? (
        <ValueControl
          key={`${pointer}-repos-text`}
          name="repos"
          label="repos reference"
          at={pointer}
          control="text"
          required={false}
          value={node.repos}
          multiline={false}
          target={["repos"]}
          placeholder="one {{reference}} to the repositories of an agent step"
          onChange={(next) => write(typeof next === "string" ? next : "")}
        />
      ) : null}
    </>
  );
}

function ActionFields({ doc, pointer, node, statuses, onChange }: FieldsProps) {
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
            // #1094: a pull request step with `repos` opens each pull request from the branch of its entry: no `head`, no `base`.
            if (
              node.repos !== undefined &&
              (name === "head" || name === "base")
            )
              return null;
            if (name === "repos" && isPullRequestStep(connector))
              return (
                <PullRequestReposControl
                  key={`${pointer}-repos`}
                  doc={doc}
                  pointer={pointer}
                  node={node}
                  onChange={onChange}
                />
              );
            const control = controlOf(name, input);
            const required = inputRequired(spec, name, input);
            const label = `${name}${required ? "" : " (optional)"}`;
            // The status a `ticket.setStatus` step sets (#1040): a choice among the statuses of the project's board or Jira workflow
            // (the same names the status trigger offers); a project with none to offer keeps the plain literal field.
            if (
              connector === "ticket.setStatus" &&
              name === "status" &&
              statuses.length > 0
            )
              return (
                <StatusControl
                  key={`${pointer}-${name}`}
                  name={name}
                  label={label}
                  value={textOf(node[name])}
                  statuses={statuses}
                  hint="The name of the status to move the ticket into: a board column (GitHub) or the status a Jira transition ends in. A literal."
                  onChange={(next) =>
                    onChange(patchNode(doc, pointer, { [name]: next }))
                  }
                />
              );
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
                required={required}
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
  statuses = [],
  mcpServers = [],
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
  /** The status names of the project's board, for a status trigger (#1036). Left out: none are offered. */
  statuses?: readonly string[];
  /** The MCP servers of the workspace (#1052). Left out: none. */
  mcpServers?: readonly McpServerOption[];
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
    statuses,
    mcpServers,
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
