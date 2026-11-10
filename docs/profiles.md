# Profiles: who works

A **profile** says **who works and where**: the harness, the model (with its key), the standing instructions, the rights (whether it may
push branches) and the **environment** it runs in, and (optionally) what its result looks like when a step does not say. The
[environment](implementer.md#environments) is an environment of the workspace: a hosted VM of the platform (setup script, size, network
rule) or a runner on your own machine ([`runner.md`](runner.md)). Since #919 the environment is part of the profile; a workflow step names
none (see [Where profiles meet workflows](#where-profiles-meet-workflows)).

Profiles are data. Nothing is built in: people create them, change them and reuse them, through the API (there is no page to manage them yet; the Implementer form can pick one), and an
AI can write one. Every member of a workspace may do all of it (the permission `start_implementer_task`, like environments). The profiles
exist only in a deployment with the capability `implementer` (the factory).

**Status (milestone 2 of epic #833, first half).** Profiles are stored with versions, the workflow validator resolves `profile` against them,
and a task can run with one: the version's model becomes the task's, its instructions go into the agent's prompt, and a version
without the right to push is not pushed. The profile's default result schema is stored, used by the validator and, when a task runs with the
profile, becomes the task's [result schema](implementer.md#the-finish-tool): the agent gets a finish tool made from it.

## A profile

```json
{
  "name": "reviewer",
  "description": "Reads a branch and reports what is wrong. Changes nothing that leaves the container.",
  "model": { "entryId": "..." },
  "environment": "node",
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
| `environment` | yes | **Where the agent works** (#919): the name of an environment of the workspace (the Environments page; case is ignored), a hosted VM or one that runs on a runner. `GET /api/w/<slug>/environments` lists them. It is stored as the id of the environment, so renaming the environment keeps the profile working. It is required in every new version (`missing_field`); an environment that is not in the workspace is `environment_unknown` (with `available`). It has to fit the rest of the profile: a profile with a managed model does not run in a runner environment (`runner_needs_own_key`, a runner works with the workspace's own key), and a harness other than OpenCode does not run in a hosted environment (`harness_needs_runner`). Versions saved before #919 have none (`environment: null` in the `document`); they keep running with the environment their workflow step names, and the next version has to name one. |
| `model` | yes | The model a turn runs on, in the two shapes the Implementer form takes: `{"entryId": "<id>"}` (a released catalog entry, for a workspace on the operator's key) or `{"provider": "<slug>", "model": "<id>"}` (a model of the workspace's own key). `GET /api/w/<slug>/implementer/models` lists what this workspace can use. A model the workspace cannot run is refused (`model_not_allowed`, with the reason). |
| `instructions` | no | The standing, system-level text the agent is given, 20,000 characters at most. It is **not** the task: the task is what a person (or a workflow step) sends with each run. Tabs and line breaks are kept as written. Text that is only white space is refused (`invalid_value`); leave the field out instead. |
| `costLimitCents` | no | **Deprecated (#918); leave it out.** Limits belong to the lane: the cost of a turn of a [workflow](workflows.md#the-limits-of-a-lane) is what is left of its budget, and its time is the workflow's `turnTimeLimitMinutes`, so a workflow never reads this field. It is still accepted (whole US cents, 1 to 10,000 as `(1 to 10,000)`; above the operator's maximum it is `cost_limit_above_maximum`), stored in the column `profile_versions.cost_limit_cents`, and **ignored**: no task reads it any more, neither a workflow's nor one started by hand (its cap is the operator's maximum, as for a version without a limit). The column is kept for the versions already written. **The API does not show it**: the `document` of a profile has no `costLimitCents`, and a profile saved without it has none. |
| `canPush` | yes | `true` if a turn of this profile may push branches, `false` if not. See [the push right](#the-push-right). Required on purpose: decide it. |
| `harness` | no | The harness the agent runs with: `"opencode"` (the default, named or not; the platform's catalog holds it) or `"claude-code"`, which runs only on a runner on the login of its device, with a model `{"provider": "claude-code", "model": "<name>"}`. A harness other than OpenCode needs an environment that runs on a runner: the profile is refused with `harness_needs_runner` otherwise, so the rule lives here, in the profile, and no longer in the step ([`runner.md`](runner.md#registration-and-routing-r1a-854)). |
| `defaultResult` | no | A [result schema](workflows.md#result-schemas) (the same format and the same validator as a step's `result`). A workflow step that declares no `result` yields this one, and the validator uses it for the references in the workflow. A task that runs with the profile and brings no `result` of its own gets this one as the schema of its turn, and with it a finish tool ([`implementer.md`](implementer.md#the-finish-tool)). Its fields may not be named like a platform fact (`costUsd`, `branch`, `commits`, `headCommit`, `pushed`): that is refused with `result_field_reserved`, as in a step's `result`. |

A body with a field not in the table is refused (`unknown_field`, with the names that exist).

## Versions

Every save is a **new version** that is never changed; the database refuses an update of a saved version. Version 1 is the first save; a
save adds the next number (`PUT`) and makes it the current one. Older versions stay readable (`GET .../profiles/<id>?version=1`), and a
workflow can pin one (`"profile": "reviewer@1"`) or take the newest (`"profile": "reviewer"`).

`PUT ...?expectedVersion=3` saves only if version 3 is still the current one; otherwise `PROFILE_VERSION_CONFLICT` with `current`. Use
it whenever two writers might change the same profile, so that nobody overwrites a change they have not seen.

A **task copies the version it runs with** when it starts (model, instructions, push right, harness; its deprecated cost limit is not read). Changing, archiving or removing
the profile afterwards does not reach a task that has started.

**Archive** (`DELETE`) hides a profile from the list, frees its name, and refuses new versions and new tasks; its versions stay readable
(a task may have run with one). Archiving again answers the same. A workspace holds 100 profiles, 500 versions of each, and 1,000
archived profiles.

## The API

All under `/api/w/<slug>/profiles`, JSON, `Cache-Control: no-store`. A refusal is `{"error": "<code>", "message": "..."}`; a body that does not
pass the validator is `422 PROFILE_INVALID` with `errors` (every problem; see below) and `truncated`.

| Call | What |
| --- | --- |
| `POST /profiles/validate` | Checks a profile (the body) and stores nothing. `200` with `{"valid", "errors", "truncated"}` and, when there is one, `"warnings"` (the shape of an error, with `severity: "warning"`; a warning never makes the profile invalid); a profile with problems is a normal answer. |
| `POST /profiles` | Saves a new profile as version 1. `201` with `{"profile": {...}}`. |
| `GET /profiles` | The profiles that are not archived, by name: `{"profiles": [{id, name, version, createdAt, updatedAt, archivedAt}], "maximum": 100}`. |
| `GET /profiles/<id>[?version=n]` | The profile with the version asked for (default: the current one) as `document` (the body shape, every optional field filled in), `documentVersion`, and every saved version in `versions`. `environmentGone` is `true` when the version names an environment that was removed since: `document.environment` is `null` then, as for a version saved before #919, and this tells the two apart (the page says "Environment removed – choose another"). |
| `PUT /profiles/<id>[?expectedVersion=n]` | Saves the body as the next version. |
| `DELETE /profiles/<id>` | Archives. |

### How an AI should write one: validate, fix, save

1. Find an environment: `GET /api/w/<slug>/environments` (use its `name`; a runner environment for the harness `claude-code`,
   a hosted one for a managed model).
2. Find a model: `GET /api/w/<slug>/implementer/models` (`keyMode: managed` lists `entries`, each with an `id`: use `{"entryId": id}`;
   `keyMode: own` lists `providers` with their models: use `{"provider": id, "model": id}`).
3. Write the profile.
4. `POST /profiles/validate`. Read **every** error: each has a `path` (a JSON pointer into your body), a `code` (stable: branch on it) and a
   `message` (the cause in a sentence). Fix them all, validate again. The default result schema is checked by the validator of the workflow
   format, and its errors point into `/defaultResult/...`.
5. `POST /profiles`, or `PUT /profiles/<id>?expectedVersion=<n>` for a change.

### Errors

Of the body (the same list in `validate` and in a refused save):

| Code | When | What to do |
| --- | --- | --- |
| `wrong_type` | A field of the wrong JSON type, or a body that is not an object. | Use the type the message names. |
| `missing_field` | `name`, `model`, `environment` or `canPush` is missing. | Add it. |
| `unknown_field` | A key the format does not have. | Use one of `available`. |
| `invalid_value` | A name that is not a profile name, a model that is not one of the two shapes, a cost limit out of range, a text with a control character. | See the message. |
| `limit_exceeded` | A text longer than its bound, or a result schema over its caps. | Shorten it. |
| `environment_unknown` | The workspace has no environment of that name (#919). | Use one of `available`, or create it on the Environments page. |
| `runner_needs_own_key` | The environment runs on a runner and the model is a managed one (an entry of the catalog). A runner works with the workspace's own key (#854, #919). | Choose a model of your own key, or a hosted environment. |
| `harness_needs_runner` | The harness is not OpenCode and the environment is a hosted one (#856, #919). | Choose an environment that runs on a runner. |
| `no_runner_announces` | The environment runs on a runner, a runner with its labels is online, and none announces the harness, the auth and the model of the profile (#973: `claude-code` is a subscription of the device and its model must be one the runner allows; OpenCode on a key of the workspace is announced by every runner). It is a **warning** (`severity: "warning"` in `warnings`, never in `errors`): the profile is valid and saves, because a runner that is asleep or that leaves an entry out for a while (a rate limit) must never block a save. With no such runner online nothing is said. | Choose a model or a harness the runner announces, or start a runner that does; or save anyway, the turn waits. |
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
they are checked at the start like the form's (`IMPLEMENTER_MODEL_NOT_ALLOWED`); the cost limit of the version is not read (#918), so an older version that holds one starts like one without. A profile that is not there, is
archived, or has no such version is `IMPLEMENTER_PROFILE_NOT_FOUND`. A task of the Implementer form still chooses its environment separately (`environmentId`), as before; only a workflow step takes the environment of its profile.
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
  "environment": "node",
  "canPush": true
}
```

A task started with it is identical to a task started without a profile: the same prompt (a test compares the text byte for byte), the same
push. It is also the profile that workflows write as `"profile": "implementer"`; a workflow that names a profile the workspace does not have
is refused by the validator (`profile_unknown`, with the names that exist; `profile_archived` for a profile that was archived).

## Where profiles meet workflows

The workflow validator resolves each agent step's `profile` against the profiles of the workspace that are not archived: the name, the
version (`name@n`, or the newest), the push right (it decides whether the step yields `branch` and `commits`), the default result schema
(the fields a step yields when it declares no `result`) and the environment. For a step that pins a version the facts are those of that
version; without a version, those of the newest. The workflow is not re-checked when a profile gets a new version: a pinned reference
stays as it was, and an unpinned one is resolved when the engine runs the workflow.

**The step's `environment` is optional and deprecated (#919).** The engine runs a step in the environment of the version of its profile,
and the validator checks the rules there:

| The step | The profile version | The validator | The engine |
| --- | --- | --- | --- |
| names no `environment` | names one | accepts | runs in the profile's environment |
| names an `environment` | names the same one (case ignored) | accepts | runs in it |
| names an `environment` | names another one | `environment_mismatch` at `/environment`, `available` is the profile's | ends the step with `environment_mismatch`, no turn starts (the step is not moved to the profile's environment) |
| names no `environment` | names none (saved before #919) | `environment_required` at `/environment`, `available` lists the environments | |
| names an `environment` | names none (saved before #919) | accepts, as before (`environment_unknown` for a name the workspace does not have) | runs in the step's environment |

So **every workflow written before #919 keeps validating and running unchanged** as long as its profile versions are the ones that already
existed. The moment a profile gets a version with an environment, a step of a workflow that pins or follows it has to name that environment
or none. `runner_needs_own_key` and `harness_needs_runner` are checked for the environment the step runs in: for a profile's environment
they are reported at the step's `/profile` (and already when the profile is saved), for a step's own environment at `/environment`. If the
environment of a profile version was removed since (or is not one of the workspace), the step is `environment_unknown` at `/profile` and a
run fails the step with `environment_not_found`; save a new version of the profile with an environment that exists.

A workflow is not re-checked when a profile it follows gets a new version, so the two can drift apart: a workflow saved against version 1
of a profile without an environment names one in its step; the profile then gets a version 2 with another environment. The run does not
silently go to the new environment, and does not ignore what the step says: it ends the step with `environment_mismatch` (the message
names both). Take the environment out of the step, or save a new version of the profile with the environment the step names.

A session (`session.continue`) belongs to one profile name and one environment: two steps that run the same profile in the profile's
environment share it, and a step may not continue the session of a step that runs in another environment.

## What is not in a profile (yet)

The doors the agent may use (later), the right to end a turn with a question (every profile may today, #920), and a time limit (the lane's
`turnTimeLimitMinutes`; the cost is the lane's budget). Nothing is fixed that a person cannot choose, except the rules the system itself keeps
(the agent has no remote and no credential).
