# Profiles: who works

A **profile** says how an agent works: which model, which standing instructions, how much a turn may cost, whether it may push
branches, and (optionally) what its result looks like when a step does not say. A run gets a profile **and** an environment, separately:
the profile is *who works*, the [environment](implementer.md#environments) is *where* (setup script, size, network rule). The environment is
never part of a profile.

Profiles are data. Nothing is built in: people create them, change them and reuse them, through the API (there is no page to manage them yet; the Implementer form can pick one), and an
AI can write one. Every member of a workspace may do all of it (the permission `start_implementer_task`, like environments). The profiles
exist only in a deployment with the capability `implementer` (the factory).

**Status (milestone 2 of epic #833, first half).** Profiles are stored with versions, the workflow validator resolves `profile` against them,
and a task can run with one: the version's model becomes the task's (and, for a task started by hand, an older version's cost limit), its instructions go into the agent's prompt, and a version
without the right to push is not pushed. The profile's default result schema is stored, used by the validator and, when a task runs with the
profile, becomes the task's [result schema](implementer.md#the-finish-tool): the agent gets a finish tool made from it.

## A profile

```json
{
  "name": "reviewer",
  "description": "Reads a branch and reports what is wrong. Changes nothing that leaves the container.",
  "model": { "entryId": "..." },
  "instructions": "You review code. Read the task and the work, run the tests if there are any, and report each problem as a finding. Do not change any file.",
  "canPush": false,
  "defaultResult": {
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
            "type": { "type": "string", "enum": ["bug", "risk", "nit"] },
            "name": { "type": "string", "maxLength": 120 },
            "description": { "type": "string" }
          }
        }
      }
    }
  }
}
```

This is the reviewer of the workflow ["Issue to PR"](workflows.md#the-first-workflow), and it is data like any other: created through the API, nothing is seeded. It may not push
(`canPush: false`: Control never pushes for it, and a step that runs it yields no `branch` or `commits`), and its default result is a list of findings, so
a review step may leave out its `result` and take this one (the example of the workflow declares it anyway, so that it validates and reads without the profile at hand). A finding is a `bug`, a `risk` or a `nit`, with a name and a description; an empty list means the reviewer found nothing, which is what ends
the loop of the workflow.

| Field | Needed | What |
| --- | --- | --- |
| `name` | yes | What a workflow writes in a step (`"profile": "reviewer"` or `"reviewer@2"`): lower case letters, digits, `_` and `-`, starting with a letter or digit, 64 characters at most. Once per workspace among the profiles that are not archived. **The name of a profile never changes**: a new version carries the same name (`PROFILE_NAME_CHANGED`); to use another name, create another profile. |
| `description` | no | A note for people, 1,000 characters at most. |
| `model` | yes | The model a turn runs on, in the two shapes the Implementer form takes: `{"entryId": "<id>"}` (a released catalog entry, for a workspace on the operator's key) or `{"provider": "<slug>", "model": "<id>"}` (a model of the workspace's own key). `GET /api/w/<slug>/implementer/models` lists what this workspace can use. A model the workspace cannot run is refused (`model_not_allowed`, with the reason). |
| `instructions` | no | The standing, system-level text the agent is given, 20,000 characters at most. It is **not** the task: the task is what a person (or a workflow step) sends with each run. Tabs and line breaks are kept as written. Text that is only white space is refused (`invalid_value`); leave the field out instead. |
| `costLimitCents` | no | **Deprecated (#918); leave it out.** Limits belong to the lane: the cost of a turn of a [workflow](workflows.md#the-limits-of-a-lane) is what is left of its budget, and its time is the workflow's `turnTimeLimitMinutes`, so a workflow never reads this field. It is still accepted (whole US cents, 1 to 10,000 as `(1 to 10,000)`; above the operator's maximum it is `cost_limit_above_maximum`), stored in the column `profile_versions.cost_limit_cents`, and applied only to a task started by hand from the Implementer form with the profile. **The API does not show it**: the `document` of a profile has no `costLimitCents`, and a profile saved without it has none. |
| `canPush` | yes | `true` if a turn of this profile may push branches, `false` if not. See [the push right](#the-push-right). Required on purpose: decide it. |
| `harness` | no | The harness the agent runs with. Only `"opencode"` is one a profile can name today (the platform's catalog holds nothing else), and it is what every version runs with, named or not; nothing is stored for it. The field and its rule are prepared for the harnesses a runner announces ([`runner.md`](runner.md#registration-and-routing-r1a-854)): a profile whose harness is not OpenCode will run only in an [environment that runs on a runner](workflows.md#error-codes), and the validator already says `harness_needs_runner` for it. |
| `defaultResult` | no | A [result schema](workflows.md#result-schemas) (the same format and the same validator as a step's `result`). A workflow step that declares no `result` yields this one, and the validator uses it for the references in the workflow. A task that runs with the profile and brings no `result` of its own gets this one as the schema of its turn, and with it a finish tool ([`implementer.md`](implementer.md#the-finish-tool)). Its fields may not be named like a platform fact (`costUsd`, `branch`, `commits`, `headCommit`, `pushed`): that is refused with `result_field_reserved`, as in a step's `result`. |

A body with a field not in the table is refused (`unknown_field`, with the names that exist).

## Versions

Every save is a **new version** that is never changed; the database refuses an update of a saved version. Version 1 is the first save; a
save adds the next number (`PUT`) and makes it the current one. Older versions stay readable (`GET .../profiles/<id>?version=1`), and a
workflow can pin one (`"profile": "reviewer@1"`) or take the newest (`"profile": "reviewer"`).

`PUT ...?expectedVersion=3` saves only if version 3 is still the current one; otherwise `PROFILE_VERSION_CONFLICT` with `current`. Use
it whenever two writers might change the same profile, so that nobody overwrites a change they have not seen.

A **task copies the version it runs with** when it starts (model, instructions, push right, and for a task started by hand the deprecated cost limit). Changing, archiving or removing
the profile afterwards does not reach a task that has started.

**Archive** (`DELETE`) hides a profile from the list, frees its name, and refuses new versions and new tasks; its versions stay readable
(a task may have run with one). Archiving again answers the same. A workspace holds 100 profiles, 500 versions of each, and 1,000
archived profiles.

## The API

All under `/api/w/<slug>/profiles`, JSON, `Cache-Control: no-store`. A refusal is `{"error": "<code>", "message": "..."}`; a body that does not
pass the validator is `422 PROFILE_INVALID` with `errors` (every problem; see below) and `truncated`.

| Call | What |
| --- | --- |
| `POST /profiles/validate` | Checks a profile (the body) and stores nothing. `200` with `{"valid", "errors", "truncated"}`; a profile with problems is a normal answer. |
| `POST /profiles` | Saves a new profile as version 1. `201` with `{"profile": {...}}`. |
| `GET /profiles` | The profiles that are not archived, by name: `{"profiles": [{id, name, version, createdAt, updatedAt, archivedAt}], "maximum": 100}`. |
| `GET /profiles/<id>[?version=n]` | The profile with the version asked for (default: the current one) as `document` (the body shape, every optional field filled in), `documentVersion`, and every saved version in `versions`. |
| `PUT /profiles/<id>[?expectedVersion=n]` | Saves the body as the next version. |
| `DELETE /profiles/<id>` | Archives. |

### How an AI should write one: validate, fix, save

1. Find a model: `GET /api/w/<slug>/implementer/models` (`keyMode: managed` lists `entries`, each with an `id`: use `{"entryId": id}`;
   `keyMode: own` lists `providers` with their models: use `{"provider": id, "model": id}`).
2. Write the profile.
3. `POST /profiles/validate`. Read **every** error: each has a `path` (a JSON pointer into your body), a `code` (stable: branch on it) and a
   `message` (the cause in a sentence). Fix them all, validate again. The default result schema is checked by the validator of the workflow
   format, and its errors point into `/defaultResult/...`.
4. `POST /profiles`, or `PUT /profiles/<id>?expectedVersion=<n>` for a change.

### Errors

Of the body (the same list in `validate` and in a refused save):

| Code | When | What to do |
| --- | --- | --- |
| `wrong_type` | A field of the wrong JSON type, or a body that is not an object. | Use the type the message names. |
| `missing_field` | `name`, `model` or `canPush` is missing. | Add it. |
| `unknown_field` | A key the format does not have. | Use one of `available`. |
| `invalid_value` | A name that is not a profile name, a model that is not one of the two shapes, a cost limit out of range, a text with a control character. | See the message. |
| `limit_exceeded` | A text longer than its bound, or a result schema over its caps. | Shorten it. |
| `model_not_allowed` | The workspace cannot run that model (the message gives the reason). | Pick one from `GET .../implementer/models`. |
| `cost_limit_above_maximum` | The cost limit is above the operator's maximum per turn (the message says it). | Use that or less. |

The result schema's own codes (`unknown_kind`, `required_field_unknown`, `nesting_too_deep`, ...) are those of the [workflow format](workflows.md#result-schemas).

Of the routes:

| Code | Status | When |
| --- | --- | --- |
| `PROFILE_REQUEST_INVALID` | 400 | The body is not JSON, or `version` / `expectedVersion` is not a whole number. |
| `PROFILE_CROSS_SITE_REQUEST` | 403 | The request is from another site. |
| `PROFILE_NOT_FOUND` | 404 | No such profile in this workspace (another workspace's looks the same). |
| `PROFILE_VERSION_NOT_FOUND` | 404 | The profile has no such version. |
| `PROFILE_BODY_TOO_LARGE` | 413 | A body over 128 KB. |
| `PROFILE_CONTENT_TYPE_UNSUPPORTED` | 415 | A body that is not `application/json`. |
| `PROFILE_INVALID` | 422 | The body does not pass the validator; `errors` lists every problem. |
| `PROFILE_NAME_CHANGED` | 422 | A new version carries another name than the profile has. |
| `PROFILE_NAME_TAKEN` | 409 | The workspace has a profile of that name that is not archived. |
| `PROFILE_LIMIT_REACHED` | 409 | The workspace holds 100 profiles (`maximum`). |
| `PROFILE_ARCHIVE_LIMIT_REACHED` | 409 | The workspace holds 1,000 archived profiles (`maximum`). |
| `PROFILE_VERSION_LIMIT_REACHED` | 409 | The profile holds 500 versions (`maximum`). |
| `PROFILE_VERSION_CONFLICT` | 409 | `expectedVersion` is not the current version; `current` says which is. |
| `PROFILE_ARCHIVED` | 409 | The profile is archived and takes no new version. |

## The push right

`canPush` decides whether **Control pushes** when the turn ends. The agent never has a remote or a credential, with either value; what
differs is what Control does with the branches the agent made in its container:

- `true`: Control pushes every local branch of the agent's repository when the turn ends, exactly as the Implementer always did
  ([`docs/implementer.md`](implementer.md#the-git-rules)). A step of a workflow with such a profile yields `branch` and `commits`.
- `false`: Control **pushes nothing**. It does not commit the leftovers, does not list the branches, does not read the repository after the
  agent. The turn is a success when the agent ended well, whether it changed anything or not (a reviewer that only reads has nothing to
  push); its result carries no branch, no head commit, no commits and no files, and `pushed: false`. The agent is told that nothing it
  commits leaves the container, so its closing answer is what the person gets. A step of a workflow with such a profile yields no `branch`
  and no `commits`, and a reference to them is refused by the validator (`reference_fact_unavailable`). The cost limit and the time limit
  still apply. The turn gets no extra message about uncommitted changes (one agent turn only), and its GitHub token can only read the
  contents (`contents: read`), so the Worker could not push even with a bug. The Runs page shows its branch name but does not link to it,
  because the branch was never pushed.

## Running a task with a profile

`POST /api/w/<slug>/implementer/tasks` (the route behind the Implementer form) takes an optional `profile`: a name (the newest version) or
`name@version`. With a profile the body names **neither `model` nor `costLimitCents`** (`not_with_profile`): the version brings the model, and
they are checked at the start like the form's (`IMPLEMENTER_MODEL_NOT_ALLOWED`, `EXCEEDS_OPERATOR_MAXIMUM`; the latter only for an older version that still holds a cost limit). A profile that is not there, is
archived, or has no such version is `IMPLEMENTER_PROFILE_NOT_FOUND`. The environment is chosen separately (`environmentId`), as before.
The Implementer form offers it too: an optional **Profile** select lists the workspace's profiles that are not archived (by name, with the
newest version) and **No profile**, the default, which leaves the form as it always was. With a profile chosen, the form shows the model and
the model of its newest version at the time of loading and does not let it be edited (there is no cost limit field with a profile since #918), says in one sentence when the profile does not push ("This profile
does not push: the result stays in the run."), and sends `profile: "<name>@<version>"` without `model` and `costLimitCents`. The form pins
the version it shows, so a version made after the page loaded does not change what the task runs with. When the model of that version is
not among the models the workspace offers, the model field says so and the form does not send the task. The environment stays a
choice of its own. The form reads the profile with `GET /profiles` and `GET /profiles/<id>`; it needs no route of its own.

A repeated request (same `clientRequestId`) with a profile gets the first task back, also if the profile got a new version in between; a
request that names another profile, or a version other than the one the task ran with, is `IMPLEMENTER_REQUEST_REUSED`.

### What the agent gets, and why the prompt cache hits

The runner writes one instruction file for the engine. Its text is a function of three things only: whether the environment has a setup
script, the version's `canPush`, and the version's `instructions`. The profile's text comes **last** and exactly as written, under the
heading "Instructions of this profile"; nothing per task is interpolated into it. So every turn of one profile version gets the same prompt
prefix and the model provider's prompt cache (on wherever the provider supports it) hits across turns; a new version changes only the end.

### Today's Implementer as a profile

A task **without** a profile is not changed by any of this: it runs with the platform's own defaults, exactly as before profiles (no
extra text, pushes every local branch, the model and cost limit of the form). Nothing is seeded into any workspace. To get today's behaviour
under a name, create this profile (use a model from `GET .../implementer/models`):

```json
{
  "name": "implementer",
  "description": "Today's Implementer: pushes the branches it makes.",
  "model": { "entryId": "..." },
  "canPush": true
}
```

A task started with it is identical to a task started without a profile: the same prompt (a test compares the text byte for byte), the same
push. It is also the profile that workflows write as `"profile": "implementer"`; a workflow that names a profile the workspace does not have
is refused by the validator (`profile_unknown`, with the names that exist; `profile_archived` for a profile that was archived).

## Where profiles meet workflows

The workflow validator resolves each agent step's `profile` against the profiles of the workspace that are not archived: the name, the
version (`name@n`, or the newest), the push right (it decides whether the step yields `branch` and `commits`) and the default result schema
(the fields a step yields when it declares no `result`). For a step that pins a version the facts are those of that version; without a
version, those of the newest. The workflow is not re-checked when a profile gets a new version: a pinned reference stays as it was, and an
unpinned one will be resolved when the engine (a later milestone) runs the workflow.

## What is not in a profile (yet)

The environment (never), the doors the agent may use (later), and a time limit (the platform's, per turn). Nothing is fixed that a person
cannot choose, except the rules the system itself keeps (the agent has no remote and no credential).
