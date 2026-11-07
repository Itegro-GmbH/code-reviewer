# Agent workflows: the format and the API

A **workflow** is a JSON document that says what the factory does when something happens: a trigger, and a list of steps that
run in order. A GitHub issue gets a label, an agent implements it, another reviews, the first fixes what the review found, and a pull
request is opened. Workflows are written by an AI through the API (there is no editor), checked by a strict validator, and saved per
workspace with versions.

**Status (milestones 1 to 5 of epic #833).** The format, the validator, the storage, the [profiles](profiles.md) they refer to, the
**engine**, the three GitHub actions, the **label trigger** and the **control steps** `if` and `loop` exist: a workflow with the manual trigger can be started through the API, and a
workflow with a `ticket.labeled` trigger (`github.issueLabeled` before #916) starts when somebody puts its label on an issue (see [Engine](#engine), [Control at run time](#control-at-run-time) and [The label trigger](#the-label-trigger));
either runs its steps in the order the document says, in rounds where there is a loop. A member can [cancel a run](#cancelling-a-run), and a workflow can clean up after a failed or cancelled run with [`onFailure`](#after-a-failure-onfailure). Not yet: an editor.
The finish tool exists (see [Result schemas](#result-schemas)). The workflows exist only in
a deployment with the capability `implementer` (the factory); there is no editor, but the routes below and, for the runs, [pages](#the-run-page). Every member of a workspace may
use them (the permission `start_implementer_task`).

The format is described by two JSON Schemas, [`contracts/workflow.v1.json`](../contracts/workflow.v1.json) and
[`contracts/result-schema.v1.json`](../contracts/result-schema.v1.json). The validator
([`app/src/workflows/`](../app/src/workflows/README.md)) checks everything the schemas say and what they cannot: that every reference points
at a step that ran before on every path, the types of the values that flow, the limits, and that the [profiles](profiles.md) and environments of the workspace exist.

## How an AI should use it: validate, fix, save

1. Write the document.
2. `POST /api/w/<slug>/workflows/validate` with the document as the body. The answer is `200` with `{"valid": false, "errors": [...]}` or
   `{"valid": true, "errors": [], "truncated": false, "budgetUsd": 20, "steps": 6}`. Nothing is stored.
3. Read **every** error. Each has a `path` (a JSON pointer into your document), a `code` (stable: branch on it), a `message` (the cause in a
   sentence) and, where a name was wrong, `available`: the names that exist at that point (steps in reach, fields of a step, profiles,
   environments, connectors). The list is sorted by path, so fix them all, then validate again. It holds **200 errors at most**: the check
   runs in document order and stops once it has found a few more than that, so when `truncated` is `true` there are more (the ones found
   first are there, not necessarily the first by path); fix these and validate again. A list of names (`available`, and the names in a
   message) holds the first 20, and a message says how many more there are. A message, a path and a name in `available` repeat at most the
   first 64 characters of what you wrote (a longer key is cut and ends in `…`, so its path points near it). Below a result-schema field
   name that is refused nothing is checked: fix the name, validate again.
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
| `triggers` | yes (or `trigger`) | The triggers that start the workflow, 1 to 10, each with pre-steps of its own ([The triggers](#the-triggers-and-their-pre-steps)). |
| `trigger` | no | The single trigger of the format before #916. Still accepted: it is read as `triggers` with this one entry and no pre-steps. A document has `triggers` or `trigger`, not both. |
| `budgetUsd` | no | What the workflow may spend over all its steps, in USD. 20 when left out. Not above the operator's maximum (100 today). |
| `steps` | yes | A list of steps, 1 to 50 in all (counted through branches and loop bodies, `onFailure` included). |
| `onFailure` | no | Steps that run once after the run ended `failed` or `cancelled` ([After a failure](#after-a-failure-onfailure)). Left out: the run ends at once, as it always did. |

Every object is **closed**: a field the format does not name is an error (`unknown_field`, with the names that exist). Lengths are counted in
characters (an emoji is one), as the JSON Schema counts them.

## Five kinds of node

Everything else is configuration. The nodes talk to each other only through values; each one has an input and an output, and the validator
holds one to the other.

### The triggers and their pre-steps

A workflow has **several triggers** (`triggers`, 1 to 10). Each one starts the workflow its own way and has its own **pre-steps**; when it
fires, the engine runs its pre-steps and then the **shared steps** (`steps`). Every trigger must end with the same context, so the shared steps
may only read what **every** trigger yields.

```jsonc
"triggers": [
  { "id": "labeled", "kind": "ticket.labeled", "label": "agent implement", "steps": [] },
  { "id": "manual", "kind": "manual", "input": { "type": "object", "required": ["ticket"], "properties": { "ticket": { "type": "ticket" } } },
    "steps": [ { "id": "mark", "kind": "action", "connector": "ticket.labels", "ticket": "{{trigger.ticket}}", "add": ["agent implement"] } ] }
]
```

| Field | Needed | What |
| --- | --- | --- |
| `id` | yes | A letter, then letters, digits, `_` or `-` (64 at most); `trigger` and `previous` are taken. Unique among the triggers (`duplicate_id`). The start API takes it as `"trigger"`. |
| `kind` | yes | One of the kinds below. |
| `steps` | no | The pre-steps: the form of `steps`, may be empty. They see the values of their own trigger only. Their ids are unique in the whole document, with the shared steps and `onFailure` (`duplicate_id`). |

| `kind` | Other fields | What the steps can read (`{{trigger.<field>}}`) |
| --- | --- | --- |
| `ticket.labeled` | `label` (needed, not only spaces): the label that starts the workflow | `trigger.ticket` (below), and, as workflows written before #916 read them, `trigger.issue.number` (an integer), `.title`, `.body`, `.url`, `.labels` and `trigger.repo.fullName`, `.owner`, `.name`, `.defaultBranch`. `github.issueLabeled` is the old name of this kind and is accepted wherever it was |
| `manual` | `input` (needed): a [result schema](#result-schemas) that declares what the caller hands in. It must declare **`ticket`** (type `ticket`, required: the run works in the repository of the ticket) or **`repo`**, a required text (`owner/name`) (`repo_required`) | `trigger.input.<field>` (without `ticket`), and `trigger.ticket` when the input requires one |
| `api` | the same as `manual` | the same. It is started through the API only; the start form of the web app offers `manual` triggers |
| `pullRequest.pushed` | none | reserved: the format validates it, the engine starts no run from it yet |
| `schedule` | `cron` (needed): five fields separated by one space | reserved, like `pullRequest.pushed` |

`trigger.id` and `trigger.kind` (`ticket.labeled`, `manual`, …) are readable facts of every trigger. A run of a workflow written with the old
`trigger` has the id `labeled` or `manual` and the kind `ticket.labeled` or `manual`.

**What the shared steps may read.** The shared steps (and `onFailure`) read the part of `trigger` that all triggers yield. `trigger.ticket` is
there only when every trigger yields a ticket; when one does not, the reference is `reference_not_in_scope` and the message names a trigger
that lacks it. `trigger.input.…` is there when every trigger has an input with that field. A pre-step's own steps are not in reach of the
shared steps: only the values of the trigger are. With one trigger nothing changes: it is all in reach.

**The ticket.** A **ticket** is the work item a run is about, named by a reference like `github:owner/repo#128` (the provider, the repository,
the number; GitHub is the provider so far, the shape is provider neutral). The input type `ticket` takes such a reference; the engine resolves
it through the provider when the run starts, and the steps read it as `{{trigger.ticket.…}}`:

| Field | What |
| --- | --- |
| `number` | the number (an integer) |
| `title`, `body` | free text from whoever opened the ticket: read in texts, never a [target](#one-repository-per-run-and-targets) |
| `labels` | the names of its labels (a list; free text too) |
| `type` | the kind of ticket the platform reports (GitHub's issue type, `Bug`), empty when it has none |
| `assignees` | the logins of the people it is assigned to (a list) |
| `url` | its web address |
| `repo` | the repository: `repo.fullName`, `.owner`, `.name`, `.defaultBranch` |

A label trigger yields the same ticket from the webhook (`type` and `assignees` are filled when GitHub's payload has them, else empty), so a
step reads `{{trigger.ticket.number}}` whichever trigger fired. `trigger.ticket` is a **target**: one trusted value that names the issue (see
below). `ticket` is a field of the input itself and it is called `ticket`: not inside a list or an object, and not in the result of an agent
step (`invalid_value`). A caller hands it in as text (`"input": { "ticket": "github:itegro/shop#128" }`); a text that is no reference, or a provider
that is not known, is refused when the run starts (`WORKFLOW_RUN_INPUT_INVALID`).

**Pre-steps** are the place to make the contexts alike: a manual trigger puts the label on the ticket that a label trigger arrives with (`mark`
above), then the shared steps do the work once. A step in a pre-step may be anything a step may be; it runs under the same budget as the rest.
The label an `ticket.labeled` trigger waits for is not added again by the bot's own writes: the webhook ignores them. So
`label_retriggers_workflow` is raised for a step that adds a label that starts the workflow in the **shared** steps and in the pre-steps of the
**label trigger** itself, and not for a pre-step of a trigger that is no label trigger (the example above adds the label of `labeled` in the
pre-step of `manual`, which is right).

Why a pre-step may add the label of **another** trigger and a shared step may not add any trigger's label: the webhook ignores the App's own
writes, so a label a step adds never fires a trigger by itself. That makes it safe for the pre-step of `manual` to put the label of `labeled` on
the ticket: that pre-step runs for `manual` only, never for the trigger whose label it adds, and it is how one context is made like the other.
A shared step has no such place: it runs for **every** trigger, so the label it adds is always the label of a trigger it also runs for. The
document would then state, in its own steps, that a run puts back the label that started it, and only the webhook's exemption would keep that
from looping. The validator does not rely on that exemption for the steps that run for every trigger, so they may add none of the labels that
start the workflow, and the pre-step of a label trigger may not add its own. Two `ticket.labeled` triggers may not wait for the same label
(`duplicate_trigger_label`, case does not matter): one label would start two runs. The JSON Schema cannot say that, the validator does, and
reports it at the `label` of the second trigger, naming the first.

Other triggers (Jira) come later. Who may set the label is decided by GitHub, not by the workflow. How a label starts a run: [The label trigger](#the-label-trigger).

### One repository per run, and targets

**A run works on one repository** in version 1: the one of the ticket (`trigger.ticket.repo` of a label trigger and of a trigger with a `ticket` input), or the input `repo` of a manual one. No agent step and
no action names a repository (a `repo` field is `unknown_field`); they all work on the run's. Several repositories in one run are a later
extension.

The inputs that decide **what the workflow acts on** are *targets*: `issue`, `head`, `base`, the labels `add` and `remove` of an action, and
the `environment` of an agent step. An agent's result is data, never a command, and so is what whoever opened the issue wrote (its title, body
and labels): anyone who can open an issue could steer a run through them. So a target takes only

- a **literal** (`"develop"`, `7`), or
- **exactly one reference**, nothing around it, to one of the few values the platform or the caller vouches for. Which ones depends on the input:

| Input | A literal | A reference to |
| --- | --- | --- |
| `issue`, `ticket` | a positive whole number, 1 to 2147483647 | `{{trigger.ticket}}` or `{{trigger.ticket.number}}` (the ticket the run is about), `{{trigger.issue}}` or `{{trigger.issue.number}}` (the issue a label started), or an input of a manual trigger declared `integer` (`{{trigger.input.issueNo}}`) |
| `add`, `remove` | label names | an input of a manual trigger: `{{trigger.input.label}}` as an entry, or `{{trigger.input.labels}}` as the whole list |
| `base` | a branch name | `{{trigger.ticket.repo.defaultBranch}}`, `{{trigger.repo.defaultBranch}}`, or an input of a manual trigger (`{{trigger.input.base}}`) |
| `head` | a branch name | `{{<agent step>.branch}}`, the branch of an agent step that may push (a fact the platform made) |
| `environment` | the name of an environment | nothing: a literal only |

Everything else (a result field of an agent, a field of an action or a loop, `previous.…`, `trigger.issue.title`, `.body` or `.labels`, text
around a reference, `trigger.ticket.title`, `.body`, `.labels`) is refused with `target_from_untrusted_value`; the message names what the input takes. Free-text inputs (`title`, `body`,
`instruction`) take any reference, an agent's result and the title of the issue included: a list becomes lines of text there. A manual
trigger's input is what the caller of the run (a person or an AI with the right to run workflows) hands in, so it is taken like a literal.

Targets are also **identifiers**: a reference that stands for a branch, a label or a name must be a text or a choice of names, never a number,
true/false or a list turned into text (`reference_type_mismatch`). An `issue` is a whole number, so a manual input used as one must be declared
`integer` (a `number` may have a fraction, which the validator cannot rule out). The **default** of a reference (`{{trigger.input.issueNo | default 7}}`)
is held to the rule of a literal: `default 0`, `default -3` or `default 2147483648` is `invalid_value`, `default 1.5` is `default_type_mismatch`. The same
holds for the `number` in the default of an object input (`default {"number": -5}`).
The bounds of an input the caller hands in are not known to the validator (an `integer` may be `0` or `-5`), so **the engine checks the number
again when it runs**.

### The agent step (`"kind": "agent"`)

A run of an agent step gets a **profile** and an **environment**, separately: who works and where.

| Field | Needed | What |
| --- | --- | --- |
| `id` | yes | The name other steps use to refer to it: a letter, then letters, digits, `_` or `-` (64 at most). `trigger` and `previous` are taken. Unique in the whole document, also inside branches and loops. |
| `profile` | yes | `name` (the newest version) or `name@version` (a pinned version) of a [profile](profiles.md) of the workspace that is not archived. No profile is built in: people create them through `/api/w/<slug>/profiles`, and the validator lists the names that exist (`profile_unknown`; `profile_archived` for one that was archived) and the versions (`profile_version_unknown`). The version the step runs decides what it yields: whether it may push (`branch`, `commits`) and its default result schema. |
| `environment` | yes | The name of an environment of the workspace (the Environments page; case is ignored), as a literal: a [target](#one-repository-per-run-and-targets), so no reference (`target_from_untrusted_value`). |
| `instruction` | yes | The task: a text, or `{"first": "...", "next": "..."}` in a loop body (`first` in round one, `next` from round two on, where `previous.*` exists). |
| `session` | no | `"new"` (the default) or `{"continue": "<step id>"}`: go on in the session of an agent step that ran before on every path with **the same profile name and the same environment**, or of **this step itself** when it is a direct step of a loop body (round two continues round one; not inside an `if` of the body, where the step may not have run). |
| `branch` | no | The branch a session of its own **starts from**, instead of the base branch of the run: a literal, `{{trigger.repo.defaultBranch}}`, an input of a manual trigger, or `{{<agent step>.branch}}`, the branch of an earlier agent step that may push (it ran before on every path; a profile that may not push yields no branch, `reference_fact_unavailable`). It decides what the agent works on, so it is a [target](#one-repository-per-run-and-targets): nothing an agent wrote (`target_from_untrusted_value`). Not together with `session.continue` (`session_target_invalid`): a session that goes on keeps its branch. See [Branches](#branches-and-what-a-step-starts-from). |
| `result` | no | What the agent's result looks like, a [result schema](#result-schemas). The agent gets a finish tool made from it. Without one the step yields the facts and the fields of the default result schema of its profile (if the profile version has one). |
| `description` | no | A note. |

**What an agent step yields**, for `{{<id>.<field>}}`: the fields of its `result`, and the **facts** the platform knows without the agent
reporting them: `costUsd` (always), and, **only if the profile may push**, `branch`, `commits` (a list of commit ids, oldest first), `headCommit`
(the last commit of the branch, or the commit the branch started from when the agent made none) and `pushed` (true/false: whether the branch reached
the remote). For a profile that may push, `branch` is **always there**: the platform creates the branch when the turn starts, so it exists even when
the agent made no commit (`commits` is then an empty list). A step run with a profile that may not push has none of these four, and a reference to
them is refused (`reference_fact_unavailable`). Result fields named `costUsd`, `branch`, `commits`, `headCommit` or `pushed` are refused (`result_field_reserved`). A `result`
that fails its own check binds its fields as unknown: you get the errors of the schema, not one for every use of a field.

### The action (`"kind": "action"`)

No model, no agent: the platform does what the action says, against the target the workflow names. An agent's result is data, never a
command; consequences (a comment, a pull request) happen only here. The inputs sit on the node itself.

| `connector` | Inputs (`*` needed) | Yields |
| --- | --- | --- |
| `github.pullRequest.open` | `head`\* (a branch: a literal or `{{<agent>.branch}}`), `title`\*, `base` (a branch: a literal, `{{trigger.repo.defaultBranch}}` or a manual input; the default branch if left out), `body`, `draft` (true/false) | `number`, `url` |
| `github.issue.comment` | `issue`\* (a positive whole number, `{{trigger.issue}}` or `{{trigger.issue.number}}`, or a manual input declared `integer`), `body`\* | `url` |
| `github.issue.labels` | `issue`\*, `add` (a list of labels), `remove` (a list), at least one **entry** in `add` and `remove` together (`add: [], remove: []` is `missing_field`) | `labels` (the labels the issue has now) |
| `ticket.comment` | `ticket`\* (as `issue`: a number, `{{trigger.ticket}}`, `{{trigger.ticket.number}}`, …), `body`\* | `url` |
| `ticket.labels` | `ticket`\*, `add`, `remove` as `github.issue.labels` | `labels` |

`ticket.comment` and `ticket.labels` are the provider-neutral names of the two actions on a ticket (#916): GitHub is the provider so far, and they
do what `github.issue.comment` and `github.issue.labels` do, on the issue of the run's repository. They are allowed in `onFailure` like those.

The action works on the repository of the run. `head`, `base`, `issue`, `ticket`, `add` and `remove` are [targets](#one-repository-per-run-and-targets). With
a label trigger an action may **not add the label that starts the workflow** (case ignored): the workflow would start itself
again (`label_retriggers_workflow`); removing it is fine. A connector that does not exist is refused (`unknown_connector`). The engine runs an action
through a connector it has: the three GitHub connectors run on a server that has the GitHub App, and a step whose connector is not there ends with
`connector_unavailable` (see [Engine](#engine) and [GitHub actions](#github-actions)).

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

### After a failure: `onFailure`

`onFailure` is a list of steps beside `steps`. They run **once, after the run ended `failed` or `cancelled`**, and never after `succeeded`. The run keeps the final status it was going to have
(`failed` with its error code, or `cancelled`); the steps only clean up. A document without `onFailure` is valid and behaves as before.

- **What they may be.** An `action` of `ticket.comment` or `ticket.labels` (or the older `github.issue.comment` and `github.issue.labels`), and an `if` over such actions (to tell a cancel from a failure, for example). No agent step, no `loop`, no
  `github.pullRequest.open` (`on_failure_step_not_allowed`): after a failure nothing starts an agent or opens a pull request.
- **What they can read.** `{{trigger.…}}` as in any step, the facts of the failure, and the `onFailure` steps before them. **Not the steps of the workflow**: after a failure any of them may not have run
  (`reference_not_in_scope`). The id `failure` is taken in `onFailure`; ids are unique in the document as a whole.
- **The facts of the failure** (`{{failure.<fact>}}`, all texts):

  | Fact | Holds |
  | --- | --- |
  | `status` | `failed` or `cancelled`: how the run ends. |
  | `stepId` | The step the failure belongs to: the step that failed, the agent step the budget could not pay, the `if` or `loop` whose condition could not be told, the step a cancel stopped. Empty when no step does (a run cancelled before its first step). |
  | `code` | The code of that step (`no_result`, `timeout`, `github_not_found`, …), or the code of the run (`budget_exhausted`, `condition_failed`); `cancelled` for a cancel. |
  | `message` | A short sentence (300 characters at most) about why. |

  They are **data, not commands**: none of them is a [target](#one-repository-per-run-and-targets) (`target_from_untrusted_value`), and `code` and `message`, which may quote a connector, GitHub or a runner,
  go into a comment **defused** like the text an agent wrote or the title of an issue (no mention of a person or team, no `Closes #n`, no comment marker, see [Results and facts](#results-and-facts)).
- **When they run.** After a step failed, the budget ended the run (`budget_exhausted`; they cost nothing, so they run), a condition could not be told (`condition_failed`), or a member cancelled the run
  (after its agent has stopped, [Cancelling a run](#cancelling-a-run)). They do **not** run when the run could not even start (`workflow_owner_gone`) or its steps do not fit its document (`document_unusable`):
  nothing of such a run can be trusted to act on an issue.
- **A step of `onFailure` that fails** is recorded (the run page shows it, with its code) and the next one runs; it is never repeated and starts nothing else. The run ends with the status it was going to have.
  A cancel asked for while they run changes nothing: the run ends `failed` and they finish.

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

Every value has a type from the result schema subset (text, number, whole number (`integer`, also a number), true/false, a choice of names, list, object). A reference is held to what
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
the root is an object; a field is a `string` (optionally with `enum`, a list of the allowed names), `number`, `integer`, `boolean`, `array` (with
`items`) or `object` (with `properties`); `integer` is a whole number, within the range a computer holds exactly (±9007199254740991), and the type of a number that names something (an issue). `required` lists the fields that must be there; objects are closed; `description` helps the agent.

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

**`ticket` (#916)** is one more type, for the `input` of a `manual` or `api` trigger only: `{"type": "ticket"}`, a text like `github:owner/repo#128` (the provider, the
repository, the number). It is the one field of the input itself called `ticket`: not inside an array or an object, under no other name, and not in the `result` of an agent step (`invalid_value`).
A value is checked like the others (`wrong_type` for a non-text, `invalid_value` for a text that is no reference or names a provider that is not known, with the providers as `available`). The engine
resolves it through the provider when the run starts and the steps read it as `{{trigger.ticket}}` ([The triggers](#the-triggers-and-their-pre-steps)).

Caps: a string is held to `maxLength` (10000 characters when not given, 100000 at most), a list to `maxItems` (100 when not given, 1000 at most), an
`enum` has 50 values at most, an object 50 fields, a schema 100 fields in all and 4 levels of objects and lists.

**The finish tool (#843).** A task (and, with the engine, an agent step) that has a result schema gives its agent a tool made from it: the name, the
description and the parameters are derived from the schema, and the agent decides itself when it is done. What the agent hands in is checked
against the schema twice with the same rules: in its container, for fast feedback (a wrong result is refused with every problem listed and the
agent corrects it and calls again), and by Control after the container is gone (the runner's `finish_tool.py`, which is held to
`checkResultValue` of `app/src/workflows/result-schema.ts` by [`contracts/result-check-vectors.json`](../contracts/result-check-vectors.json),
cases that both implementations are tested against). A result is data of an untrusted writer and is bounded before it is parsed: 256 KiB, 8
levels, 20,000 values. See [`implementer.md`](implementer.md#the-finish-tool) for how the tool reaches the agent, and what a turn without a result is.

The app keeps the value as data (`implementer_turns.result_value`, with `result_schema` beside it) and holds it to the bounds, but it does **not** check
it against the schema. **The engine re-checks `result_value` with `checkResultValue` against the turn's stored schema before it routes
the value anywhere** (to a condition, a step input, a workflow's output): a stored value is the agent's data, and the runner's verdict is not the
engine's. A value that fails is treated as a step without a result.

## The first workflow

The plan's "Issue to PR", as version 1 states it, with the two profiles it needs: `implementer` (may push; the example at the end of
[`profiles.md`](profiles.md#todays-implementer-as-a-profile)) and `reviewer` (may not push, and answers with `findings`; the example at the
start of [`profiles.md`](profiles.md#a-profile)). Create both first. The review step is told not to change anything as well. Replace `node` by the name of
an environment of your workspace. It validates
clean; this block is checked against [`contracts/examples/workflow/Workflow.json`](../contracts/examples/workflow/Workflow.json) by a test.

```json
{
  "version": 1,
  "name": "Issue to PR",
  "description": "Implement the ticket, have it reviewed, fix until the review finds nothing (3 rounds at most), then open the pull request; otherwise comment on the ticket. A label starts it, or a person by hand: the manual trigger puts the label on first, so both arrive at the same context.",
  "triggers": [
    {
      "id": "labeled",
      "kind": "ticket.labeled",
      "label": "agent implement",
      "steps": []
    },
    {
      "id": "manual",
      "kind": "manual",
      "input": {
        "type": "object",
        "required": ["ticket"],
        "properties": {
          "ticket": {
            "type": "ticket",
            "description": "The ticket to implement, like github:owner/repo#128."
          }
        }
      },
      "steps": [
        {
          "id": "mark",
          "kind": "action",
          "connector": "ticket.labels",
          "ticket": "{{trigger.ticket}}",
          "add": ["agent implement"]
        }
      ]
    }
  ],
  "budgetUsd": 20,
  "steps": [
    {
      "id": "start",
      "kind": "action",
      "connector": "ticket.labels",
      "ticket": "{{trigger.ticket}}",
      "remove": ["agent implement"],
      "add": ["agent working"]
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
            "first": "{{trigger.ticket.title}}\n\n{{trigger.ticket.body}}",
            "next": "Fix these review findings:\n{{previous.review.findings}}"
          },
          "result": {
            "type": "object",
            "required": ["summary"],
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
          "profile": "reviewer@1",
          "environment": "node",
          "session": "new",
          "branch": "{{implement.branch}}",
          "instruction": "Review branch {{implement.branch}} against the issue. Do not change anything.",
          "result": {
            "type": "object",
            "required": ["findings"],
            "properties": {
              "findings": {
                "type": "array",
                "maxItems": 20,
                "items": {
                  "type": "object",
                  "required": ["type", "name", "description"],
                  "properties": {
                    "type": {
                      "type": "string",
                      "enum": ["bug", "risk", "nit"]
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
        "equals": ["{{fix.exit}}", "until"]
      },
      "then": [
        {
          "id": "pr",
          "kind": "action",
          "connector": "github.pullRequest.open",
          "head": "{{implement.branch}}",
          "title": "{{trigger.ticket.title}}",
          "body": "{{implement.summary}}\n\nCloses #{{trigger.ticket.number}}"
        }
      ],
      "else": [
        {
          "id": "stuck",
          "kind": "action",
          "connector": "ticket.comment",
          "ticket": "{{trigger.ticket}}",
          "body": "Stopped after {{fix.rounds}} rounds. Open findings:\n{{review.findings}}"
        }
      ]
    }
  ],
  "onFailure": [
    {
      "id": "report",
      "kind": "action",
      "connector": "ticket.comment",
      "ticket": "{{trigger.ticket}}",
      "body": "The agent stopped before a pull request was ready ({{failure.status}} at step {{failure.stepId}}, {{failure.code}}): {{failure.message}}"
    },
    {
      "id": "release",
      "kind": "action",
      "connector": "ticket.labels",
      "ticket": "{{trigger.ticket}}",
      "remove": ["agent working"],
      "add": ["agent failed"]
    }
  ]
}
```

How it reads: label the issue `agent implement` (the trigger `labeled`), or start it by hand with `{"trigger": "manual", "input": {"ticket": "github:owner/repo#128"}}`: the pre-step `mark` of the manual trigger puts the label on, so both arrive at the same context. Then `start` swaps the labels. The loop `fix` (3 rounds at most): `implement` works (in
round two it continues its own session and is told the findings of the review before), `review` looks at the branch and returns
`findings`; the loop ends when there are none. `done` then opens the pull request when the loop ended with `until`, and otherwise comments
the open findings on the issue. `{{review.findings}}` after the loop is the last round's. The engine runs this workflow end to end ([Control at run time](#control-at-run-time)); a label starts it
([The label trigger](#the-label-trigger)).

`review` is a session of its own (`"session": "new"`) and starts **from the branch of `implement`** (`"branch": "{{implement.branch}}"`), so it reads the code the implementer wrote, in every round
([Branches](#branches-and-what-a-step-starts-from)). It declares its `result` although the profile `reviewer` brings the same default: the example then validates and reads without the profile at hand.

**When a step fails inside the loop** (or the budget ends the run, or a member cancels it) the run ends as `failed` (or `cancelled`), no pull request is opened, and `onFailure` runs: `report` comments on the issue what stopped
the run (the step, its code and a short message, defused), and `release` takes `agent working` off and puts `agent failed` on. It cannot put `agent implement` back: that label starts the workflow, so adding it is refused
(`label_retriggers_workflow`); a person puts it on again when the issue should be tried again. The run keeps its status; the page shows the two steps after the one that failed ([After a failure](#after-a-failure-onfailure)).

## The API

All routes are under `/api/w/<slug>/workflows`, need a signed in member of the workspace, and answer `Cache-Control: no-store`. The body of a
write is the document itself (`Content-Type: application/json`, 256 KB at most). A refusal is `{"error": <code>, "message": ...}` with a stable
code from the table below.

| Route | What | Answer |
| --- | --- | --- |
| `POST /workflows/validate` | Checks the document against the format and the workspace's environments. Stores nothing. | `200` `{valid, errors, truncated, steps, budgetUsd?}` (also for an invalid document) |
| `POST /workflows` | Validates and saves as **version 1**. | `201` `{workflow}`; `422` `WORKFLOW_INVALID` with `errors` and `truncated` (as the validate call gives them) |
| `PUT /workflows/<id>` | Validates and saves as the **next version**; the name is taken from the document. `?expectedVersion=n` saves only if `n` is still current (a race gives `409` `WORKFLOW_VERSION_CONFLICT` with `current`). | `200` `{workflow}` |
| `GET /workflows` | The workflows of the workspace by name, **not the archived ones**. | `200` `{workflows: [{id, name, version, createdAt, updatedAt, archivedAt}], maximum}` |
| `GET /workflows/<id>` | The workflow with its current version, or `?version=n`. An archived workflow is readable too. | `200` `{workflow: {id, name, version, archivedAt, documentVersion, document, versions: [{version, savedAt}]}}` |
| `DELETE /workflows/<id>` | **Archives** the workflow (a soft delete). Asked again, it answers the same. | `200` `{workflow}` with `archivedAt` set; `404` `WORKFLOW_NOT_FOUND`; `409` `WORKFLOW_ARCHIVE_LIMIT_REACHED` |

Every save is a **new, immutable version**: the database refuses to change a saved version (there is no UPDATE of a version; only the erasure
of a whole workspace deletes rows). An identical document is saved again as a new version. A workspace holds 100 workflows that are not
archived and 1000 archived workflows, a workflow 500 versions. Old versions are not pruned: a run will name the version it started with (milestone 3), so none may vanish
under it. A workflow that reaches its 500 versions is archived and written again under its name.

**Archiving** is the only delete in version 1. An archived workflow is hidden from the list, takes no new version (`409`
`WORKFLOW_ARCHIVED`), is never started (the engine reads `archivedAt`), does not count against the 100, and **gives its name back**: a new
workflow may use it. Its versions stay readable by id. There is no way back yet. The archive is bounded so that archiving and creating again
cannot grow the rows for ever: with 1000 archived workflows in a workspace one more **cannot be archived** (`409`
`WORKFLOW_ARCHIVE_LIMIT_REACHED`, with `maximum`); creating, saving and reading go on. Every member may do everything in a workspace (no role is checked), so
the count, not a role, is the bound; there is no way to remove archived workflows yet (a follow-up).

### For the engine (milestone 3)

What the engine keeps to (milestone 3a keeps all of it); the validator and the routes assume it.

- **An archived workflow is never started**: the engine refuses it (it reads `archivedAt`), and a trigger lookup (which workflow does this
  label start?) filters the archived ones out.
- **Environments are matched by name, case ignored**, here and when a run starts (`PYTHON` finds `Python`); names are unique in a workspace
  that way.
- **A session may continue across versions of one profile**: `implementer@1` may continue the session of a step that ran as
  `implementer@2`, because the session belongs to the profile *name* (and the environment), not to its version. This is kept on purpose.
- **The engine checks the targets again** (an issue number is a positive whole number up to 2147483647, a label or a branch a text) when it
  runs: what the validator checks is what the document says, and an input of a manual trigger is only known then.
- **The engine never expands a template inside a default value.** The default of a reference is a JSON value written out, taken as it is:
  `{{a.t | default "{{b.x}}"}}` yields the text `{{b.x}}`, not the value of `b.x`, and the validator does not look for references in it
  either. A default that must hold a value of a step is not possible; give the field a value in the step that makes it, or branch with `if`.

## Engine

*Milestones 3 and 5 of epic #833; the code is [`app/src/workflow-runs/`](../app/src/workflow-runs/README.md).* The engine takes a saved workflow
version and runs it: one **run** per start, one **step run** per time a step runs (a step in a loop has one for every round). It runs `agent` and `action` steps in the order the
document says, and the control steps `if` and `loop` ([Control at run time](#control-at-run-time)). A workflow starts with the **manual** trigger or a **label** on an issue
(milestone 4, [The label trigger](#the-label-trigger)). A node of a kind the engine does not run (the reserved kinds, which the validator refuses anyway) is refused when a
run is started by hand (`WORKFLOW_RUN_STEP_KIND_NOT_SUPPORTED`, with the step named) and left out when a label would start it, before anything costs money.

### Starting a run

`POST /api/w/<slug>/workflows/<id>/runs` with `{"trigger": "manual", "input": {...}, "clientRequestId": "..."}`, for every member (the permission to start an Implementer
task, `start_implementer_task`: a run starts tasks). `trigger` is the `id` of one of the workflow's [triggers](#the-triggers-and-their-pre-steps) of the kind `manual` or `api`; it may be left out
when the workflow has exactly one of them (a workflow written with the single `trigger` has one). `input` must fit the `input` schema of that trigger (checked again here with the same rules as a
result: a start knows the values). The repository of the run is the ticket's when the input has a `ticket`, else `input.repo` (`owner/name`); either is a repository of the workspace. The answer is
`201 {"run": {...}}`, with the run and its steps; the pre-steps of the trigger and then the shared steps start right after the answer.

```jsonc
{ "trigger": "manual", "input": { "ticket": "github:itegro/shop#128" }, "clientRequestId": "…" }
```

A `ticket` is resolved through the GitHub App of the workspace when the run starts (`trigger.ticket` holds what it answered, bounded; the run keeps it, so a step reads one
snapshot). `404 WORKFLOW_RUN_TICKET_NOT_FOUND` when the repository has no issue of that number (a pull request is none), `404 WORKFLOW_RUN_TRIGGER_UNKNOWN` for a trigger id the workflow does not
have, `422 WORKFLOW_RUN_TRIGGER_NOT_MANUAL` for a trigger that is not started by hand, `400 WORKFLOW_RUN_REQUEST_INVALID` when no trigger is named and several can be started. A run stores
`trigger` (its kind) and `triggerId` (the trigger of the document), also in the list. The start form of the web page is made from the input of a `manual` trigger, one form each when there are several.

- **Idempotent.** The same `clientRequestId` with the same workflow, trigger and input answers `200` with the run it made before and writes nothing;
  another workflow or input under that id is `409 WORKFLOW_RUN_REQUEST_REUSED` (with `runId`). The id is 1 to 200 printable ASCII characters
  without a space.
- **The version is pinned.** The run uses the version the workflow has at the start; saving a new version later changes nothing under it.
- `GET /api/w/<slug>/workflows/<id>/runs/<runId>` answers `200 {"run": {...}}` with the steps; `GET .../runs` lists the newest 50 runs of the workflow
  (without steps). A run of another workspace, or of another workflow, is `404`.

### Cancelling a run

`POST /api/w/<slug>/workflows/<id>/runs/<runId>/cancel` (no body), for every member (`start_implementer_task`: whoever may start a run may stop one). The answer says what the call did
(`outcome`) and carries the run:

| Outcome | Status | Meaning |
| --- | --- | --- |
| `requested` | 202 | The run runs and is marked. The turn of its step is asked to stop; the run ends `cancelled` when that turn has ended. |
| `already_requested` | 200 | Somebody asked before; nothing changed (the engine is told again, which is harmless). |
| `already_ended` | 200 | The run is over (`succeeded`, `failed` or `cancelled`); nothing changed, the run shows how it ended. |

`404 WORKFLOW_RUN_NOT_FOUND` for a run of another workspace or workflow. What happens, in this order:

1. The run is marked (`cancelRequestedAt`) under the lock of the run. From then on the engine writes and starts no step. A step that was written and not claimed ends `skipped`; steps the walk had not reached
   are not written at all (there is no row for a branch that never began).
2. The job of the turn that runs is asked to stop (`jobs.cancel_requested_at`). A turn that still waits for a runner ends at once (`cancelled`, nothing ran, no record counts, the hold is given back).
   A turn that runs is told by its next heartbeat (`cancelRequested: true`; every 30 seconds on the Worker, at most 60 on a customer's runner): the Worker or the runner ends the agent the way it does when it is stopped (SIGTERM), pushes what is
   committed, takes the snapshot when that is cheap, and reports `cancelled` with the usage it measured. The lease check before that push still says `held`, and the heart keeps beating until the agent's process has ended, so the lease cannot lapse during the stop. See [Implementer](implementer.md#cancelling-a-run-891).
3. The job ends `cancelled` (code `cancelled`, a stable code) with that report; billing charges what the turn used and nothing else. A holder that never reports (it died, it heard nothing) is not waited for for ever: the job is
   ended by the app after a grace of 4 minutes, or when its lease lapses, or when its claim is given back; none of these queues the turn again.
4. The engine reads the end of the turn like any other: the step ends `failed` with the code `cancelled` (its cost is what the runner reported; a turn that never ran, because no runner took it or its Worker could not be started, is booked at no cost; one that ran and reported nothing is booked as the limit, as for any step), and the run ends
   `cancelled`, without `errorCode` (after its [`onFailure`](#after-a-failure-onfailure) steps, when the workflow has them: the agent has stopped by then). A turn that finished by itself in the same moment keeps its result; the run still ends `cancelled`.
5. A step whose turn was queued behind another instruction of its session (`session.continue`) discards that instruction first, so no turn starts later that no run reads. A turn that starts after the stop (the claimant was
   in the middle of starting it) is asked to stop by the one that started it, so no turn runs on that nobody wants.

An action that runs is not interrupted (it is a call of at most 60 seconds and may have happened); the run ends after it. A cancel changes no label by itself: a workflow with [`onFailure`](#after-a-failure-onfailure) cleans up after the agent has stopped (the facts have `status` `cancelled`); without it the issue keeps `agent working` and the label is taken off by hand. Stopping the task of an agent step on its own (the [Implementer route](implementer.md#cancelling-a-run-891)) ends
the run `cancelled` the same way, not `failed`.

A run looks like this (a step is `pending` when written, `running` once claimed, then `succeeded` or `failed`; a step of the branch an `if` did not take is written `skipped`):

```json
{
  "run": {
    "id": "7f0c…", "workflowId": "…", "workflowVersion": 3, "trigger": "manual", "actorLogin": "octocat", "status": "running", "errorCode": null,
    "triggerId": "manual", "budgetUsd": 20, "spentUsd": 0.42, "repositoryId": "…", "baseBranch": "main", "input": {"input": {"repo": "acme/widgets", "topic": "caching"}},
    "createdAt": "…", "updatedAt": "…", "finishedAt": null,
    "steps": [
      { "id": "plan", "position": 0, "kind": "agent", "status": "succeeded", "round": 1, "profile": {"name": "worker", "version": 1},
        "jobId": "…", "turnId": "…", "costUsd": 0.42, "costBasis": "reported", "output": {"summary": "…", "costUsd": 0.42, "branch": "workflow/7f0c…/plan"},
        "errorCode": null, "errorMessage": null, "createdAt": "…", "startedAt": "…", "finishedAt": "…" }
    ]
  }
}
```

`jobId` and `turnId` link an agent step to its Implementer run (the live view of that run shows what the agent does). `costBasis` says where `costUsd` comes
from (`reported`, `estimated` or `limit`, see [The budget over all steps](#the-budget-over-all-steps)); it is null for a step that was charged nothing. `trigger` is what
started the run (`manual`, `api`, `ticket.labeled` or, on rows written before #916, `github.issueLabeled`) and `triggerId` the trigger of the document that did, and `actorLogin` who: the person who started it, or whoever put the label on. It is for display and decides nothing.
For a run a label started, `input` is `{"issue": {...}, "repo": {...}}` ([The label trigger](#the-label-trigger)); the run page shows the trigger and the login and asks for no starter.

### What the engine does

- **An agent step starts an Implementer turn** through the same service as a task started by hand (`startTask`), as the person who started the
  run (a run a label started has no person: its turns belong to the account that owns the workflow, see [The label trigger](#the-label-trigger)). The **profile** is the version the step pins; a profile **without a version** means the newest version **at the moment the step starts**,
  and that version is stored with the step run. The **environment** is found by name (case ignored). The **instruction** is the step's text with its
  references filled in. The step's `result` schema (or the default of the profile version) becomes the finish tool. The turn works on a branch
  the platform names, `workflow/<run id>/<step id>`, which starts from the base branch of the run (the default branch of the repository at the start of the run) or, when the step names
  one, from its `branch` ([Branches](#branches-and-what-a-step-starts-from)).
- **A turn that ends moves the run on.** The runner API tells the engine when the job of a turn ends; the engine then reads the job, the turn and
  its session **from the database** (the event only says which run to look at) and ends the step. A job that ends without anybody reporting it (its lease
  ran out) is found by the sweep, which looks again at every run that was not touched for a minute.
- **Idempotent, also in parallel.** A doubled or late event, a sweep and an event at the same time, or two servers: every decision is made under a lock
  on the run, from the state the lock shows, so the second one finds what the first did and changes nothing. A step is claimed by a guarded update, so one
  worker does it; an agent step is started under a request id made from the run and the position, so starting it twice yields one turn. An action
  that was interrupted is **not** repeated (it may have happened): its step ends as `action_interrupted`.
- **A turn that exists is never lost.** The engine can die after the turn was started and before the step recorded it. Before a step is given up
  (`agent_start_failed`, after an hour without a job), and whenever the Implementer refuses the repeat of its request, the engine looks for a turn under
  the request id of the step (`wf-<run id>-<position>`). A turn it finds is attached to the step, read like any other, and its cost is charged to the run.
- **A step can wait for its session.** A `session.continue` step asks the Implementer for the next turn of the session. While a turn of that session runs, its instruction is queued behind it
  (one place); when a person has queued an instruction there already (`IMPLEMENTER_SESSION_BUSY`), the step does **not** fail: it stays claimed without a job and asks again about every two minutes
  (when its claim is stale), until its turn exists or it is given up after an hour (`agent_start_failed`). When it is given up, its own queued instruction is **discarded** (reason
  `workflow_gave_up`, [`implementer.md`](implementer.md#follow-ups)), so that no turn starts later with no step to read it and no budget behind it; a turn that started in that moment is attached to the step instead.
- **A failure of the engine never fails the end of a turn.** The hook runs after the completion is stored; if it throws, the completion is
  answered and stored as it would have been, the failure is logged by its code only, and the sweep picks the run up again.

### Results and facts

An agent step yields the **result** of the agent and the **facts** the platform measured (`costUsd`, and, if the profile may push, `branch`, `commits`,
`headCommit`, `pushed`). Before any part of the result is used, **the engine checks `result_value` against the turn's stored `result_schema` again**
with `checkResultValue`; a value that fails, a missing value or a turn that ended with `no_result` makes the step fail with `no_result`. A result is
data: it can be put into a text (an instruction, a comment), never into a target, and nothing in it is read again as a template.

### References at run time

`{{trigger.input.x}}`, `{{step.field}}`, `{{step.branch}}` and the rest are resolved as the validator defines them.

- A text that is exactly one reference keeps the type of the value; in any other text a value becomes text (a list: one entry per line starting with `- `).
- **Values are data.** A text is built in one pass; what a reference yields is inserted as it is and never parsed again, so `{{` in a result does nothing.
  The default of a reference is taken as written. Control characters are removed from an inserted value (the Implementer refuses them).
- **Sizes.** A value longer than 10,000 characters is cut with a note that says so (`… [cut: the value was N characters long]`). The finished text must fit
  where it goes (an instruction: 20,000 characters), else the step fails with `template_too_large`.
- **A missing value fails the step** with `template_missing_value` and the path that was missing, unless the reference has a `| default`.
- The targets are checked again: an issue number from the input must be a whole number from 1 to 2147483647.

### The budget over all steps

A run has a budget: `budgetUsd` of the document (20 when left out), held to the operator's maximum (100 USD today) once more at the start. Every agent
step gets as its cost limit **at most what is left of the budget**, in whole cents, and not more than the limit of its profile version or the operator's
maximum per task. A turn is charged what the runner reported. **A turn whose cost is not known** (the runner reported none, as with a model of the
workspace's own key that has no price) is charged by its token counts at the price of the model in the catalog, never above its cap; with no token counts or
no price in the catalog it is charged **the whole cap it ran under**, so a run never spends more than its budget. That is conservative on purpose: with
an unpriced model a workflow of two agent steps with a budget of 1 USD can end after step one with `budget_exhausted`, because step one was charged the
whole of it. The engine logs `[workflow-runs] cost not reported run=… step=… charged=estimated|limit` for each such step. A price in the catalog, or a
model that reports its cost, avoids it. When the budget cannot pay one cent for the next agent step, the run ends with `budget_exhausted`; an action step costs nothing and still runs. The basis a step was charged on (`reported`, `estimated`, or `limit` for the whole cap) is kept with
the step and shown on the [run page](#the-run-page).

### Control at run time

*Milestone 5 (#846).* The rows of a run are written in the order the steps run, and the engine decides the next move by **replaying the rows against the document**
(`machine.ts`): there is no cursor to lose, so a doubled event or a sweep that comes at the same time finds what the first one wrote and changes nothing. A row says which
node it is (`stepId`), how often that step has run (`round`, from 1) and, for a control step, what it decided.

- **`round`** counts how often the step has run in the run. In a loop the steps of the body get 1, 2, 3 in the rounds; in a loop inside a loop the count goes on across the
  rounds of the outer loop, so that `(run, step, round)` is unique. The run page tells the round of a step that ran more than once.
- **`loop`.** The body runs at least once. After each round the engine asks, in this order: does `until` hold (exit `until`); was that the last allowed round (`maxRounds`); can the
  budget pay one more agent step, that is at least one cent (`budget`); else the body runs again. The decision is written as one row of the loop (kind `loop`, output
  `{"exit": "until", "rounds": 2}`), which is what `{{fix.exit}}` and `{{fix.rounds}}` read. The budget is asked **only between two rounds**: inside a round an agent step the budget
  cannot pay ends the run with `budget_exhausted`, as anywhere. The budget is one for the whole run: every round is charged to it, and the cost limit of an agent step is what is left.
  `until` is looked at with the values of the round that just ended, so `{{review.findings}}` in it is the findings of that round.
- **`previous.<step>.<field>`** is what a direct step of the innermost loop body had in the round before. In round one there is nothing: an `instruction.first` has none (the
  validator refuses it), a reference elsewhere uses its `| default`, and without one the step fails with `template_missing_value`. Text an agent wrote in the round before is
  an agent's text like any other: it is defused where it goes into the text of an action.
- **`instruction`.** An agent step with `{"first", "next"}` uses `first` in round one and `next` from round two of its innermost loop on; a plain text is used every round.
- **`if`.** The engine evaluates `when` under the lock of the run, from the outputs of the rows, and writes one row of kind `if` with `{"taken": "then"}` (or `"else"`) as its output,
  and **one row with the status `skipped` for every step of the branch that was not taken**, at any depth, in the same write. The run page shows them, so a person sees what did not
  run. A skipped step has no output: a reference to it is refused by the validator, because nothing a branch made is certain to exist outside it.
- **Conditions** are evaluated as the validator checked them: `empty` / `notEmpty` of a list or a text, `equals` / `notEquals` of two texts, two numbers or two true/false values, and
  `all`, `any`, `not`. A value is only compared or measured, never read again as a template. A condition that cannot be told (a value it needs does not exist and the reference has
  no default) ends the run with `condition_failed`; the log says which step.
- **`session.continue`.** A step that names an agent step goes on in the session of its **latest earlier run** (for itself in a loop: the round before; round one has none and starts
  a session of its own). The engine does not start a new task but a follow-up turn of that session, the same path as the "Continue" form of the Runs page
  ([`implementer.md`](implementer.md#follow-ups)): **no second turn starts while one runs** (the instruction waits behind it, one at most), the request id of the step makes it
  idempotent, and the turn keeps the model, the environment, the profile and the **result schema** of the session's last turn. So a step that goes on in the session of **another**
  step must declare the same `result` as that step, else it ends with `agent_start_failed` before anything is started. The cost limit of the turn is the smaller of what is left of
  the budget and the limit of the session's last turn.
- **Failures inside a loop.** A step that fails, a budget that cannot pay the next agent step and a condition that cannot be told end the **whole run** at once as `failed`
  (`step_failed`, `budget_exhausted`, `condition_failed`): the steps after the loop do not run, so in "Issue to PR" **no pull request is opened**. What the run does then is
  [`onFailure`](#onfailure-at-run-time): the example comments on the issue and swaps the label; a workflow without `onFailure` leaves the issue as it is and the only signals are the run page and the
  status of the run (`GET .../runs/<runId>`). The loop's own `maxRounds` and `budget` exits are **not** failures: they end the loop, and the `if` after it (`{{fix.exit}}`) decides, which is what the example's comment on the issue is for.

### `onFailure` at run time

*#902.* When the walk would end the run `failed` or `cancelled` and the workflow has `onFailure` steps, the engine first **stores how the run ends** with the run (`workflow_runs.failure`: the status, the error code and the
facts above) and keeps it `running`. The rows after that are the rows of `onFailure`, replayed against its steps the same way as the workflow's own; a step that failed or was skipped counts as over, so the next one runs.
When the last one is over, the run ends with the stored status and error code (`failed` with `step_failed`, `budget_exhausted` or `condition_failed`; `cancelled` with none), and `finishedAt` is the end of the cleanup.

- **Idempotent.** Like every move it is made under the lock of the run from the rows, so a doubled event or a sweep finds what the first one did. A step that was claimed and has no outcome after two minutes is ended
  `action_interrupted`, not repeated; the steps after it still run.
- **The run is still `running` meanwhile**, which also keeps the issue busy for the label trigger (one running run per workflow and issue). The sweep finds it if the engine dies.
- **Cancel.** The run is cancelled when its agent has stopped; `onFailure` starts then, and ignores a cancel that is (or becomes) asked for while it runs. The route answers `requested` or `already_requested` as ever.
- **Budget.** The steps cost nothing (comments and labels), so a budget that is used up does not stop them. They never start an agent: whatever the document says, an agent step or a loop in `onFailure` ends the cleanup.
- **A document of an older version** has no `onFailure` and runs as before; the column is null for every run that exists.

### Branches and what a step starts from

- **The branch a session works on.** A step in a session of its own works on `workflow/<run id>/<step id>`; a step that runs again in a new session (a reviewer in round two) on
  `workflow/<run id>/<step id>.r<round>`. A step id never holds a `.` (a letter, then letters, digits, `_` or `-`), so no step can be named like the later round of another
  (`review` in round two is `review.r2`; a step called `review-r2` is `review-r2`). A continued session keeps its branch.
- **A reviewer needs the code: `branch`.** A session of its own starts from the base branch of the run, so a reviewer would not see what the implementer did. The agent step takes
  `"branch": "{{implement.branch}}"`: the new session starts from that branch (the Implementer's `startBranch`, #909; the `baseBranch` of the session stays the base branch of the run; the branch must exist on GitHub, which it does once the turn that
  made it started, and the step ends with `agent_start_failed` if it was deleted). In a loop the value is the one of the latest round of `implement`, which in round two holds
  the commits of the session that went on. The value is a [target](#one-repository-per-run-and-targets): a literal, a trigger value or the branch **fact** of an agent step, never text an agent wrote.
- **Push rights and the branch of the reviewer.** `branch` only chooses where the session **starts**. The session always works on a branch of its own, `workflow/<run id>/<step id>`
  (with `.r<round>` from the second session of the step on), created from that start; it never pushes to the branch it started from. A profile that **may not push** (the reviewer) reads the
  branch and changes nothing that leaves its container. A profile that **may push** pushes to its own branch, which is then built on top of the other (a second branch, not a commit on
  the implementer's), and its own `{{<step>.branch}}` is that second branch. The name of the session's branch is unique whatever it starts from: it holds the run and the step.
  The agent's repository is a full clone (#909: every branch of the repository as a local branch, the whole history and the tags), so a reviewer sees the history of the branch it starts from and can run
  `git diff <base>...HEAD` against the base branch of the run. Only the branches an agent created or moved are pushed; the others are left as they were.

### Known limits

- **A cancelled run ends when its agent has stopped** (#891), at the next heartbeat of its runner (30 seconds on the Worker, 60 at most on a customer's runner) plus the time the agent needs to stop and push (the stop of a turn has 120 seconds, and the heart keeps beating meanwhile), and at the latest after the
  grace of 4 minutes, when the app ends the job itself. A runner of an earlier release ignores `cancelRequested`: it goes on until that grace ends the job and its claim is lost, so it stops without a push. The steps that had not
  started are not written as skipped rows (only a step that was written and not claimed is); the page shows what ran. The run page has a plain button, no confirmation.
- **`onFailure` reads no step of the workflow.** After a failure any step may not have run, so the facts of the failure (`status`, `stepId`, `code`, `message`) and the trigger are all it has: it cannot name the branch the agent pushed or quote an earlier result. (A later extension could offer them with a `| default`.)
- **`onFailure` is not shown apart on the run page and not in the run's JSON**: its steps are rows after the failed one, like any step; `workflow_runs.failure` is not returned by the routes yet.
- **Profiles are resolved per step**, at the moment the step starts; a profile without a version can mean version 2 for step two of a run whose step one ran
  with version 1.
- **The sweep has a time budget** (40 seconds, 10 for the maintenance after a request), checked between two runs; a run is looked at as a whole.

### Actions

An action step is a **connector**: an interface (`name`, `run(call)`) and a registry the engine asks. The inputs are the node's, with references resolved and
held to the connector's types again. The three connectors of the format (`github.pullRequest.open`, `github.issue.comment`, `github.issue.labels`)
are real connectors of the GitHub App ([GitHub actions](#github-actions)); a step whose connector is not available ends with
`connector_unavailable` and the run with `step_failed`. The engine's own tests use a fake connector.

**A call takes 60 seconds at most** (`ACTION_TIMEOUT_MS`), which is well under the two minutes after which a step that was claimed and has no outcome is taken
for abandoned (`STEP_STALE_MS`). A call that takes longer ends its step with `action_timeout` and is not repeated (it may have happened); the call gets an
`AbortSignal` that is aborted then. **A connector keeps to it** (the three GitHub connectors do): it passes `call.signal` to every request it makes and sets no longer
time limit or retry of its own. A connector that outlasts the limit could otherwise run twice, once for the engine that waits for it and once for the
one that took the step over. Use `call.idempotencyKey` for what the platform supports.

### GitHub actions

The three connectors act through the **GitHub App of the workspace**, on **the repository of the run** and nothing else: the repository is never an input, so
no value (a branch, a reference, an agent's text) can name another one. Each makes its requests with a token of its own, limited to that
repository and to the one permission it needs, and switched off afterwards. The inputs are data: they are cleaned and bounded here, after the
references are resolved.

| Connector | App permission it needs (as the App's settings page words it) | Idempotent? |
| --- | --- | --- |
| `github.pullRequest.open` | Pull requests: Read and write and Contents: Read-only | Yes: an open pull request for the same head and base is the result (`number` and `url` of it, `existing: true`), not an error. It is looked for first, and again when GitHub answers that one exists. Only a pull request whose head is a branch of this repository (not of a fork of the same owner) and whose head and base are the ones asked for counts. |
| `github.issue.comment` | Issues: Read and write | Not by GitHub (it has no way to say "this comment once"). The engine never repeats an action (`action_timeout`, `action_interrupted`), which keeps a comment from being written twice. As a second guard the comment ends with an invisible marker `<!-- wf-<runId>-<position> -->`, and the comments of the issue that changed since the step began (five minutes earlier, for the clocks) are looked at for the App's own comment with it before one is written (`existing: true`, the url of that comment). That holds **within one run** only; see "After a timeout or an error of GitHub's own". |
| `github.issue.labels` | Issues: Read and write | Yes: an added label that is on the issue stays, a removed one that is not on it is skipped. A label the repository lacks is created by the add. `labels` is what the issue has afterwards. |

GitHub files the comments and labels of a pull request under issues, so `Issues` covers a pull request too.

`github.pullRequest.open` needs **Pull requests: Read and write** and, besides, **Contents: Read-only** (the App's installation holds it for the agent's branch already): its token asks for
`pull_requests: write`, `contents: read` and `metadata: read`. Without the contents GitHub cannot resolve the head and base refs and answers 422 "head invalid" for a branch that exists (#913).

| Input | Bound |
| --- | --- |
| `title` | One line (line breaks and control characters become a space), at most 256 characters; a longer title is cut (never inside a surrogate pair, so no emoji is torn in two), lone surrogate halves are dropped, and the bidirectional controls (U+200E, U+200F, U+061C, U+202A–U+202E, U+2066–U+2069) are removed so that a title reads as it is written. Empty after cleaning is `action_input_invalid`. |
| `body` (pull request, comment) | Control characters other than line breaks and tabs are dropped, as are the bidirectional controls of the title row and lone surrogate halves; at most 60 000 characters, a longer text is cut (never inside a surrogate pair) and ends with a note saying how much was left out. A comment must not be empty. |
| `head`, `base` | A plain branch name of the repository (`A-Za-z0-9._/-`, at most 255 characters, no `..`, no `owner:` prefix that would reach into a fork). `base` is the branch the run's agent steps started from (the default branch of the repository when the run began) when the node names none. |
| `issue` | A whole number from 1. |
| `add`, `remove` | At most 20 names each, 50 characters at most, no control characters, no empty name, **no name of dots only** (`.`, `..`): the address that removes a label ends with its name, `DELETE …/labels/.` is read as `…/labels/` and would remove every label of the issue. The connector and the client both refuse such a name before any request. Duplicates are dropped. |

**Failures.** What GitHub refuses ends the step with a code of its own and a message for the run page that names no token and no text of the action. The one text of GitHub's that it carries is the short reason of a refused value (`github_validation`,
for example "GitHub said: PullRequest head invalid."): it is GitHub's own, so it is cleaned (one line, no invisible characters, no links in any form (`https://…`, `www.…`, `//…`, `javascript:…`, `mailto:…`) or token-looking words, no `[ ] ( ) < >` or backticks), defused like an agent's text and only then cut at 150 characters (so the bound holds for the text as it is kept), and the message as a whole is at most 300 characters in `{{failure.message}}` (the engine clips it there):

| What GitHub answered | Code |
| --- | --- |
| The App lacks the permission (the token request is refused with 422, or the call with 403 "Resource not accessible by integration"), or the installation is suspended | `github_permission_missing` |
| 404 for the issue or pull request; the repository is not (or no longer) part of the installation; the installation is gone | `github_not_found` |
| 422: no commits between head and base, a branch that does not exist, any other value it does not accept (GitHub's reason follows the generic sentence); 403 for an archived repository | `github_validation` |
| 429, or 403 with a rate-limit header, or 403 without one whose message names a rate limit (GitHub's secondary limit answers like that) | `github_rate_limited` |
| 403 for any other reason (no permission, no rate limit, no archived repository) | `action_failed` (the message names the call and the status; it does not send the owner to the App's settings) |
| 5xx, no connection, no answer in time | `github_unavailable` |

**Outputs.** `github.pullRequest.open` answers `{ number, url, existing }`, `github.issue.comment` `{ url, existing }`, `github.issue.labels` `{ labels }`.
`existing` is `true` when the action found what it would have made (an open pull request for the head and base, the App's own comment with the marker of the step) and
made nothing. The `url` of an output is **always a page of the repository of the run** (`<repository url>/pull/<n>`, `<repository url>/issues/<n>#issuecomment-<id>`):
GitHub's answer counts only when it is parsed as an address with the same origin as the repository, no user or password in it, and a path below the repository's own (`/owner/repo/…`, compared per path segment, so `…/repo/../x` and `…/repo-other/…` do not pass). If GitHub's answer holds another address, the connector reports the repository's own address for the pull request or the issue instead of it, so a run page
can show it as a link (#873, M3c) without a check of its own; it still renders only `http(s)` addresses.

**After a timeout or an error of GitHub's own.** For `github.pullRequest.open` and `github.issue.comment`, a step that ends with `github_unavailable` (no answer, 5xx) or
`action_timeout` says **"The action may have happened; check GitHub before starting again."** The request may have reached GitHub and been carried out before the answer
was lost, and the engine never repeats an action. **Starting the workflow again is a new run**: it opens a pull request again (the open one for the same head and base is
found, but a closed or merged one is not) and writes a new comment (the marker holds within one run only). `github.issue.labels` is idempotent and does not say it.

**Text an agent wrote.** A value that an agent step reported (`{{review.summary}}`) and that is put into a text input of an action (`title`, `body`) is **defused**
once the text is put together (`defuseSegments`, `app/src/workflow-runs/templates.ts`), so what two parts form at their boundary is seen as well. A zero-width space
(the text reads the same to a person) goes:

- after an `@` that is followed by a name (a letter, a digit, `_` or `-`) and stands at the start of a line or after a character that is not part of a word: no `@name`,
  no `@org/team`. `john@example.com` stays as it is;
- after the `#` of an issue reference: `#12` and `owner/repo#12` (after a space, a bracket, a quote, punctuation, or an `owner/repo`) link to nothing, and **a "Closes #12" in an
  agent's text closes nothing** when the pull request merges. Left alone: a number that starts with `0` only (`#000`), a number followed by a letter or `_` (`#1a2b3c`), a `#`
  after a letter or digit that is no `owner/repo` (`abc#12`, `https://example.com/page#12`), the `#` of an entity (`&#123;`) and a link to a heading (`[text](#2-section)`);
- after `GH-` before a number (`GH-12`, also `gh-12`), and before the number of an issue or pull request address (`…/issues/12`, `…/pull/12`);
- inside `<!--` (`<!-` + zero-width space + `-`), so that an agent cannot write the invisible marker of a comment (`<!-- wf-<runId>-<position> -->`) and make the next
  attempt of a step believe its comment exists. This holds inside code as well;
- as `&amp;` for the `&` of the entities of `@` and `#` (`&#64;`, `&#x40;`, `&commat;`, `&#35;`, `&#x23;`, `&num;`).

A fenced block (```` ``` ```` or `~~~`, open to the end of the text when it is never closed) and a code span (`` `…` ``) are left out of all of this except for `<!--`: GitHub
mentions nobody there. A title is no Markdown, so nothing is left out of a title. Where a code span or a fence of an agent cannot be told from the one GitHub sees (a quote
or list item, an indented line, a table row), the text is defused as if it were no code.

At a boundary between two parts the rule is: a part that an agent wrote is defused, the rest is not. An agent value that begins with a name after a `@`, or with a number after
`#` or `GH-`, gets the space in front of it, **also when the `@` or `#` is a literal of the workflow** (`@{{review.author}}`, `Closes #{{review.issue}}`), and an agent value that
ends with `@` or `#` gets it behind it when a name or a number follows. The literals of the workflow and the values of the trigger stay as they are:
`Closes #{{trigger.input.issue}}` in the workflow still closes the issue. Only the text inputs of an action are defused, not the instruction of an agent step, and not a
number or a list that is a whole reference (an issue number, labels). What a step of a connector reports (`{{pr.url}}`, `{{pr.number}}`) is not an agent's text either.

**Known limits.**

- **A token is not switched off when the call was aborted** (N4). After `action_timeout` the client still asks GitHub to revoke the token of the call, but with the call's
  signal already aborted that request can be lost; the token then lives until it expires (an hour at most) and is limited to the repository of the run and one permission.
- **A label name is in the message of a failed removal** (N5). The address of a removal ends with the label's name, and a message that names the call (`GitHub answered 500
  for DELETE …/labels/<name>`) carries it. The label names are inputs of the workflow, not secrets, but a message of this kind is not free of the action's text.
- The defusing knows the forms above and no others. A full address of an issue in an agent's text (`https://github.com/o/r/issues/12`) is defused only as far as the number is
  concerned; a closing keyword with a reference that is none of the forms above, mentions that GitHub recognises through other markup (HTML tags, a link
  whose text is a name), and look-alike characters (a full-width `＠`) are not modelled. Text a person reads in a title of a pull request is not Markdown, so a
  reference in it is defused but a code span in it does not hide anything.
- **Text with HTML is defused everywhere, code included.** Where the text holds `<` followed by a letter, `/` or `!`, no code span or fenced block is left out of the
  defusing: there is no HTML parser here to tell where HTML ends a span early. A generic type in code (`List<String>`) therefore gets its zero-width spaces too.
- **`&#64;` in a title reads as `&amp;#64;`.** A title is no Markdown: GitHub shows the `&amp;` it is given as text and decodes nothing, so the entity that was defused is
  visible as `&amp;#64;`. The `#64` that stays inside it can be linked as an issue in a title (a title cannot be checked against the Markdown renderer).
- A mention or a reference that two literals of the workflow form with nothing of an agent in it is the workflow's own text and stays raw (`Closes #{{trigger.issue.number}}`).
- **A `#000`-like number is left alone** (a CSS colour, a "number" that starts with zeros only). `#123456` is defused: it cannot be told from an issue.

**Permissions the owner grants.** The App of a deployment has no Issues and Pull requests write at first. Until the owner of the App adds **Issues: Read and write**
and **Pull requests: Read and write** to it (the pull request action needs **Contents: Read-only** besides) and the owner of each installation accepts the change, every one of these steps ends with
`github_permission_missing` and a sentence that names the permission ("The GitHub App of this workspace may not open pull requests: it needs the permission
"Pull requests: Read and write and Contents: Read-only". …"). Nothing in the app changes the App's configuration at GitHub.

### The label trigger

*Milestone 4 of epic #833 (#845).* A label put on an issue starts the workflows that wait for it. The webhook of the GitHub App (`POST /api/webhooks/github-app`,
[`app/src/webhooks/`](../app/src/webhooks/README.md)) takes the event `issues`; once the signature, the delivery id and the installation are settled, the
workspace of the installation decides which workflows start ([`label-trigger.ts`](../app/src/workflow-runs/label-trigger.ts)).

**What starts a workflow.** All of these hold:

- the action is `labeled` on an **open issue**. A pull request is no issue here (GitHub also sends `issues` for pull requests: `issue.pull_request` is set), and
  neither are `opened`, `edited`, `unlabeled` or any other action, nor a closed issue;
- the label was put on by a **user account**: the sender's type is `User`. A `Bot` (the App itself included), an `Organization` or a `Mannequin` starts nothing: the
  GitHub actions label issues with the App's token, and a label that starts a workflow would start the next run by itself. A **machine account that labels with a
  personal access token is a `User` to GitHub** and starts workflows like a person; use no such account for anything that labels an issue a workflow waits for, unless
  that is meant;
- the repository of the issue is an **active repository of the workspace** (the installation's workspace; a repository of another installation, or one that was
  removed from it, starts nothing). No project is needed;
- the workflow is **not archived**, its **current version** has a trigger of the kind `ticket.labeled` (or `github.issueLabeled`, its name before #916), and its `label` is **exactly** the label that was put on: the same
  characters, case and spaces included (GitHub keeps the spelling a label was created with, and the payload carries it). The run starts through **that trigger**: its [pre-steps](#the-triggers-and-their-pre-steps) run first,
  then the shared steps. A workflow with two label triggers for one label starts one run, through the first;
- every step is one the engine runs (`agent`, `action`, `if` and `loop`, at any depth). A workflow with a node of another kind is **left out** and the log says which step: a run that
  ends halfway, after its first action changed the issue, is worse than none (the validator refuses the reserved kinds, so no saved workflow has one);
- the workflow has **no running run for this issue**. A workflow has at most one running run for one issue (the repository and the issue number): the label put on,
  taken off and put on again while the first run goes on starts nothing, and the log says why; a person (or a script) cannot start a run with a full budget as often as
  they like. When the run has ended (`succeeded` or `failed`), the next label starts the next one. The database holds the rule (a partial unique index on the workflow and
  the issue, for runs that are `running`), so two deliveries that race for the same issue write one run. The delivery that started nothing is answered
  `no_workflow_matched`. Another issue, or another workflow, is not held by it.

The format gives a label trigger no repository of its own: the workflow runs on the repository of the ticket (`trigger.ticket.repo`), so every active repository of the
workspace fits. Several workflows may wait for one label; **each starts a run of its own**.

**Nobody is asked.** There is no check of our own about who put the label on (owner decision 2 of the plan): GitHub decides who may label. The login of the person is
kept as the run's `actorLogin`, to be shown, and decides nothing.

> **Warning: keep the trigger label out of issue templates.** An issue that is created from an issue template or an issue form that has `labels:` gets those labels
> **when it is created**, and GitHub sends the label to the App as if a person had put it on. If the label of a workflow is in a template of a **public repository**,
> **anybody who can open an issue starts a run** (with the budget of the workflow, one per issue). The label that starts a workflow belongs in no template; put it on by
> hand, or let a trusted automation of your own do it (it is a `User` to GitHub only if it labels with a personal access token). The platform does not change this
> behavior: it cannot tell a template from a person.

**Known limit: the delivery id is not signed.** GitHub signs the body of a delivery, not its headers, and the delivery id (`X-GitHub-Delivery`), under which the runs
are written once, is a header. Whoever holds a correctly signed body (a captured request) can send it again under another id, and it is taken for a new delivery. The
signature still decides who can start a run at all; the rule of one running run for one issue (above) is what limits a replay, the delivery id only protects against
GitHub's own redelivery.

**A run without a person.** `workflow_runs.created_by` is empty for such a run and `triggerKind` is `ticket.labeled` (`github.issueLabeled` on the rows written before #916; `triggerId` is the id of the trigger; the check of the table: only a run started by
hand or through the API needs a user). The Implementer records the account a session belongs to, so the **turns of such a run belong to the account that owns the workflow** (the author of the version the run uses; saving the workflow again makes a new version, and its author owns the runs that start afterwards); their job shows the login of whoever put the label on. Neither decides anything: what a run may do is what the workflow, its profile and the GitHub
App allow.

**At most one run per delivery and workflow.** The run is started under the request id `gh-<delivery id>-<workflow id>`. GitHub's "Redeliver" of a delivery, or a second
request that raced the first, finds the runs the first one made and writes none; a run whose first push was lost is pushed again. The webhook answers `202` with
the outcome `workflow_runs_started` (at least one workflow has a run for this delivery; the delivery then stays a duplicate for 7 days) or `no_workflow_matched` (none
starts; the delivery can be redelivered, for a workflow saved later). If writing a run fails, the other workflows still start, the answer is `500` and a redelivery
finds the runs that were written.

**The ticket of the run.** The run also names the issue it is about as `workflow_runs.ticket_ref`, `github:<owner>/<repo>#<number>` (#923): the [ticket mirror](ticket-mirror.md) reads
the run that is going on for a ticket, and what the runs of a ticket spent, by it. The runs of this trigger that started before got it from their input when the column was added.

**The input is the ticket.** `trigger_input` of the run, and what the steps read, is the ticket (`trigger.ticket`, below) and, as workflows written before #916 read them,
the issue and the repository:

| Value | What |
| --- | --- |
| `trigger.ticket` | `number`, `title`, `body`, `url`, `labels`, `type`, `assignees`, `repo` ([The ticket](#the-triggers-and-their-pre-steps)), the same bounds as `trigger.issue`; `type` and `assignees` come from the payload of the webhook when it has them, else empty. |
| `trigger.issue.number` | The number of the issue (an integer). |
| `trigger.issue.title` | The title, at most 256 characters (a longer one ends in `…`). |
| `trigger.issue.body` | The description, at most 8,000 characters (a longer one is cut with a note that says how long it was); empty when the issue has none. |
| `trigger.issue.url` | The web address of the issue. |
| `trigger.issue.labels` | The names of all labels the issue has now (the new one included): 20 at most, 50 characters each (GitHub's own bound for a name); a longer name is cut, and labels after the twentieth are left out. |
| `trigger.repo.fullName`, `.owner`, `.name` | The repository. |
| `trigger.repo.defaultBranch` | Its default branch at the time of the delivery: the branch the run's agent steps start from. |

The bounds leave room for the workflow's own text: the instruction of an agent step is at most 20,000 characters, and the title (256), the labels (1,000 at most) and the
body (8,000) take at most about 9,300 of them.

The environment of an agent step is a literal of the workflow (a [target](#one-repository-per-run-and-targets)), so there is no `defaultEnvironment`. Control characters
are removed from the texts, as from every value that goes into a text.

**The title, the body and the labels are the words of whoever opened the issue**, which can be anybody who may open an issue. They are data, never read again as a
template (`{{` in a body does nothing) and never a target (the validator refuses it). In the **instruction of an agent** they are put in as they are: the agent is meant to
read the issue, and works in its sandbox. In the **text of an action** (a comment, the title and body of a pull request) they are **defused like what an agent wrote**:
`@name` and `@org/team` mention nobody (a zero-width space after the `@`), `#12`, `owner/repo#12` and an issue address name no issue (so a body that says `Closes #5` closes
nothing), a `<!--` rebuilds no marker. The number and the address of the issue and the repository are the platform's and stay as they are, so `Closes #{{trigger.issue.number}}`
works as written.

**The labels at the start.** The engine changes no label by itself. Swapping `agent implement` for `agent working` is the first shared step of the workflow, an action
`github.issue.labels` (see [the first workflow](#the-first-workflow)); the validator refuses an action that adds the label that starts the workflow.

**What the GitHub App needs** (the owner of the App sets this on GitHub; nothing in the app changes the App's configuration):

- the event **Issues** subscribed (*Permissions & events > Subscribe to events*: tick **Issues**; see [`github-app.md`](github-app.md#events)). Without it GitHub sends no `issues` delivery and no label starts anything;
- the permission **Issues: Read** to receive the event. The actions of the workflow need more: **Issues: Read and write** (the comment, the labels) and **Pull requests: Read and write**
  (the pull request), and **Contents: Read and write** for the agent's branch ([GitHub actions](#github-actions));
- every installation has to accept a changed permission (GitHub asks the account that installed the App).

### Failure codes

A run that ends failed has `errorCode`; a step that failed has `errorCode` and a short `errorMessage`.

| Code | Of | Meaning |
| --- | --- | --- |
| `step_failed` | run | A step failed; the step says why. |
| `budget_exhausted` | run | The budget does not cover another agent step. |
| `step_kind_not_supported` | run | The pinned document holds a node this engine does not run (a reserved kind, or a node that is not well formed). |
| `condition_failed` | run | The `when` of an `if` or the `until` of a `loop` could not be evaluated: a value it needs does not exist and has no default. |
| `document_unusable` | run | The pinned version cannot be read, or the steps written so far are not what it says they should be. |
| `workflow_owner_gone` | run | A run a label started: the account that owns the workflow (the author of the version the run uses) is no longer a member of the workspace. The run ends before its first step. The message: "The person who owns this workflow is no longer a member of the workspace; save the workflow again to take it over." The failed run frees the issue. If the owner leaves while the run goes on, the agent step that cannot start fails with `agent_start_failed` and the same sentence. |
| `template_missing_value` | step | A reference points at a value the run does not have, and has no default. |
| `template_invalid` | step | A reference holds an object, or the text is not a template. |
| `template_too_large` | step | The text does not fit where it goes. |
| `profile_not_found` | step | The profile is gone, archived or has no such version. |
| `environment_not_found` | step | The environment is not one of the workspace. |
| `agent_start_failed` | step | The Implementer refused the turn (the code and text of the refusal are in the log of the engine, not in the step), or it could not be started for an hour. |
| `turn_unreadable` | step | The turn, its job or its stored schema cannot be read. |
| `no_result` | step | No result, or one that does not fit the schema. |
| `job_failed` | step | The job ended without success and without a code of its own. Any other code of the job (`timeout`, `cost_limit_reached`, …) is kept as it is. |
| `connector_unavailable` | step | No connector is there for the action. |
| `action_input_invalid` | step | The inputs of the action are not what the connector takes, once the references are resolved. |
| `action_failed` | step | The connector failed for a reason that has no code of its own; the step says "The action failed." and the cause is in the log of the engine. |
| `github_permission_missing` | step | The GitHub App of the workspace lacks a permission the action needs, or the installation is suspended; the message names the permission. |
| `github_not_found` | step | GitHub has no such issue, pull request or repository, or the installation is gone. |
| `github_validation` | step | GitHub refused the content: no commits between head and base, an archived repository, a value it does not accept. |
| `github_rate_limited` | step | GitHub's rate limit was reached (also the secondary limit, which comes without a rate-limit header); the action is not repeated. |
| `github_unavailable` | step | GitHub could not be reached or did not answer in time. For an action that creates something the message adds that the action may have happened. |
| `action_timeout` | step | The connector did not answer within 60 seconds; the action is not repeated, and for an action that is not idempotent the message says it may have happened. |
| `action_interrupted` | step | The engine was interrupted while the action ran; it is not repeated. |
| `cancelled` | step | A member stopped the run (or the task of the step) before the turn of the step started, or while it ran. The run ends `cancelled` (status, no `errorCode`). The job of the turn has the same code. |

### Errors of the run routes (`error`)

| Code | Status | Meaning |
| --- | --- | --- |
| `WORKFLOW_RUN_REQUEST_INVALID` | 400 | The body is not JSON or not `{input, clientRequestId}`, or the request id is not usable. |
| `WORKFLOW_RUN_CROSS_SITE_REQUEST` | 403 | The request comes from another site. |
| `WORKFLOW_RUN_WORKFLOW_NOT_FOUND` | 404 | No such workflow in this workspace. |
| `WORKFLOW_RUN_NOT_FOUND` | 404 | No such run of this workflow in this workspace. |
| `WORKFLOW_RUN_REPOSITORY_NOT_FOUND` | 404 | `input.repo`, or the repository of the `ticket`, is none of the workspace's repositories (or not `owner/name`). |
| `WORKFLOW_RUN_TRIGGER_UNKNOWN` | 404 | The workflow has no trigger with the id the body names as `trigger`. |
| `WORKFLOW_RUN_TICKET_NOT_FOUND` | 404 | The repository has no issue of the number the `ticket` names (a pull request is none). |
| `WORKFLOW_RUN_WORKFLOW_ARCHIVED` | 409 | The workflow is archived and is not started. |
| `WORKFLOW_RUN_REQUEST_REUSED` | 409 | The request id made another run (`runId` is the first). |
| `WORKFLOW_RUN_BODY_TOO_LARGE` | 413 | The body is over 128 KB. |
| `WORKFLOW_RUN_CONTENT_TYPE_UNSUPPORTED` | 415 | The body is not `application/json`. |
| `WORKFLOW_RUN_TRIGGER_NOT_MANUAL` | 422 | Only a trigger of the kind `manual` or `api` is started by hand or through the API. |
| `WORKFLOW_RUN_STEP_KIND_NOT_SUPPORTED` | 422 | A node is of a kind the engine does not run (`step` names it). |
| `WORKFLOW_RUN_INPUT_INVALID` | 422 | The input does not fit the trigger's `input`; `errors` lists every problem. |
| `WORKFLOW_RUN_DOCUMENT_UNUSABLE` | 500 | The saved document cannot be read. |
| `WORKFLOW_RUN_GITHUB_UNAVAILABLE` | 503 | GitHub could not be asked for the repository. |

## The run page

*Milestone 3c of epic #833; the code is [`app/src/workflow-pages/`](../app/src/workflow-pages/README.md), the pages are below `/w/<slug>/workflows`.*
There is no editor for workflows (an AI writes them through the API), but a member can see them, start one by hand and watch a run. The pages exist
only in a deployment with the capability `implementer`, are reached from the **Lanes** tab of a project (no sidebar place of their own since #925), and are open to every member (the permission
`start_implementer_task`, like the routes). A workflow, or a run, that is none of the workspace's is the not-found page, the same as one that does
not exist.

- **Workflows** (`/w/<slug>/workflows`): the workflows of the workspace that are not archived, with their version and the time of the last save.
- **One workflow** (`/w/<slug>/workflows/<id>`): the **Start form** and the newest 50 runs.
  - The form has one field for each field of the `input` of the manual trigger, the repository (`repo`) or the ticket first: a text (a ticket is a text like `github:owner/repo#128`), a whole number, a number, a
    choice (a text with a list of names), a checkbox, and a box for JSON for a list or an object. A workflow with several manual triggers shows one form for each. It sends `{trigger, input, clientRequestId}` (`trigger` when the workflow has `triggers`) to
    `POST .../workflows/<id>/runs`. The `clientRequestId` is made when the form is sent and kept for the same input: sending it again after a lost
    answer is one run, changing the input is another. A refusal is told in words; a field the server names is marked. A workflow that is archived, or whose
    trigger is not the manual one, shows a note instead of the form.
  - The list of runs has the status, the start, the trigger (started by hand, through the API, or by a label), what was spent of the budget and the version of the
    workflow the run started with. It is updated every few seconds while a run runs.
- **One run** (`/w/<slug>/workflows/<id>/runs/<runId>`): the page polls `GET .../runs/<runId>` every 3 seconds while the run runs, as the live view of an
  Implementer run does, and stops when it ends.
  - **Status.** `running`, `succeeded`, `failed` or `cancelled`. A run that runs has a button **Cancel run** ([Cancelling a run](#cancelling-a-run)); once asked, the page says the run is stopping. A failed run or step is told in a sentence for its code (`budget_exhausted` is "the budget of the run is
    used up"), never as the code itself; a code the page does not know is "failed for a reason not listed here". The message a step stored is a fixed sentence (no code,
    nothing a runner or an exception wrote; the details go to the log of the engine) and is shown under the sentence as text, unless it contains a code
    (`IMPLEMENTER_X`, `agent_start_failed`): then only the sentence of the `errorCode` is shown.
  - **Budget.** What was spent of the budget, as a bar and in dollars. Each step that was charged shows its cost with its **basis**:
    - *reported*: the runner reported the cost;
    - *estimated*: the runner reported none, so it is the token counts at the catalog price of the model;
    - *booked as the limit*: nothing better was known, so the step was charged the whole limit it ran under. The real cost is probably lower; the run never
      spends more than its budget.

    A step that no runner took (`no_runner_available`, cost 0) never ran: it shows "not run" instead of a basis.

    The basis is kept with the step (`workflow_step_runs.cost_basis`, null for a step that was charged nothing, and for steps written before milestone 3c) and is
    in the step of the run routes as `costBasis`.
  - **Steps**, in the order they ran, each with its status, its failure, how long it took, the profile of an agent step and its cost. An agent step links to its
    Implementer run (`/w/<slug>/runs/<jobId>`), where the live view shows what the agent does.
  - **Rounds and control (#846).** Every run of a step is listed on its own, and a step that ran more than once says its round ("round 2"). A **condition** and a **loop** are steps
    of their own: the condition says which branch it took, the loop how it ended (its condition held, its last round ran, or the budget could not pay another agent step) and after how many rounds.
    A step in a branch that was not taken is listed with the status **Skipped**.
  - **Results.** An agent step shows its branch and, collapsed, the rest of what it returned as JSON text. An action step shows what any action returns:
    `url` (a link only if it passes the check below, else the text), `number` and `existing` (whether the action found what it would have made, so nothing new was created).
    Everything in them is text from outside, rendered as text and never as markup.
  - **Failed actions.** The codes of the GitHub connectors are told in a sentence, not as the code: `github_permission_missing` names the permission the App lacks
    ("Pull requests: Read and write and Contents: Read-only" or "Issues: Read and write", taken from the step's message only if it is one of the known ones, an earlier "Pull requests: Read and write" included) and says that the owner of the installation has
    to grant it; `github_rate_limited` says the limit was reached and the action was not repeated; `github_not_found`, `github_validation` and `github_unavailable` have a
    sentence of their own; an action that creates something and ended without an answer (`github_unavailable` with that note, `action_timeout`, `action_interrupted`) says
    **"The action may have happened: check GitHub before starting again."** The message the step stored is shown under the sentence as text.
  - **Links.** The only links made from a step's output go to GitHub: a value is linked only if `new URL` reads it as `https://github.com/<owner>/<name>` or
    below it, of **the repository of the run** (`input.repo`, case ignored), with no user name or port in it; `javascript:`, another host or another
    repository are shown as text and not linked. The link of a branch is made from the repository and the branch name, not taken from the output.

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
| `duplicate_id` | Two steps with one id, in the pre-steps of the triggers and the shared steps alike; or two triggers with one id. | Give each step and each trigger its own id. |
| `template_syntax` | A `{{ }}` that is not a reference, a default that is no JSON (or nests braces more than 3 deep), or a `{{` never closed. | Fix the text; write `\\{{` for a literal `{{`. |
| `reference_unknown_step` | A reference starts with a name that is no step. | Use one of `available` (the steps in reach). |
| `reference_to_later_step` | The step comes later, is the step itself, or contains it. | Move the use after the step, or use another step. |
| `reference_not_in_scope` | The step ran earlier but not on every path to here (inside a branch); or a shared step reads a part of `trigger` that not every trigger yields (`trigger.ticket` when one trigger yields none): the message names a trigger that lacks it. | Use it inside its branch, or restructure; give the trigger that lacks the value a ticket input, or leave the reference out. |
| `reference_unknown_field` | The step has no such field. | Use one of `available`. |
| `reference_optional_field` | The field is not required, so it may be missing. | Make it `required` in the result schema, or add `\| default <JSON>`. |
| `reference_fact_unavailable` | `branch`, `commits`, `headCommit` or `pushed` of a step whose profile may not push. | Use a profile that may push, or another value. |
| `reference_type_mismatch` | The value does not fit where it is used. | Use a value of the type the message names, or a field of an object. |
| `default_type_mismatch` | The default does not fit the field's type. | Give a default of that type. |
| `previous_outside_loop` | `previous.` outside a loop body. | Use it inside a loop. |
| `previous_without_default` | `previous.` where round one has no value. | Use it in `instruction.next`, or add a default. |
| `previous_unknown_step` | `previous.<id>` names no step of the innermost loop body that always runs (the message says whether it belongs to an outer loop, sits in an `if`, or is no step of the body). | Use one of `available`, or the step without `previous.`. |
| `condition_operand_type` | An operand of the wrong type, or two that cannot be compared. | Compare like with like; `empty` takes a list or a text. |
| `condition_value_not_in_enum` | A text compared with a choice of names that can never hold it. | Use one of `available`. |
| `instruction_next_outside_loop` | `instruction.next` in a step that is not in a loop. | Use a plain text, or put the step in a loop. |
| `session_target_invalid` | `session.continue` names no agent step that ran before on every path, or one with another profile name or environment, or the step itself where it is not a direct step of a loop body; or a step with both `session.continue` and `branch`. | Use one of `available`, with the same profile and environment; or drop `branch` (a session that goes on keeps its branch). |
| `profile_unknown` | No such profile. | Use one of `available`. |
| `profile_archived` | The profile exists but is archived: no step may run it. | Use one of `available`. |
| `profile_version_unknown` | The profile has no such version. | Use one of `available`, or leave the version out. |
| `environment_unknown` | No such environment in the workspace. | Use one of `available`, or create it on the Environments page. |
| `runner_needs_own_key` | An agent step runs a profile with a managed model (an entry of the platform's catalog, on the platform's key) in an environment that runs on a runner. A runner works with the workspace's own key. | Use a profile with a model of your own key, or an environment that runs on a platform VM. |
| `harness_needs_runner` | An agent step runs a profile whose harness is not OpenCode in an environment that runs on a platform VM. Such a harness exists only on a runner. | Use an environment that runs on a runner. |
| `result_field_reserved` | A result field named like a platform fact (`costUsd`, `branch`, `commits`, `headCommit`, `pushed`). | Rename it. |
| `required_field_unknown` | `required` of a result schema names a field that is not in `properties`. | Fix the name or add the property. |
| `repo_required` | A manual or api trigger without `input` that declares `ticket` (type `ticket`, required) or `repo` as a required text: the run has no repository. | Declare `ticket` or `repo` in `properties` and `required` of the trigger's `input`. |
| `target_from_untrusted_value` | An input that decides a target (`issue`, `head`, `base`, `add`, `remove`, `environment`) holds more than a literal or one reference of the kind the input takes (see the table under "targets": a field of the trigger such as the title or the body of the issue is not one). | Use a literal, or exactly one reference the message names. |
| `duplicate_trigger_label` | Two `ticket.labeled` triggers wait for the same label (compared without regard to case). Reported at the `label` of the second, which names the first. | Give one of them another label, or merge them. |
| `label_retriggers_workflow` | A shared step, or a pre-step of a label trigger, adds the label that starts the workflow. A pre-step of a trigger that is no label trigger may. | Remove the label instead, or add another one. |
| `on_failure_step_not_allowed` | A step of `onFailure` that is not a comment (`ticket.comment`, `github.issue.comment`), a label change (`ticket.labels`, `github.issue.labels`) or an `if` over them. | Only comment and change labels after a failure. |
| `too_many_steps` | More than 50 steps. | Split the workflow. |
| `nesting_too_deep` | `if`/`loop` too deep, a loop in a loop in a loop, conditions or a result schema nested too deep. | Flatten it. |
| `result_schema_too_large` | A result schema with more than 100 fields in all. | Make it smaller. |
| `budget_above_maximum` | `budgetUsd` above the operator's maximum. | Lower it to the maximum the message names. |

### Of the routes (`error`)

| Code | Status | Meaning |
| --- | --- | --- |
| `WORKFLOW_REQUEST_INVALID` | 400 | The body is not JSON, or a query value is not a whole number. |
| `WORKFLOW_CROSS_SITE_REQUEST` | 403 | The request comes from another site. |
| `WORKFLOW_NOT_FOUND` | 404 | No such workflow in this workspace (another workspace's looks the same), also for an archive. |
| `WORKFLOW_VERSION_NOT_FOUND` | 404 | The workflow has no such version. |
| `WORKFLOW_NAME_TAKEN` | 409 | The workspace has a workflow of that name that is not archived (case ignored). |
| `WORKFLOW_LIMIT_REACHED` | 409 | The workspace holds 100 workflows that are not archived (`maximum`). |
| `WORKFLOW_ARCHIVE_LIMIT_REACHED` | 409 | The workspace holds 1000 archived workflows: one more cannot be archived (`maximum`). |
| `WORKFLOW_VERSION_LIMIT_REACHED` | 409 | The workflow holds 500 versions (`maximum`). |
| `WORKFLOW_ARCHIVED` | 409 | The workflow is archived and takes no new version. |
| `WORKFLOW_VERSION_CONFLICT` | 409 | `expectedVersion` is not current any more (`current` says which is). |
| `WORKFLOW_BODY_TOO_LARGE` | 413 | The body is over 256 KB. |
| `WORKFLOW_CONTENT_TYPE_UNSUPPORTED` | 415 | The body is not `application/json`. |
| `WORKFLOW_INVALID` | 422 | The document does not pass the validator; `errors` lists the problems and `truncated` says whether there are more. |

The routes of a workspace that is not yours, and in a deployment without the capability, are the 404 of a path that does not exist.
