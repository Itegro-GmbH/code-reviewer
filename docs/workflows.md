# Agent workflows: the format and the API

A **workflow** is a JSON document that says what the factory does when something happens: a trigger, and a list of steps that
run in order. A GitHub issue gets a label, an agent implements it, another reviews, the first fixes what the review found, and a pull
request is opened. Workflows are written by an AI through the API (there is no editor), checked by a strict validator, and saved per
workspace with versions.

**Status (milestone 1 of epic #833).** The format, the validator and the storage exist. **Nothing runs a workflow yet**: the engine,
the profiles table and the finish tool come in the next milestones. A saved workflow is a checked document. The workflows exist only in
a deployment with the capability `implementer` (the factory); there is no page, only the routes below. Every member of a workspace may
use them (the permission `start_implementer_task`).

The format is described by two JSON Schemas, [`contracts/workflow.v1.json`](../contracts/workflow.v1.json) and
[`contracts/result-schema.v1.json`](../contracts/result-schema.v1.json). The validator
([`app/src/workflows/`](../app/src/workflows/README.md)) checks everything the schemas say and what they cannot: that every reference points
at a step that ran before on every path, the types of the values that flow, the limits, and that the profiles and environments exist.

## How an AI should use it: validate, fix, save

1. Write the document.
2. `POST /api/w/<slug>/workflows/validate` with the document as the body. The answer is `200` with `{"valid": false, "errors": [...]}` or
   `{"valid": true, "errors": [], "truncated": false, "budgetUsd": 20, "steps": 6}`. Nothing is stored.
3. Read **every** error. Each has a `path` (a JSON pointer into your document), a `code` (stable: branch on it), a `message` (the cause in a
   sentence) and, where a name was wrong, `available`: the names that exist at that point (steps in reach, fields of a step, profiles,
   environments, connectors). The list is sorted by path, so fix them all, then validate again. It holds **200 errors at most**: when
   `truncated` is `true` there are more (the first ones by path are there); fix these and validate again. A message repeats at most the
   first 64 characters of what you wrote.
4. When it is valid, `POST /api/w/<slug>/workflows` saves it as version 1, or `PUT /api/w/<slug>/workflows/<id>` saves the next version.
   Saving runs the same validator and refuses an invalid document with the same list (`422`, `WORKFLOW_INVALID`).

An answer you will see while fixing:

```json
{
  "valid": false,
  "steps": 3,
  "truncated": false,
  "errors": [
    {
      "path": "/steps/1/body/0/profile",
      "code": "profile_unknown",
      "message": "There is no profile 'reviewer'. Profiles: 'implementer'.",
      "available": ["implementer"]
    },
    {
      "path": "/steps/2/then/0/head",
      "code": "reference_fact_unavailable",
      "message": "The profile 'reviewer@1' may not push, so 'review' yields no branch and no commits. Use a profile that may push, or reference the result of the step.",
      "available": ["findings", "costUsd"]
    }
  ]
}
```

## The document

| Field | Needed | What |
| --- | --- | --- |
| `version` | yes | `1`. |
| `name` | yes | 1 to 100 characters, not only spaces. Unique among the workflows of the workspace that are not archived (case is ignored). |
| `description` | no | Up to 1000 characters. |
| `trigger` | yes | What starts the workflow. |
| `budgetUsd` | no | What the workflow may spend over all its steps, in USD. 20 when left out. Not above the operator's maximum (100 today). |
| `steps` | yes | A list of steps, 1 to 50 in all (counted through branches and loop bodies). |

Every object is **closed**: a field the format does not name is an error (`unknown_field`, with the names that exist). Lengths are counted in
characters (an emoji is one), as the JSON Schema counts them.

## Five kinds of node

Everything else is configuration. The nodes talk to each other only through values; each one has an input and an output, and the validator
holds one to the other.

### The trigger

| `kind` | Fields | What the steps can read |
| --- | --- | --- |
| `manual` | `input` (needed): a [result schema](#result-schemas) that declares what the caller hands in. It must declare **`repo`**, a required text (`owner/name`): the repository the run works on (`repo_required`) | `{{trigger.input.<field>}}`, so `{{trigger.input.repo}}` |
| `github.issueLabeled` | `label` (needed, not only spaces): the label that starts the workflow | `{{trigger.issue.number}}`, `.title`, `.body`, `.url`, `.labels` (a list), and `{{trigger.repo.fullName}}`, `.owner`, `.name`, `.defaultBranch` |

Other triggers (a schedule, Jira) come later. Who may set the label is decided by GitHub, not by the workflow.

### One repository per run, and targets

**A run works on one repository** in version 1: `trigger.repo` of an issue trigger, the input `repo` of a manual one. No agent step and
no action names a repository (a `repo` field is `unknown_field`); they all work on the run's. Several repositories in one run are a later
extension.

The inputs that decide **what the workflow acts on** are *targets*: `issue`, `head`, `base`, the labels `add` and `remove` of an action, and
the `environment` of an agent step. An agent's result is data, never a command, so a target takes only

- a **literal** (`"develop"`, `7`), or
- **exactly one reference**, nothing around it, that starts with `trigger.` (the event: `{{trigger.issue}}`, `{{trigger.repo.defaultBranch}}`,
  `{{trigger.input.issueNo}}` of a manual trigger), or is the **branch of an agent step** (`{{implement.branch}}`, a fact the platform made).

`head` takes a literal or the branch of an agent step that may push, and nothing from the trigger. `base` takes a literal or a reference to the
trigger, not a branch. `environment` takes a literal only: the name of an environment of the workspace, no reference at all. Everything else
(a result field of an agent, a field of an action or a loop, `previous.…`, text around a reference) is refused with
`target_from_untrusted_value`; the message names what the input takes. Free-text inputs (`title`, `body`, `instruction`) take any reference, an
agent's result included: a list becomes lines of text there.

Targets are also **identifiers**: a reference that stands for a branch, a label or a name must be a text or a choice of names, never a number,
true/false or a list turned into text (`reference_type_mismatch`), and an `issue` is a positive whole number or a reference to the issue of
the trigger (`{{trigger.issue}}`, `{{trigger.issue.number}}`) or to a number the caller hands in.

### The agent step (`"kind": "agent"`)

A run of an agent step gets a **profile** and an **environment**, separately: who works and where.

| Field | Needed | What |
| --- | --- | --- |
| `id` | yes | The name other steps use to refer to it: a letter, then letters, digits, `_` or `-` (64 at most). `trigger` and `previous` are taken. Unique in the whole document, also inside branches and loops. |
| `profile` | yes | `name` (the newest version) or `name@version` (a pinned version). Until profiles are data (next milestone) the only profile is **`implementer`**, version 1: today's Implementer, which may push. The validator lists the names that exist (`profile_unknown`, `profile_version_unknown`). |
| `environment` | yes | The name of an environment of the workspace (the Environments page; case is ignored), as a literal: a [target](#one-repository-per-run-and-targets), so no reference (`target_from_untrusted_value`). |
| `instruction` | yes | The task: a text, or `{"first": "...", "next": "..."}` in a loop body (`first` in round one, `next` from round two on, where `previous.*` exists). |
| `session` | no | `"new"` (the default) or `{"continue": "<step id>"}`: go on in the session of an agent step that ran before on every path with **the same profile name and the same environment**, or of **this step itself** when it is a direct step of a loop body (round two continues round one; not inside an `if` of the body, where the step may not have run). |
| `result` | no | What the agent's result looks like, a [result schema](#result-schemas). The agent gets a finish tool made from it. Without one the step yields the facts only (and, later, the default schema of its profile). |
| `description` | no | A note. |

**What an agent step yields**, for `{{<id>.<field>}}`: the fields of its `result`, and the **facts** the platform knows without the agent
reporting them: `costUsd` (always), and `branch` and `commits` (a list of commit ids) **only if the profile may push**. For a profile that
may push, `branch` is **always there**: the platform creates the branch when the turn starts, so it exists even when the agent made no commit
(`commits` is then an empty list). A step run with a profile that may not push has no branch and no commits, and a reference to them is
refused (`reference_fact_unavailable`). Result fields named `costUsd`, `branch` or `commits` are refused (`result_field_reserved`). A `result`
that fails its own check binds its fields as unknown: you get the errors of the schema, not one for every use of a field.

### The action (`"kind": "action"`)

No model, no agent: the platform does what the action says, against the target the workflow names. An agent's result is data, never a
command; consequences (a comment, a pull request) happen only here. The inputs sit on the node itself.

| `connector` | Inputs (`*` needed) | Yields |
| --- | --- | --- |
| `github.pullRequest.open` | `head`\* (a branch: a literal or `{{<agent>.branch}}`), `title`\*, `base` (a branch: a literal or a reference to the trigger; the default branch if left out), `body`, `draft` (true/false) | `number`, `url` |
| `github.issue.comment` | `issue`\* (a positive whole number, or a reference to the issue of the trigger), `body`\* | `url` |
| `github.issue.labels` | `issue`\*, `add` (a list of labels), `remove` (a list), at least one of `add` and `remove` | `labels` (the labels the issue has now) |

The action works on the repository of the run. `head`, `base`, `issue`, `add` and `remove` are [targets](#one-repository-per-run-and-targets). With
the trigger `github.issueLabeled` an action may **not add the label that starts the workflow** (case ignored): the workflow would start itself
again (`label_retriggers_workflow`); removing it is fine. A connector that does not exist is refused (`unknown_connector`). Nothing here executes yet.

### Control: `if` and `loop`

`if` has `when` (a [condition](#conditions)), `then` (a list of steps) and optionally `else`. Afterwards `{{<id>.taken}}` is `then` or `else`.

`loop` has `maxRounds` (needed, a whole number from **1 to 10**), `body` (steps) and `until` (a condition, checked after every round, with the
steps of the body in reach). The body runs at least once. The loop ends when `until` holds (exit `until`), after `maxRounds` rounds (exit
`maxRounds`) or when the workflow budget is used up **between two rounds** (exit `budget`; a round always runs to its end). Afterwards
`{{<id>.exit}}` is `until`, `maxRounds` or `budget`, and `{{<id>.rounds}}` the number of rounds that ran. Loops may be nested once (a loop in a
loop); `if` and `loop` together nest 4 levels deep at most.

### Reserved: `forEach`, `approval` and a workflow as a step

The format names `forEach`, `approval` and `workflow` (a workflow used as a step of another) so that documents can use them later. Version 1
refuses them with `kind_not_supported`; their other fields are not defined yet and are not checked.

## References and data flow

A text may hold `{{step.field}}`: the value of a field of an earlier step, or of the trigger. No code, no functions.

- `{{step.field | default <JSON>}}` gives a value for a field that may be missing: `{{previous.review.findings | default []}}`,
  `{{work.notes | default "none"}}`. The default must fit the field's type (`default_type_mismatch`).
- The default is a JSON value of any shape; it may hold braces (`{{a.o | default {}}}`) and strings with `}}` (`{{a.t | default "}}"}}`). A
  reference ends at the first `}}` that is not inside a JSON string and does not close a `{` of the default; braces nest 3 deep at most.
- `\{{` is a literal `{{` (in JSON: `"\\{{"`). A text with escapes only is a literal; it is compared without the backslash.
- A text that is **exactly one reference** (no space, no text around it) keeps the type of the value (an action input that wants a list or an
  issue number takes `"{{trigger.issue}}"`). Where a number, true/false or a list is wanted, a text that is not exactly one reference is
  `wrong_type`, also `"{{a}} {{b}}"` and a `{{` that is never closed. In any other text, references become text: a string as it is, a number or true/false as `3` or `true`, a list **one
  entry per line starting with `- `** (an entry that is an object as one line of JSON, an empty list as nothing). An **object** has no text form inside a text:
  refer to one of its fields (`reference_type_mismatch`, with the field names).

### Which steps a reference can reach: "ran before on every path"

The scope follows the structure of the document:

1. A step can use the steps that come **before it in the same list**, and the trigger. Not itself, not a later one (`reference_to_later_step`).
2. **Inside a loop body**: the steps of the body that came before. **After the loop**: the steps of the body, with the values of the **last round**,
   and the loop itself (`exit`, `rounds`). Inside its own body the loop's result does not exist yet.
3. **Inside an `if` branch**: what came before the `if`, and the earlier steps of the same branch. **After the `if`: only the `if` itself**
   (`taken`). Ids are unique in the document, so no step is produced by both branches, and nothing a branch made is certain to exist;
   its values stay inside the branch (`reference_not_in_scope`). To use a branch's value afterwards, put the use in the branch.
4. `previous.<step>.<field>` is the value a **direct step of the innermost loop body** had in the round **before**. It exists from round two.
   So it may be used in `instruction.next`, or anywhere with a `| default`; in `instruction.first` or any other place without a default it
   is refused (`previous_without_default`), outside a loop it is refused (`previous_outside_loop`), and a step inside an `if` of the body is not
   named (`previous_unknown_step`: it may not have run). `previous.` names the steps of the **innermost** loop only; a step of an outer loop is used without it.
5. A field that is **not required** in a result schema may be missing, so referring to it needs a default (`reference_optional_field`).

### Types

Every value has a type from the result schema subset (text, number, true/false, a choice of names, list, object). A reference is held to what
its place wants: a number where a number is wanted, a list of texts where `add` wants one. A text is accepted anywhere a text is wanted
(any scalar and any list has a text form), an object only where an object with at least the needed fields is wanted. A mismatch is
`reference_type_mismatch`; a literal of the wrong JSON type is `wrong_type`.

## Conditions

One operator per condition:

| Operator | Value | Holds when |
| --- | --- | --- |
| `empty`, `notEmpty` | one operand (a reference to a list or a text) | the list or text is empty / is not |
| `equals`, `notEquals` | `[a, b]`: two operands | equal / not equal: two texts (a choice of names counts as text), two numbers, or two true/false values |
| `all`, `any` | a list of conditions (at least one) | all / at least one holds |
| `not` | a condition | it does not hold |

An operand is a reference (`"{{review.findings}}"`), a text, a number or true/false. Comparing something with a choice of names it can never
be gives `condition_value_not_in_enum` (with the names it can be). Conditions nest 4 levels deep at most.

## Result schemas

The `result` of an agent step (and the `input` of a manual trigger) is a small subset of JSON Schema, [`contracts/result-schema.v1.json`](../contracts/result-schema.v1.json):
the root is an object; a field is a `string` (optionally with `enum`, a list of the allowed names), `number`, `boolean`, `array` (with
`items`) or `object` (with `properties`). `required` lists the fields that must be there; objects are closed; `description` helps the agent.

```json
{
  "type": "object",
  "required": ["findings"],
  "properties": {
    "findings": {
      "type": "array", "maxItems": 20,
      "items": {
        "type": "object",
        "required": ["type", "name"],
        "properties": {
          "type": {"type": "string", "enum": ["bug", "risk", "nit"]},
          "name": {"type": "string", "maxLength": 120},
          "description": {"type": "string"}
        }
      }
    }
  }
}
```

Caps: a string is held to `maxLength` (10000 characters when not given, 100000 at most), a list to `maxItems` (100 when not given, 1000 at most), an
`enum` has 50 values at most, an object 50 fields, a schema 100 fields in all and 4 levels of objects and lists. The agent's finish tool
(next milestone) is made from the same schema and checks what the agent hands in with the same code (`checkResultValue`, `app/src/workflows/result-schema.ts`).

## The first workflow

The plan's "Issue to PR", as version 1 states it (with the profile `implementer` for both steps, the only one that exists until profiles
are data; the review step is told not to change anything. Replace `node` by the name of an environment of your workspace). It validates
clean; this block is checked against [`contracts/examples/workflow/Workflow.json`](../contracts/examples/workflow/Workflow.json) by a test.

```json
{
  "version": 1,
  "name": "Issue to PR",
  "description": "Implement the issue, have it reviewed, fix until the review finds nothing (3 rounds at most), then open the pull request; otherwise comment on the issue.",
  "trigger": {
    "kind": "github.issueLabeled",
    "label": "ready for agent"
  },
  "budgetUsd": 20,
  "steps": [
    {
      "id": "start",
      "kind": "action",
      "connector": "github.issue.labels",
      "issue": "{{trigger.issue}}",
      "remove": [
        "ready for agent"
      ],
      "add": [
        "agent working"
      ]
    },
    {
      "id": "fix",
      "kind": "loop",
      "maxRounds": 3,
      "body": [
        {
          "id": "implement",
          "kind": "agent",
          "profile": "implementer@1",
          "environment": "node",
          "session": {
            "continue": "implement"
          },
          "instruction": {
            "first": "{{trigger.issue.title}}\n\n{{trigger.issue.body}}",
            "next": "Fix these review findings:\n{{previous.review.findings}}"
          },
          "result": {
            "type": "object",
            "required": [
              "summary"
            ],
            "properties": {
              "summary": {
                "type": "string",
                "description": "What was done, for the pull request."
              }
            }
          }
        },
        {
          "id": "review",
          "kind": "agent",
          "profile": "implementer@1",
          "environment": "node",
          "session": "new",
          "instruction": "Review branch {{implement.branch}} against the issue. Do not change anything.",
          "result": {
            "type": "object",
            "required": [
              "findings"
            ],
            "properties": {
              "findings": {
                "type": "array",
                "maxItems": 20,
                "items": {
                  "type": "object",
                  "required": [
                    "type",
                    "name",
                    "description"
                  ],
                  "properties": {
                    "type": {
                      "type": "string",
                      "enum": [
                        "bug",
                        "risk",
                        "nit"
                      ]
                    },
                    "name": {
                      "type": "string",
                      "maxLength": 120
                    },
                    "description": {
                      "type": "string"
                    }
                  }
                }
              }
            }
          }
        }
      ],
      "until": {
        "empty": "{{review.findings}}"
      }
    },
    {
      "id": "done",
      "kind": "if",
      "when": {
        "equals": [
          "{{fix.exit}}",
          "until"
        ]
      },
      "then": [
        {
          "id": "pr",
          "kind": "action",
          "connector": "github.pullRequest.open",
          "head": "{{implement.branch}}",
          "title": "{{trigger.issue.title}}",
          "body": "{{implement.summary}}\n\nCloses #{{trigger.issue.number}}"
        }
      ],
      "else": [
        {
          "id": "stuck",
          "kind": "action",
          "connector": "github.issue.comment",
          "issue": "{{trigger.issue}}",
          "body": "Stopped after {{fix.rounds}} rounds. Open findings:\n{{review.findings}}"
        }
      ]
    }
  ]
}
```

How it reads: label the issue `ready for agent`, and `start` swaps the labels. The loop `fix` (3 rounds at most): `implement` works (in
round two it continues its own session and is told the findings of the review before), `review` looks at the branch and returns
`findings`; the loop ends when there are none. `done` then opens the pull request when the loop ended with `until`, and otherwise comments
the open findings on the issue. `{{review.findings}}` after the loop is the last round's.

## The API

All routes are under `/api/w/<slug>/workflows`, need a signed in member of the workspace, and answer `Cache-Control: no-store`. The body of a
write is the document itself (`Content-Type: application/json`, 256 KB at most). A refusal is `{"error": <code>, "message": ...}` with a stable
code from the table below.

| Route | What | Answer |
| --- | --- | --- |
| `POST /workflows/validate` | Checks the document against the format and the workspace's environments. Stores nothing. | `200` `{valid, errors, steps, budgetUsd?}` (also for an invalid document) |
| `POST /workflows` | Validates and saves as **version 1**. | `201` `{workflow}`; `422` `WORKFLOW_INVALID` with `errors` |
| `PUT /workflows/<id>` | Validates and saves as the **next version**; the name is taken from the document. `?expectedVersion=n` saves only if `n` is still current (a race gives `409` `WORKFLOW_VERSION_CONFLICT` with `current`). | `200` `{workflow}` |
| `GET /workflows` | The workflows of the workspace by name. | `200` `{workflows: [{id, name, version, createdAt, updatedAt}], maximum}` |
| `GET /workflows/<id>` | The workflow with its current version, or `?version=n`. | `200` `{workflow: {id, name, version, documentVersion, document, versions: [{version, savedAt}]}}` |

Every save is a **new, immutable version**; an identical document is saved again as a new version. A workspace holds 100 workflows, a workflow
200 versions. Deleting is not offered yet.

## Error codes

### Of the document (`errors[].code`)

Form (the JSON Schema says the same, and a test holds the two together):

| Code | Meaning | What to do |
| --- | --- | --- |
| `wrong_type` | A value of the wrong JSON type (a text where an object belongs, a number where a text belongs). | Use the type the message names. |
| `unknown_field` | A key the format does not have here. | Remove it, or use one of `available`. |
| `missing_field` | A key that is needed is absent. | Add it; the message says what it holds. |
| `invalid_value` | The right type, a value the field does not take (a pattern, a range, a list of names). | Follow the message; `available` lists the allowed names. |
| `unknown_kind` | A step `kind` that does not exist. | Use one of `available`. |
| `unknown_trigger_kind` | A trigger `kind` that does not exist. | Use one of `available`. |
| `unknown_connector` | A connector that does not exist. | Use one of `available`. |
| `limit_exceeded` | A number or length above what the format allows. | Lower it to the limit the message names. |

Beyond the form:

| Code | Meaning | What to do |
| --- | --- | --- |
| `kind_not_supported` | `forEach`, `approval` or `workflow`: reserved, not available in version 1. | Build it from `agent`, `action`, `if`, `loop`. |
| `duplicate_id` | Two steps with one id. | Give each step its own id. |
| `template_syntax` | A `{{ }}` that is not a reference, a default that is no JSON (or nests braces more than 3 deep), or a `{{` never closed. | Fix the text; write `\\{{` for a literal `{{`. |
| `reference_unknown_step` | A reference starts with a name that is no step. | Use one of `available` (the steps in reach). |
| `reference_to_later_step` | The step comes later, is the step itself, or contains it. | Move the use after the step, or use another step. |
| `reference_not_in_scope` | The step ran earlier but not on every path to here (inside a branch). | Use it inside its branch, or restructure. |
| `reference_unknown_field` | The step has no such field. | Use one of `available`. |
| `reference_optional_field` | The field is not required, so it may be missing. | Make it `required` in the result schema, or add `\| default <JSON>`. |
| `reference_fact_unavailable` | `branch` or `commits` of a step whose profile may not push. | Use a profile that may push, or another value. |
| `reference_type_mismatch` | The value does not fit where it is used. | Use a value of the type the message names, or a field of an object. |
| `default_type_mismatch` | The default does not fit the field's type. | Give a default of that type. |
| `previous_outside_loop` | `previous.` outside a loop body. | Use it inside a loop. |
| `previous_without_default` | `previous.` where round one has no value. | Use it in `instruction.next`, or add a default. |
| `previous_unknown_step` | `previous.<id>` names no step of the innermost loop body that always runs (the message says whether it belongs to an outer loop, sits in an `if`, or is no step of the body). | Use one of `available`, or the step without `previous.`. |
| `condition_operand_type` | An operand of the wrong type, or two that cannot be compared. | Compare like with like; `empty` takes a list or a text. |
| `condition_value_not_in_enum` | A text compared with a choice of names that can never hold it. | Use one of `available`. |
| `instruction_next_outside_loop` | `instruction.next` in a step that is not in a loop. | Use a plain text, or put the step in a loop. |
| `session_target_invalid` | `session.continue` names no agent step that ran before on every path, or one with another profile name or environment, or the step itself where it is not a direct step of a loop body. | Use one of `available`, with the same profile and environment. |
| `profile_unknown` | No such profile. | Use one of `available`. |
| `profile_version_unknown` | The profile has no such version. | Use one of `available`, or leave the version out. |
| `environment_unknown` | No such environment in the workspace. | Use one of `available`, or create it on the Environments page. |
| `result_field_reserved` | A result field named like a platform fact (`costUsd`, `branch`, `commits`). | Rename it. |
| `required_field_unknown` | `required` of a result schema names a field that is not in `properties`. | Fix the name or add the property. |
| `repo_required` | A manual trigger without `input` that declares `repo` as a required text: the run has no repository. | Declare `repo` in `properties` and `required` of the trigger's `input`. |
| `target_from_untrusted_value` | An input that decides a target (`issue`, `head`, `base`, `add`, `remove`, `environment`) holds more than a literal or one reference to the trigger or to the branch of an agent step. | Use a literal, or exactly one reference the message names. |
| `label_retriggers_workflow` | An action adds the label that starts the workflow. | Remove the label instead, or add another one. |
| `too_many_steps` | More than 50 steps. | Split the workflow. |
| `nesting_too_deep` | `if`/`loop` too deep, a loop in a loop in a loop, conditions or a result schema nested too deep. | Flatten it. |
| `result_schema_too_large` | A result schema with more than 100 fields in all. | Make it smaller. |
| `budget_above_maximum` | `budgetUsd` above the operator's maximum. | Lower it to the maximum the message names. |

### Of the routes (`error`)

| Code | Status | Meaning |
| --- | --- | --- |
| `WORKFLOW_REQUEST_INVALID` | 400 | The body is not JSON, or a query value is not a whole number. |
| `WORKFLOW_CROSS_SITE_REQUEST` | 403 | The request comes from another site. |
| `WORKFLOW_NOT_FOUND` | 404 | No such workflow in this workspace (another workspace's looks the same). |
| `WORKFLOW_VERSION_NOT_FOUND` | 404 | The workflow has no such version. |
| `WORKFLOW_NAME_TAKEN` | 409 | The workspace has a workflow of that name (case ignored). |
| `WORKFLOW_LIMIT_REACHED` | 409 | The workspace holds 100 workflows (`maximum`). |
| `WORKFLOW_VERSION_LIMIT_REACHED` | 409 | The workflow holds 200 versions (`maximum`). |
| `WORKFLOW_VERSION_CONFLICT` | 409 | `expectedVersion` is not current any more (`current` says which is). |
| `WORKFLOW_BODY_TOO_LARGE` | 413 | The body is over 256 KB. |
| `WORKFLOW_CONTENT_TYPE_UNSUPPORTED` | 415 | The body is not `application/json`. |
| `WORKFLOW_INVALID` | 422 | The document does not pass the validator; `errors` lists every problem. |

The routes of a workspace that is not yours, and in a deployment without the capability, are the 404 of a path that does not exist.
