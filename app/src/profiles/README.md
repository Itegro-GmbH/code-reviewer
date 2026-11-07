# Profiles: versioned data for the agents (#843, milestone 2 of #833)

A profile is what a member of a workspace writes to say how an agent works: model, standing instructions, push right and an optional default
result schema. The format, the fields, the API, the push right and how a task uses a profile: [`docs/profiles.md`](../../../docs/profiles.md). This folder is
the **validator** and the **API** behind it; the storage is `profiles` and `profile_versions` in
`src/db/repositories/profiles-repository.ts` (scoped to a workspace; every save an immutable version, archived rather than deleted, the name fixed for
the life of the profile).

| File                                | Role                                                                                                                                                                                                                                                                                 |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `validate.ts`                       | `validateProfile(body)`: pure, never throws, every problem with a JSON pointer, a stable code and a sentence (the `Issue` of the workflow validator); the default result schema is checked by `validateResultSchema` of the workflow format                                          |
| `service.ts`                        | The workspace service (validate, list, get, create, new version, archive). Adds to the validator what only the world knows: the model must be one the claim would run (`ImplementerModels.check`, the rule of the Implementer form) and the cost limit within the operator's maximum |
| `http.ts`, `errors.ts`, `shared.ts` | The handlers (same conventions as `/workflows`), the route codes, the wiring                                                                                                                                                                                                         |
| `limits.ts`                         | The bounds: name pattern, lengths, counts per workspace                                                                                                                                                                                                                              |

## Decisions where the plan left room

- **Nothing is built in and nothing is seeded.** A task without a profile runs with the platform's own defaults, exactly as before profiles. Today's
  Implementer is reproducible as the profile `{"name": "implementer", "model": ..., "canPush": true}`: a task started with it is identical (the prompt text is
  byte for byte the same; `runner/tests/unit/test_implementer_prompts.py`).
- **The version is copied into the turn** (`implementer_turns.profile_*`, no foreign key), like the environment: changing or archiving a profile never reaches a
  task that has started, and the claim reads the turn alone. The model choice and the cost limit are the turn's existing columns, filled from the version.
- **The name never changes.** A workflow refers to a profile by name and version; a rename would make `reviewer@2` mean something else. Another name is another profile.
- **The cost limit is deprecated (#918).** Limits belong to the lane: the cost of a workflow's turn is what is left of its budget, and `StartTaskOptions.costCapCents` makes it the
  limit without reading the version's. A body may still carry `costLimitCents` (validated, stored in `cost_limit_cents`), `documentOf` does not show it, and only a task started by hand reads it.
- **The model and the cost limit are checked twice**: when a version is saved (so a typo is refused with an answer an AI can act on) and when a task starts (the
  catalog and the operator's maximum can change; a saved version is history and is not re-checked on read).
- **API only for the Implementer form.** `POST .../implementer/tasks` takes `profile`; the page has no picker yet (a UI for profiles is a later change). With a
  profile the body names neither `model` nor `costLimitCents`.
- **The resolver of the workflow validator reads the versions the document names**, not every version of every profile (`src/workflows/profile-refs.ts`).
