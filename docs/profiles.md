# Profiles: superseded

> **Superseded (ADR 0007, epic #1103).** Profiles are being removed. What a profile held now lives in the agent step of the lane, and
> **a lane is configured only as JSON through the API**; read [the settings of the agent step](workflows.md#settings-in-the-step-1105) and
> [ADR 0007](decisions/0007-ai-configured-factory.md) ("Owner decisions" and "Migration path"). **Release A has shipped all of its parts**
> (#1105): the Profiles page is gone (no page, no navigation entry, no link; the address answers `404`), the lanes were converted into the
> new form by `pnpm lanes:convert`, and the built-in lanes are written in it. The **routes** below stay, because a lane that could not be
> converted still runs in the profile form and an old task or run still shows the profile it recorded; they are removed in **release B**,
> together with the tables `profiles` and `profile_versions`. Do not start anything new on a profile.

## Where each part of a profile went

| Of a profile | Now |
| --- | --- |
| `harness`, `model`, `canPush`, `instructions`, `defaultResult` (as the step's `result`), `description` | the agent step of the lane ([the table of settings](workflows.md#settings-in-the-step-1105)) |
| `environment` (a hosted VM, its size, setup script and network rule) | the step's `runner`, a hosted runner of one sandbox type such as "Vercel Sandbox 4 vCPU" or a self-hosted runner; the setup script and the network rule are fields of the step ([`runner.md`](runner.md#named-runners-1105-adr-0007-decisions-10-14-and-16), [`implementer.md`](implementer.md#environments)) |
| `costLimitCents` | the step's `costLimitCents` (the profile's value was never read since #918 and is not carried over) |
| The Profile select of the Implementer form | gone with the form: a task that belongs to no ticket is a run of the lane ["One-off task"](workflows.md#built-in-lanes) |
| A step's `"profile": "reviewer@2"` | the same settings written in the step. The conversion job copies them and lists what it cannot convert ([`factory-bring-up.md`](factory-bring-up.md#converting-the-lanes)) |

A step that names a `profile` still validates and runs in release A (a step takes a profile **or** inline settings, never both:
`profile_with_inline_settings`). The push right, the default result and the environment of a profile version are what the validator and the
engine read for such a step, as before; for a step with its own settings they are the step's.

## A profile (the old form)

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

Profiles are data that people created through the API (nothing is built in); every member of a workspace may use them, in a deployment with
the capability `implementer`. Every save is a **new version** that is never changed; older versions stay readable, and a step pinned one
(`"profile": "reviewer@1"`) or took the newest. A workspace holds 100 profiles, 500 versions of each, and 1,000 archived profiles.

| Field | Needed | What |
| --- | --- | --- |
| `name` | yes | What a step writes (`"profile": "reviewer"` or `"reviewer@2"`): lower case letters, digits, `_` and `-`, starting with a letter or digit, 64 characters at most. The name of a profile never changes (`PROFILE_NAME_CHANGED`). |
| `description` | no | A note for people, 1,000 characters at most. |
| `environment` | yes | The name of an environment of the workspace, a hosted VM or one that runs on a runner (`environment_unknown` lists the names). It has to fit the rest: a managed model does not run in a runner environment (`runner_needs_own_key`), a harness other than OpenCode does not run in a hosted one (`harness_needs_runner`). Versions saved before #919 have none. |
| `model` | yes | `{"entryId": "<id>"}` (a released catalog entry, for a workspace on the operator's key) or `{"provider": "<slug>", "model": "<id>"}` (a model of the workspace's own key). A model the workspace cannot run is `model_not_allowed`. |
| `instructions` | no | The standing, system-level text the agent is given, 20,000 characters at most. It is not the task. |
| `costLimitCents` | no | **Deprecated (#918); ignored.** Whole US cents, 1 to 10,000 as `(1 to 10,000)`; above the operator's maximum it is `cost_limit_above_maximum`. The API does not show it. |
| `canPush` | yes | `true` if a turn may push branches, `false` if not. Required on purpose: decide it. See [the push right](workflows.md#settings-in-the-step-1105). |
| `harness` | no | `"opencode"` (the default) or `"claude-code"`, which runs only on a runner on the login of its device. |
| `defaultResult` | no | A [result schema](workflows.md#result-schemas); a step that declares no `result` yields this one. |

A body with a field not in the table is refused (`unknown_field`, with the names that exist).

## The API (until release B)

All under `/api/w/<slug>/profiles`, JSON, `Cache-Control: no-store`. A refusal is `{"error": "<code>", "message": "..."}`; a body that does not
pass the validator is `422 PROFILE_INVALID` with `errors` (every problem) and `truncated`.

| Call | What |
| --- | --- |
| `POST /profiles/validate` | Checks a profile (the body) and stores nothing. `200` with `{"valid", "errors", "truncated"}` and, when there is one, `"warnings"`. |
| `POST /profiles` | Saves a new profile as version 1. `201` with `{"profile": {...}}`. |
| `GET /profiles` | The profiles that are not archived, by name. |
| `GET /profiles/<id>[?version=n]` | The profile with the version asked for (default: the current one) as `document`, `documentVersion`, and every saved version in `versions`. |
| `PUT /profiles/<id>[?expectedVersion=n]` | Saves the body as the next version; `expectedVersion` saves only if that is still the current one (`PROFILE_VERSION_CONFLICT`). |
| `DELETE /profiles/<id>` | Archives: hides the profile, frees its name, refuses new versions; its versions stay readable. |

### Errors

Of the body (the same list in `validate` and in a refused save):

| Code | When | What to do |
| --- | --- | --- |
| `wrong_type` | A field of the wrong JSON type, or a body that is not an object. | Use the type the message names. |
| `missing_field` | `name`, `model`, `environment` or `canPush` is missing. | Add it. |
| `unknown_field` | A key the format does not have. | Use one of `available`. |
| `invalid_value` | A name that is not a profile name, a model that is not one of the two shapes, a cost limit out of range, a text with a control character. | See the message. |
| `limit_exceeded` | A text longer than its bound, or a result schema over its caps. | Shorten it. |
| `environment_unknown` | The workspace has no environment of that name (#919). | Use one of `available`. |
| `runner_needs_own_key` | The environment runs on a runner and the model is a managed one. | Choose a model of your own key, or a hosted environment. |
| `harness_needs_runner` | The harness is not OpenCode and the environment is a hosted one. | Choose an environment that runs on a runner. |
| `no_runner_announces` | A **warning**: a runner with the environment's labels is online and none announces the harness, the auth and the model of the profile (#973). The profile is valid and saves. | Choose a model or a harness the runner announces, or save anyway. |
| `model_not_allowed` | The workspace cannot run that model (the message gives the reason). | Pick one from `GET .../implementer/models`. |
| `cost_limit_above_maximum` | The cost limit is above the operator's maximum per turn. | Use that or less. |

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

## What stays readable

A turn that ran with a profile keeps the copy it made when it started (`implementer_turns.profile_*`), and a step run keeps `profile_name`
and `profile_version`: the run page shows them as "Profile recorded then", and nothing is rewritten. A turn of a step with its own settings
records no profile. A follow-up of an old task ([`implementer.md`](implementer.md#follow-ups)) keeps the profile of its last turn.
