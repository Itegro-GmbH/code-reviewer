# Database layer

Kysely on Postgres (the `pg` driver). The whole layer lives in this folder; nothing else in the app
opens a database or writes SQL.

| File                             | Role                                                                                                                                                                                                                                                                |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `config.ts`                      | Reads `DATABASE_URL` (Postgres) and `DATABASE_POOL_MAX` from the environment (`loadDatabaseConfig`), `DATABASE_URL_MIGRATE` for the migration command (`loadMigrationDatabaseConfig`); `describeDatabaseTarget` is the safe form for a log line                     |
| `postgres.ts`                    | Kysely's Postgres dialect over the `pg` driver's pool (with a connect timeout, so an exhausted pool fails), the startup reachability check (`assertPostgresReachable`) and the dedicated advisory-lock connection (`withPostgresAdvisoryLock`, never the main pool) |
| `driver.ts`                      | `databaseDriver(db)`: which engine a connection speaks. Kept because migrations written when the app also ran on SQLite call it; migration files are never edited                                                                                                   |
| `migrate.ts`, `migrations/`      | `migrateToLatest(db)` and the ordered list of migrations                                                                                                                                                                                                            |
| `schema-status.ts`               | `readSchemaStatus(db)`: whether every migration of this version has been applied, read-only (`/api/health`)                                                                                                                                                         |
| `migrate-cli.ts`                 | `pnpm migrate`: the migrations against `DATABASE_URL_MIGRATE` behind a session advisory lock                                                                                                                                                                        |
| `try-lock.ts`, `lock-timeout.ts` | A transaction advisory lock that is tried and not waited for (the sweep), and a bounded wait for a row lock                                                                                                                                                         |
| `startup.ts`                     | `getDatabase()` hands the connection of this instance out (the pool opens on the first call)                                                                                                                                                                        |
| `schema.ts`                      | Row types of every table (`Database`)                                                                                                                                                                                                                               |
| `codecs.ts`                      | The only code that knows how JSON, booleans and timestamps are stored                                                                                                                                                                                               |
| `repositories/`                  | One small module per table (or aggregate); the only code that queries it. Exception: `users`, `sessions`, `accounts` and `verifications` belong to Better Auth (`src/auth/`)                                                                                        |
| `workspace-scope.ts`             | `WorkspaceId`, the type of the workspace parameter every scoped repository takes (see "Workspace scoping")                                                                                                                                                          |
| `errors.ts`                      | `DatabaseError` with stable codes (`DATABASE_CONFIG_INVALID`, `DATABASE_OPEN_FAILED`, `MIGRATION_FAILED`)                                                                                                                                                           |

## Postgres

`DATABASE_URL` (`postgres://` or `postgresql://`) names the database; anything else stops the start with
`DATABASE_CONFIG_INVALID`, and the message never repeats the URL (it carries the password). A deployment uses a direct or
session-mode connection, never a transaction pooler (`docs/deployment-vercel.md`, section 2).

- **Queue/gate transactions** take the instance gate advisory lock before repository/project and
  job rows (multi-row transitions lock jobs by ascending id). Enqueue/settings share it; gate changes
  and runner mutations take it exclusively. Disable cancels waiting Dynamic work while running
  leases stay valid; release/expiry read the gate atomically and fail instead of requeueing Dynamic
  work while off. Exact order and process-quiescence rollback boundary: `contracts/README.md`.
- The **claim** of a job (`repositories/jobs-claim.ts`): `FOR UPDATE SKIP LOCKED` plus the partial unique index
  `jobs_one_running_per_pull_request_unique` and a savepoint retry when a concurrent claim is rejected by it.
- **Migrations** run behind a session advisory lock (`pnpm migrate`), so several runs at once take turns and each
  migration is applied once; a failure rolls the whole batch back (transactional DDL).
- **A lazy, small pool.** `getDatabase()` opens the pool on its first call, and the pool connects on the first
  query, so a cold instance that never reads the database never connects. `DATABASE_POOL_MAX` defaults to 3
  (1 to 20: every instance has its own pool), idle connections close after 5 seconds, and the pool is
  handed to the platform's hook (`attachDatabasePool` of `@vercel/functions`), which keeps the instance
  alive until they have closed.
- **No start-up work.** `src/instrumentation.ts` only checks the settings, and a bad one throws (it never
  calls `process.exit`, which would end the function). No migration, no setup code in memory (it lives in the
  database: `pnpm setup-code`, `src/setup/README.md`), no sync with GitHub, no timer. The repositories are
  synchronized by the webhooks and by a daily cron (`src/cron/`, route `/api/internal/repository-sync`,
  `CRON_SECRET`); the hourly cleanup, the expiry of lapsed leases and the resends are done by the
  every-two-hours sweep (`/api/internal/dispatch-sweep`, #328, `src/dispatch/README.md`).
- **Migrations are a command.** `pnpm migrate` connects with `DATABASE_URL_MIGRATE` (a DIRECT Postgres
  connection: a pooler that ends the session between statements would drop the advisory lock), takes the
  session advisory lock `code-reviewer:migrate` for the whole run, applies what is pending and exits 0, or
  prints one line with the error code and exits 1. Run it at deployment time, before the new version takes
  traffic. The app never migrates: `GET /api/health` answers 503 `{"status":"error","code":"SCHEMA_BEHIND"}`
  while the database lacks a migration of this version (`schema-status.ts`; read-only, and a complete
  schema is not asked about again).
- **Mixed versions during a rollout.** Old instances keep running while the new version is deployed. The
  order is: migrate, then deploy. A migration therefore must work for the version that is still running:
  add tables and columns (nullable, or with a default); drop or rename in a later release, once no instance
  of the old version is left. A database that is AHEAD of an instance (it knows fewer migrations) is
  healthy for that instance. An instance deployed before its migration reports `SCHEMA_BEHIND` on
  `/api/health` (503), but **nothing makes the platform hold traffic back** for that: a production deployment is promoted
  when it is built, whatever `/api/health` says. So the order is a rule for the operator, not something the platform
  enforces: run `pnpm migrate` first, then deploy (`docs/deployment-vercel.md`, section 5.6).

**Inside a transaction, always use `trx`, never the outer `db`.** Repositories take the executor
(`Kysely<Database>` or the transaction) as a parameter for this reason: pass `trx` to them inside a transaction. A query on
the outer `db` inside `db.transaction().execute(async (trx) => ...)` runs on another connection, outside the
transaction, and with a pool of one it waits for the transaction forever. Keep transactions short and never hold one open
across an `await` on something slow (network, model, subprocess).

## Migrations

- Written in TypeScript with Kysely's schema builder, one file per migration in `migrations/`,
  named `YYYYMMDDHHMMSS_what_it_does.ts` (the UTC time the migration was written; the first one,
  `0001_create_app_meta`, is the only exception and sorts before all of them) and registered in
  `migrations/index.ts`. Kysely runs them in the alphabetical order of the keys there. Timestamps
  keep parallel branches from picking the same number. When a branch merges after another one added
  migrations, check the order: a migration must never sort before one that is already merged, because
  Kysely refuses to run it. A database that applied a migration under an old name must be recreated.
- They run with `pnpm migrate` (a step of the deployment, `docs/deployment-vercel.md`), never when the app starts and
  not in `next build`.
- All pending migrations of one run happen in a single transaction. If one fails, nothing of the
  batch is applied or recorded, and the command ends with exit code 1 and one line naming the
  migration (`MIGRATION_FAILED`).
- A migration that has run anywhere is never edited or deleted: production's chain must keep running. Add a new one
  instead. There is no automatic `down`; write one only if it is useful for a developer. The older migration files
  still carry branches for SQLite (the app ran on it until #700); they are history and never run on Postgres.

### Workspaces and the migration that introduced them

Migrations `20261011160000_create_workspaces`, `20261011160100_add_workspace_to_customer_data` and
`20261011160200_prepare_users_for_accounts` (docs/decisions/0001-editions-setup-and-accounts.md, sections
2.6, 2.7, 2.10):

- `workspaces` (id, name, unique slug, created by, created at) and `workspace_members` (workspace, user,
  role, created at; primary key (workspace, user); the role is restricted to `owner`, `admin`, `member`
  by a check constraint, the same list as `WORKSPACE_ROLES` in `src/db/workspace-roles.ts`).
- `workspace_id` (required) on `integrations`, `repositories`, `jobs` and `app_settings`; a project
  belongs to a workspace through its repository. `repositories` and `jobs` repeat it so that no query
  needs a join to scope. Two composite foreign keys make the database itself refuse a link across
  workspaces: a repository must name an integration of its own workspace, a job a repository of its own.
  `app_settings` is per workspace (primary key (workspace, key)): the review defaults of one workspace
  are not those of another. The unique index `(type, external_id)` on `integrations` stays global: one
  installation is linked to one workspace only.
- `users.github_login` is optional (a user can exist without a GitHub account); `users.imported_at` is
  null except for users the import of an existing installation marks.
- **Backfill.** A database that holds data (a row in `users`, `integrations`, `repositories`, `projects`,
  `jobs` or `app_settings`) gets one workspace, "Default workspace" (slug `default`), and every row of
  the four tables moves into it; no row is lost or changed otherwise. A database without data gets no
  workspace: the first-run setup makes it. **The migration creates no membership**; who becomes a member
  was decided by the import of an existing installation (removed in #700) from the allow list of that
  day.
- **How the tables are rebuilt.** SQLite cannot add a NOT NULL column that references another table,
  and the usual rebuild recipe needs `PRAGMA foreign_keys = OFF`, which does nothing inside the
  migration transaction. So the chain `integrations`, `repositories`, `projects`, `jobs`, `job_comments`
  is rebuilt parents first (rename to `*_old`, create, copy), the old tables are dropped leaf first and
  the indexes are created last. No foreign key is violated at any point. `users` is not rebuilt (its
  children cascade on delete): `github_login` is replaced by a nullable copy of itself.
- **Postgres.** The same migration runs on Postgres with two guarded differences, none of which
  touches the SQLite statements or their order: Postgres refuses a composite foreign key whose target
  has no matching unique constraint, so `integrations_id_workspace_unique` is created before the
  `repositories` table on Postgres (and after it, in its shipped place, on SQLite); and Postgres keeps
  an explicitly named constraint's name when a table is renamed, so `job_comments_pk` is freed before
  the new `job_comments` reuses it. A fresh SQLite `sqlite_master` is byte-for-byte the shipped one.
- **Time budget.** The migration of a database with 10 000 jobs that each hold a result of about 2 KB
  must finish within 10 seconds in one transaction (`workspace-migration.integration.test.ts`). It
  takes about 0.4 seconds on a laptop; the budget is generous so that a slow CI machine does not make
  the test flaky. The size of the results matters: dropping `jobs_old` deletes its rows, and for every
  row SQLite looks for rows that refer to it through `superseded_by`. Without the index
  `jobs_old_superseded_by` that is a scan per row, and this very database took 44 to 47 seconds. Any
  later change that rebuilds a table with a self-reference needs the same index. If you make the
  migration slower, say why here.

### Instance settings, rate limits and the instance admin flag

Migrations `20261011170000_create_instance_settings`, `20261011170100_create_rate_limits` and
`20261011170200_add_instance_admin_flag_to_users` (docs/decisions/0001-editions-setup-and-accounts.md,
sections 2.2, 2.3 and 2.10):

- `instance_settings` (key, JSON value, `updated_by` user id or null, `updated_at`): the settings of the
  whole instance (`instance-settings-repository.ts`, typed by key). The first-run setup state is two
  explicit rows, `setup_completed_at` and `import_state`; a database from before them reads as null and
  `none` (`src/setup/README.md`). `tenancy` and `sign_up_rule` are written by the setup; `github_app` and
  `sign_in_methods` by the admin portal. (`import_state` and `import_notice` belonged to the import of an existing
  installation, removed in #700; old rows may still exist.)
- `rate_limits` (key, `window_started_at`, `count`): shared counters with a window for the endpoints that
  must limit the same way whichever app instance a request reaches (`rate-limits-repository.ts`, `hit` is
  one statement, so attempts that arrive together are all counted). The email and password sign in
  uses it (`src/auth/sign-in-limit.ts`); the setup code has its own counters (in memory on a server, in `setup_codes` in a serverless deployment).
- `users.is_instance_admin` (0 or 1, default 0): set for the account the setup creates.

Migration `20261015110000_create_setup_codes` (#321): `setup_codes` (`id`, `code_hash`, `created_at`, `expires_at`,
`used_at`, `failures`, `window_started_at`, `attempts_in_window`) holds the first-run setup code of a serverless
deployment, at most one row (`setup-codes-repository.ts`, `src/setup/database-code-store.ts`). The code is stored as a
keyed hash only. A server never reads or writes the table. The migration is additive, so an instance from before it
keeps working while the migration runs (it never reads the table).

None of these is customer data, so none is workspace scoped (`scoping.test.ts` lists them as instance
level).

### Secrets, password reset tokens and email verification tokens

Migrations `20261011200000_create_secrets` and `20261011200100_create_password_reset_tokens` (sections 2.3
and 2.7):

- `secrets` (name, ciphertext, nonce, `key_version`, `last_four`, `updated_by`, `updated_at`): the encrypted
  credentials of the instance, one row per name (`secrets-repository.ts`, used through `src/secrets/`). The
  name is the row id that is bound into the ciphertext.
- `password_reset_tokens` (`token_hash`, `user_id`, `created_at`, `expires_at`, `used_at`): single-use reset
  links; only the SHA-256 hash of the token is kept (`src/auth/password-reset.ts`). A row goes with its user.
- `email_verification_tokens` (`token_hash`, `user_id`, `email`, `password_hash`, `created_at`, `expires_at`, `used_at`), migration
  `20261011210000_create_email_verification_tokens` (section 2.5): single-use verification links, valid 24 hours;
  only the SHA-256 hash of the token is kept, and a link is bound to the address it was made for and to the password hash of the sign-up that made it
  (`src/signup/`). A row goes with its user.
- `instance_settings` gained two keys: `sign_in_methods` and `max_workspaces_per_user` (typed in
  `instance-settings-repository.ts`, which also reads a value with who saved it and when).
  A third key, `smtp`, holds the mail server's settings (the password is in `secrets`, never here); the repository
  can also `remove` a setting. A fourth, `github_app`, holds the GitHub App's non-secret settings (app id, slug,
  client id, the "private app" flag, where it came from; the private key, webhook secret and client secret are in
  `secrets`, `src/github-config/`).

### Signed states, the address conflict and the accounts indexes

Migrations `20261012120000_create_signed_states`, `20261012120100_add_users_email_conflict` and
`20261012120200_unique_accounts` (sections 2.4, 2.5 and 2.9):

- `signed_states` (`id` = the nonce, `purpose`, `user_id`, `session_hash`, `code_verifier`, `data`, `created_at`,
  `expires_at`, `used_at`): the single-use side of the signed `state` values of the round trips through GitHub (the
  manifest flow, linking a GitHub identity), `src/signed-state/`. A row goes with its user and is removed by the
  clean-up once it has expired.
- `users.email_conflict`: GitHub's verified primary address when another account has it already, so an imported
  user's placeholder address could not be replaced (`src/github-signin/decide.ts`). Null otherwise.
- Unique indexes on `accounts`: `(provider_id, account_id)` (an identity belongs to one user) and `(user_id,
provider_id)` (a user has one identity per way to sign in), so linking a GitHub identity is safe when two requests
  race.

### The landing page's PostHog identity on the user

Migration `20261025140000_add_users_posthog_identity` (#692): `users.posthog_distinct_id`, `users.posthog_session_id` and
`users.posthog_captured_at` (nullable text; the time is ISO 8601, UTC). A visitor of code-review.com who accepted tracking there
brings the PostHog distinct id and session id to the sign-up; the app writes them once on the user (first touch, the time
being what makes it once) and **never reads, shows or logs them**. They are the user's own row, not a workspace's data
(`users` is global), so they go with the user and not with a workspace. Origin, rules, retention and the cookie that carries
them across the GitHub redirect: `src/landing-identity/README.md`.

### Workspace secrets and the remembered keys of jobs

Migrations `20261012140000_create_workspace_secrets` and `20261012140100_create_job_claimed_keys` (sections 2.7, 2.8
and 2.10):

- `workspace_secrets` (`workspace_id`, `name`, `binding`, `ciphertext`, `nonce`, `key_version`, `last_four`,
  `updated_by`, `updated_at`; primary key (workspace, name)): the encrypted credentials of one workspace, today its LLM
  key (`workspace-secrets-repository.ts`, scoped, used through `src/secrets/workspace-store.ts`). The workspace id
  and the name are bound into the ciphertext; `binding` is the provider the key was entered for. A row goes with
  its workspace.
- `job_claimed_keys` (`job_id`, `ciphertext`, `nonce`, `key_version`, `created_at`): the LLM key handed to a runner
  with the claim of a job, encrypted, so any app instance can mask a result (`job-claimed-keys-repository.ts`,
  instance level; `src/runner-api/claimed-keys.ts`). A row goes with its job and with the cleanup a week after the
  job finished.

### Workspace entitlements

Migration `20261014120000_create_workspace_entitlements` (#271; epic #268). It adds an empty table and touches no
existing row:

- `workspace_entitlements` (`workspace_id` as the primary key, `plan_label`, `key_mode` `own` or `managed`, `limits`
  as JSON text, `period_start`, `suspended` as 0 or 1, `suspension_code`, `updated_at`, `updated_by`): what an
  operator allows one workspace (`workspace-entitlements-repository.ts`, scoped; one row per workspace, so `get`
  and `put` take no id). The checks refuse a key mode other than the two, a suspended flag other than 0 and 1, and
  a suspension code on a workspace that is not suspended. The row goes with its workspace. `put` validates
  (`src/workspaces/entitlements-validation.ts`) and never lets `period_start` move to an earlier time: one upsert
  whose `where` compares the stored and the new start, so a repeated or late reset is harmless. `remove()` deletes the row (#275, the operator API's `DELETE`), and
  that ends the guard for the workspace: the stored start was what it compared with. The operator API documents
  the consequence (`src/operator-api/README.md`): a later `put` with an earlier start is accepted, and a `put`
  without a start begins now.
- The instance setting `default_entitlements` (`instance-settings-repository.ts`, the same fields without the
  workspace) applies to every workspace without a row. `set` validates it the same way and checks the period
  start under a transaction lock (`entitlements-lock.ts`: an advisory lock on Postgres). The generic `remove(key)`
  would end the guard for the default in the same way. The operator API offers no removal of the default (#275), so
  nothing in the app calls it for this key.
- **Reading is checked too.** The columns of a row and the JSON of the default are not trusted: both are read
  through `readEntitlements` (the same rules as a write, except the clock). `get()` and `getDefaultEntitlements()`
  never throw on damaged data; an entry that cannot be read comes back as `{ invalid: true }`, which the resolver
  turns into `invalid` (fail closed, see `src/workspaces/README.md`). The generic `get`/`getWithMeta` of the
  settings do not accept `default_entitlements` (type `ReadableSettingKey`), so nobody reads the raw JSON by
  accident.
- No row and no default means unlimited, as before. Only `resolveEntitlements` (`src/workspaces/entitlements.ts`)
  interprets the data; see `src/workspaces/README.md`, "Entitlements".

Migration `20261017160000_add_workspace_entitlements_model_access` (#428; epic #420) adds one nullable text column
`model_access` to `workspace_entitlements`: JSON `{"catalogEntries":[...]}`, or NULL for every released entry (what every
earlier row has). Nothing else changes and no existing row is touched; an app of the previous release never names the
column, so it keeps inserting and reading rows. `put` does not write the column when the entitlements leave
`modelAccess` out (the upsert's update set omits it), and the default keeps its stored list the same way under the lock. A write that leaves the field out over a stored
default that cannot be read is refused (`catalog_entry_invalid`, field `modelAccess`, nothing written): a damaged row
stays unreadable under such a write, and the default must not widen to every released entry; stating `modelAccess` repairs it.
The default (`default_entitlements`) holds the field inside its JSON and needs no column.

### Usage records

Migration `20261014150000_create_usage_records` (#272; epic #268). It adds an empty table and touches no existing row:

- `usage_records` (`id`, `workspace_id`, `job_id` unique, `review_kind`, `key_mode`, `model_tier`, `state`
  `reserved`/`settled`/`void`, `cost_micro_usd`, `prompt_tokens`, `completion_tokens`, `reserved_at`, `settled_at`):
  what each run consumed (`usage-records-repository.ts`, scoped; the claim and the completion in
  `runner-jobs-repository.ts` write it through that repository with the job's own workspace). Checks refuse an
  unknown state, kind or key mode, a settled record without its time (or any other with one), a measurement on a
  record that is not settled, and a negative amount. Cost and tokens are `integer` (32 bit on Postgres; the code stores a
  larger number as unknown). The id is text; readers page through the settled records by `(settled_at, id)`. Rows are
  never deleted. See `src/usage/README.md`.

Migration `20261015200000_add_usage_record_settled_reason` (#273). It adds one nullable column, `settled_reason`, to
`usage_records` and touches no row: why a record was settled without a report of its run (`no_result`). A check
allows only that value. A previous release's app instance never names the column, so it keeps working against the
migrated database; its writes leave the reason empty.

### Job dispatches

Migration `20261015120000_create_job_dispatches` (#326; epic #316). It adds an empty table and touches no existing row,
so an app of the previous release on the same database is unaffected:

- `job_dispatches` (`job_id` primary key and foreign key to `jobs`, `state` `pending`/`acked`/`stopped`, `attempts`,
  `consecutive_failures`, `next_dispatch_at`, `acked_at`, `last_attempt_at`, `last_status`, `last_code`, `created_at`,
  `updated_at`): where the signed wake-up call of a job stands (`job-dispatches-repository.ts`, instance level: the
  sender and the sweep work from a job id and the table holds no repository data). Written only with
  `RUNNER_DISPATCH=webhook`; in the default poll mode it stays empty. A partial index serves the due rows. The sweep
  (#328) removes the rows of jobs that finished a week ago and makes a `stopped` row pending again after 10 minutes.
  See `src/dispatch/README.md`.

### Refusal notices

Migration `20261016090000_create_refusal_notices` (#281; epic #268). It adds an empty table and touches no existing row,
so an app of the previous release on the same database is unaffected (it never reads the table):

- `refusal_notices` (`id`, `workspace_id` and `repository_id` foreign keys, `pr_number`, `period_start`, `code`
  `quota_exhausted`/`workspace_suspended`, `state` `pending`/`posted`/`dropped`, `attempts`, `next_attempt_at`,
  `posted_at`, `created_at`, `updated_at`): the record that a pull request got the notice of a refused review in a
  period. Scoped (`refusal-notices-repository.ts`); a unique index on workspace, repository, pull request and period
  start is the dedupe, a partial index serves the cron sweep's read of the due ones (`refusal-notices-sweep.ts`,
  instance level). See `src/refusal-notices/README.md`.

### Plan handoff tokens

Migration `20261016120000_create_plan_handoff_tokens` (#284; epic #268). It adds an empty table and touches no existing
row, so an app of the previous release on the same database is unaffected (it never reads the table):

- `plan_handoff_tokens` (`token_hash` primary key: the SHA-256 of a token of 256 random bits, never the token;
  `workspace_id` and `user_id` foreign keys, `user_id` `on delete cascade`; `role` `owner`/`admin`, the role at the click;
  `created_at`, `expires_at` five minutes later, `used_at`, `revoked_at`): the single-use hand-over of an Owner or Admin
  to the operator-configured plan page. Making one is scoped (`plan-handoff-tokens-repository.ts`: it revokes the same
  person's unused tokens of the workspace and inserts, in one transaction); redeeming one is by the hash alone and
  instance level (`plan-handoff-redeem-repository.ts`: one guarded `update … returning`, then the role is read again).
  Rows are removed a day after they expired (`src/maintenance/cleanup.ts`); the table is listed in the user merge
  (`github-signin/merge.ts`, ends with the retired user). See `src/plan-handoff/README.md`.

### Model catalog entries

Migration `20261017140000_create_model_catalog_entries` (#425; epic #420). It adds an empty table and touches no existing
row, so an app of the previous release on the same database is unaffected (it never reads the table):

- `model_catalog_entries` (`id` primary key, opaque `mce_…`; `name` and `name_key`, the name folded to lower case with a
  unique index, so two names never differ only in case and no expression index is needed; `description`; `provider` and
  `model_id`, operator only; `serves_diff` and `serves_dynamic`, 0 or 1 with a check that at least one is 1; `status`
  `draft`/`released`/`retired` (a check); `sort_order`; `created_at`, `updated_at`; `updated_by` → `users.id` `on delete
set null`): the operator's list of the models that workspaces on the operator's key may use. Instance level
  (`catalog-repository.ts`): no workspace owns an entry. A released entry is never hard-deleted. See
  `src/model-catalog/README.md`. The user merge moves `updated_by` (`github-signin/merge.ts`).

### The models.dev catalog

Migration `20261019200000_create_models_dev_catalog` (#548; epic #420). It adds three empty tables and touches no existing
row, so an app of the previous release on the same database is unaffected (it never reads them). Instance level
(`models-dev-repository.ts`, `src/models-dev/README.md`): the catalog is read from models.dev at run time, not owned by a
workspace, and **nothing in it is ever deleted**.

- `models_dev_providers` (`provider_id` primary key, the id models.dev uses; `name`; `url_state` `trusted` / `url_changed` /
  `rejected` with a check, and a check that only `rejected` may lack a `trusted_url`; `trusted_url` is where a real key is
  sent, `pending_url` the address that differs from it and waits for an admin, `url_problem` why an address was refused,
  `url_changed_at`; `first_seen_at`, `unlisted_at`, `updated_at`).
- `models_dev_models` (primary key `provider_id` + `model_id`, foreign key to the provider; `name`, `family`,
  `context_limit`, `output_limit`, `input_limit`, the flags `reasoning`, `temperature` and `attachment` as 0 or 1,
  `modalities` as JSON, `upstream_status` (`deprecated` is a warning), `cost` as JSON with decimal strings (USD per million
  tokens, tiers included), `upstream_updated`, `interleaved` as JSON; `first_seen_at`, `unlisted_at`, `updated_at`).
- `models_dev_fetch_state` (one row, `id = 'models.dev'` by a check): `last_attempt_at`, `last_success_at`, `last_status`
  `ok` / `failed`, `last_error` (a stable code of `MODELS_DEV_FETCH_ERROR_CODES`) and `last_summary` as JSON. A run writes
  `last_attempt_at` before it starts (`recordAttempt`; a row made that way reads `failed` / `models_dev_interrupted` until
  the run ends), so a run the platform stops is not repeated at once.

Every text in the first two tables is untrusted data from models.dev, length-capped and one line before it is stored. A fetch
reads the provider rows `FOR UPDATE` on Postgres (`listProviders({ forUpdate: true })`) inside the transaction that writes
them, so a guarded update of one provider by an admin (#554) is not written over; on SQLite every transaction begins
`begin immediate`.

### Model enablement and price confirmation

Migration `20261020090000_create_model_decisions` (#549; epic #420). It adds two empty tables and touches no existing row, so
an app of the previous release on the same database is unaffected. Instance level (`model-enablements-repository.ts`,
`model-price-confirmations-repository.ts`, `src/model-prices/README.md`): the admin's decisions about models of the
models.dev catalog, not owned by a workspace, and **a confirmation is never changed or deleted**.

- `model_enablements` (`(provider_id, model_id)` primary key and foreign key to `models_dev_models`; `enabled` 0 or 1 with a
  check; `changed_by`, `changed_at`): whether the admin enabled the model for the managed key. One row per model, changed in
  place. No row means the admin has not decided (the model is "new" while it is also newer than the first fetch); the admin
  can take a decision back (`clear`), which puts the model back to that state.
- `model_price_confirmations` (`seq` identity / rowid, the order rows were written in; `(provider_id, model_id)` foreign key to
  `models_dev_models`; `source` `catalog` / `admin`; `price` the confirmed price book and `reference_price` the price models.dev
  and the override file stated at that time, both JSON text with amounts as decimal strings of whole micro-USD per million
  tokens; `reference_hash` SHA-256 of the reference; `reason`; `confirmed_by`, `confirmed_at`): checks make a correction carry
  a reason and a confirmation as shown carry a reference. The latest row of a model counts; the price is stale once today's
  reference hashes differently, or when the stored hash is of another version than the current one (`v2:` prefix; the bare
  digest of the first release is version 1 and counts as stale). A row whose JSON cannot be read back is reported as
  unreadable (never as "no confirmation"), and a new confirmation repairs it. Triggers refuse an update, a delete and (Postgres) a truncate, like the billing journal.
  `confirmed_by` and `changed_by` have no foreign key: the history stays as written when a user is deleted.

### Billing at the claim (#498)

Two migrations, both only widen a check, so an app of the previous release on the same database keeps working and no row changes:
`20261021090000_widen_refusal_notice_codes` (`refusal_notices.code` takes `insufficient_balance` and `balance_negative`) and
`20261021090100_widen_job_vm_runs_end_source` (`job_vm_runs.end_source` takes `app_stop_unreported` and `claim_wall_clock`). Postgres replaces the
constraint; SQLite cannot change a check in place, so the table is rebuilt (a new one with the wider check gets every row, the old one is dropped with
its indexes, the new one takes its name and its indexes back). Nothing references either table. The instance setting `dispatcher_sightings`
(`{ withVmLifecycleAt, withoutVmLifecycleAt }`) needs no migration. **Retention:** `job_vm_runs` has non-cascading foreign keys to `jobs` and
`workspaces`; whoever adds retention or workspace deletion must delete its rows first (the review of #524, N-5).

### Billing journal and balances

Migration `20261019150000_create_billing_journal` (#495; epic #489, ADR 0006, 2.7). It adds two empty tables and touches no
existing row, so an app of the previous release on the same database is unaffected (it never reads them):

- `billing_journal_entries` (`seq` primary key, the order entries were written in: a Postgres identity, the SQLite row id
  (an `integer primary key`, which only grows because nothing is ever deleted; not `autoincrement`, see the convention
  below); `id` text, unique; `workspace_id` → `workspaces.id`; `type`, one of `top_up`, `start_credit`,
  `reservation`, `usage`, `release`, `refund`, `chargeback`, `correction`; `amount_micro_usd`, a signed integer; `ref_key`, the job
  id or the provider reference; `job_id`, `review_kind`, `minutes`; `ai_micro_usd` and `infra_micro_usd` of a `usage`;
  `reverses_entry_id` → the same table; `provider`, `provider_ref`, `actor_user_id`, `note`; `created_at`). **Append-only.**
  Checks: the type; the sign per type (`top_up`, `start_credit`, `release` positive; `reservation`, `usage`, `refund`,
  `chargeback` negative; `correction` non-zero either way); a `usage` carries both parts and they add up to its amount, no
  other type has parts; only a `correction` reverses; a `reservation`, `usage` or `release` has its job. Unique:
  `(workspace_id, type, ref_key)` (D14, the idempotency key) and `reverses_entry_id` (an entry is reversed once).
  `job_id` and `actor_user_id` have **no foreign key** on purpose: the account merge and the deletion of a user rewrite
  their references, and a journal that is never updated must not be blocked by, or rewritten with, a row that goes.
- `billing_balances` (`workspace_id` primary key → `workspaces.id`, `balance_micro_usd`, `reserved_micro_usd` with a check
  `>= 0`, `updated_at`): the cache of the journal, one row per workspace, created by the first entry. `balance` is the sum of
  all entries (a reservation is a debit, so it already excludes held money); `reserved` is the open reservations.
  The repository (`billing-journal-repository.ts`, scoped) updates it in the transaction of every entry; `verify()` compares
  it with the journal.
- **Immutability.** Triggers refuse an `UPDATE` and a `DELETE` of an entry on every connection: a function
  (`billing_journal_entries_guard`) and a row trigger for update and delete plus a statement trigger for `TRUNCATE` (the
  migration also created one trigger each for update and delete on SQLite, which no longer runs). Every refusal carries
  `billing_journal_entries_immutable`. A mistake is a new `correction` entry. The down migration drops the guard function on Postgres, which a
  table drop leaves behind (the same note as the removed billing migrations below).
- **Money is an integer** in micro-USD, never a float and never a 32 bit column (it would stop at about USD 2,147):
  `bigint` on Postgres. Postgres returns a `bigint` as text, so the repository converts every amount with `Number`
  (exact up to 2^53).
- **Concurrency.** Everything that writes is one transaction and idempotent on the key. `reserve` (an old hold) and `charge` (the price of a job, #605) take
  the balance row's lock (Postgres `FOR UPDATE`; SQLite's `begin immediate` already serializes writers), answer a
  repeated job from the entry they wrote, and `settle` and `release` take the same lock before they read what the job
  has, so a settlement never charges a job a concurrent release voided. `append` takes it too, before it writes: every
  writer is "balance row first", so no two can wait for each other (an `append` that wrote first deadlocked with a
  `settle` on the same key). The hold itself is `UPDATE billing_balances SET balance = balance - :hold, reserved = reserved + :hold WHERE
workspace_id = :w AND balance >= :hold`; no row changed means the hold is refused and nothing is written. Every other
  entry adds to the balance unconditionally, so the balance goes below zero only through a settlement, refund, chargeback
  or correction. The balance row is updated, then inserted if missing, never upserted: Postgres checks the row it would
  insert (`reserved >= 0`) before it looks for a conflict. See `src/billing/README.md`.
- **Open question: deleting a workspace.** `workspace_id` is a plain foreign key (no cascade) and the journal refuses
  `DELETE`, so a workspace with a journal entry can never be deleted. No code deletes a workspace today. Whoever builds
  workspace deletion has to decide (retention and erasure on request against an immutable ledger) before it can work.

### Top-up intents and provider events

Migration `20261019170000_create_billing_topup_intents` (#497; epic #489, ADR 0006, 2.12 and 2.13). It adds two empty
tables and touches no existing row:

- `billing_topup_intents` (`id` primary key; `workspace_id` → `workspaces.id`; `adapter`; `amount_micro_usd`, what WE asked
  for, a check `> 0`; `state`, a check of `pending`/`paid`/`failed`/`expired`; `provider_checkout_ref` and
  `provider_payment_ref`, opaque provider ids, null until known; `credited_micro_usd`, what the payment credited (net), 0
  until paid, and `refunded_micro_usd` and `disputed_micro_usd`, the running totals of what refunds and disputes took
  back of it, with a check that neither is negative and that together they never exceed the credit; `provider_amount` and
  `provider_currency`, what the buyer was charged (gross, in the provider's unit) and in which lower case ISO 4217 currency,
  pinned when the payment is credited and null before (added by #502: `20261021170000` and `20261021190000`); `created_at`,
  `updated_at`). Unique per adapter on each
  of the two refs (NULLs do not collide), so one payment or checkout belongs to one intent. Written before any checkout
  exists; the only way a payment reaches a workspace. **Workspace scoped**
  (`billing-topup-intents-repository.ts`); `billing-topup-intent-directory-repository.ts` finds an intent from an event
  before the workspace is known (read only, instance level, listed in `scoping.test.ts`).
- `billing_webhook_events` (primary key `(provider, event_id)`; `outcome`; `subject` and `occurred_at`, which order the
  states of one refund or dispute, or name the payment of a payment event; `received_at`; `review_state`, `open` for an
  event an operator must review (a payment nobody could credit, a refund that could not be debited, a signed event that
  is no event) and `resolved` once it was, null otherwise; `workspace_id` and `intent_id`, two ids of our own, when the event
  could be attributed to one of our intents, else null (#502)). The first idempotency layer: an id, an outcome and an order, **no
  payload, no amount, no name**, so it is instance level (`billing-webhook-events-repository.ts`). Not pruned yet.

The amount column is `integer` on SQLite and `bigint` on Postgres, like the journal. See `src/billing/README.md`.

### The billing profile

Migration `20261021130000_create_billing_profiles` (#501; epic #489, ADR 0006, 2.13). One new, empty table, no existing row
touched: `billing_profiles` (primary key `workspace_id` → `workspaces.id`, so at most one profile per workspace; `legal_name`,
`country` (ISO 3166-1 alpha-2), `address_line1`, `address_line2`, `postal_code`, `city`, `vat_id` (normalized, a light format
check only); `confirmed_at`, `confirmed_by` (→ `users.id`, set null when the user goes) and `terms_version`, the business
confirmation of the first top-up, with a check that the time and the version are set together; `customer_adapter` and
`customer_ref`, the payment provider's customer made from the profile, both or neither; `created_at`, `updated_at`, the time of
the last edit of the content). **Customer data, workspace scoped** (`billing-profiles-repository.ts`; classified in
`scoping.test.ts`, with rows in `scoped-isolation.integration.test.ts`); never logged. See `src/billing/README.md`.

### The newest jobs of the instance

Migration `20261019183000_add_jobs_created_at_index` (#541). It adds the index `jobs_created_at_id` on `jobs (created_at,
id)` and touches no column and no row, so the release that is still running is not affected while it runs. The runs page
of the instance admin (`job-directory-repository.ts`) lists the newest jobs of every workspace in that order; without the
index each call sorts every job of the instance. `job-directory-repository.integration.test.ts` reads the query plan on
SQLite.

### The balances that hold something (legacy)

Migration `20261021120000_add_billing_balances_reserved_index` (#591). Since #605 no claim holds money, so the index is empty on an instance that never took a hold; it stays for the holds an earlier release may have written. It adds the partial index `billing_balances_reserved` on
`billing_balances (workspace_id) where reserved_micro_usd > 0` (the same on both engines) and touches no column and no row. The sweep
of stranded holds asks which workspaces have money reserved in every run; the index makes that read grow with the holds that are open,
not with the number of workspaces (`billing-holds-sweep.ts`; `stranded-holds.integration.test.ts` checks on Postgres that the read
needs no sequential scan, `add-billing-balances-reserved-index.integration.test.ts` that the migration adds the index and keeps the rows).

### The memory of the start credit

Migration `20261021150000_create_billing_start_credit_grants` (#507; ADR 0006, 2.16). It adds one empty table and touches no row, so the
release that is still running is not affected while it runs. `billing_start_credit_grants`: `github_account_id` (`text`, the primary
key: the numeric id of the GitHub account of an installation, checked to be a plain positive number on both engines), `workspace_id`
(`text`, the workspace that got the credit) and `granted_at` (ISO 8601 text in UTC). **`workspace_id` has no foreign key on purpose**:
the memory has to outlive the workspace, or deleting a workspace and creating it again would grant the account twice. The primary
key is what makes the grant race safe (`insert ... on conflict do nothing`). Instance level (`billing-start-credit-grants-repository.ts`),
ids and a time only: no login, no name, no address. See `src/billing/README.md`, "The start credit".

### The monthly limit, the hidden brake and their notices (#499)

Three forward-only migrations, the same on SQLite and Postgres, none of which touches an existing row, so the release that is still running is not affected while
they run. `20261021210000_widen_refusal_notice_codes_for_limits` replaces the check on `refusal_notices.code` (Postgres) or rebuilds the table with the wider check
(SQLite, like #498) so it takes `monthly_limit_reached` and `reviews_paused`; its `down` deletes the notices of those two codes first.
`20261021210100_create_billing_workspace_settings` adds `billing_workspace_settings`: `workspace_id` (primary key → `workspaces.id`, so at most one row per
workspace; a workspace without a row has no limit), `monthly_limit_micro_usd` (`bigint` on Postgres, 64 bit `integer` on SQLite; null or positive, checked),
`updated_by` (→ `users.id`, set null when the user is deleted) and `updated_at`. **Customer data, workspace scoped** (`billing-workspace-settings-repository.ts`,
classified in `scoping.test.ts` and covered row by row in `scoped-isolation.integration.test.ts`); `updated_by` is an audit pointer that a user merge moves to the acting admin (`github-signin/merge.ts`). `20261021210200_add_limit_query_indexes` adds `usage_records_workspace_reserved_at (workspace_id, reserved_at)` for the hourly brake and
`billing_journal_entries_type_created (workspace_id, type, created_at)` for the monthly sum, which also carries `amount_micro_usd` (`INCLUDE` on Postgres, a last key column on SQLite) so the sum is read from the index alone. The three versions sort after the migrations of the billing work that is open next to them (`20261021170000` to `20261021190100`), so the order is the same whichever lands first. See `src/billing/README.md`, "Limits at claim (#499)".

### Which jobs are settled, and the resolution of a payment review (#605, #603)

`20261022010000_add_usage_record_billing_state` (#605) adds `usage_records.billing_state`, nullable, checked to `open` or `settled`. With no hold at the claim the journal
can no longer say which jobs were claimed with billing on, so the record does: `open` from a claim with billing on, `settled` after the one settlement, null for a job
claimed with billing off (never charged). The column is nullable and no row changes, so a previous release on the same database keeps working. See `src/billing/README.md`,
"Start, settle". `20261022020000_add_billing_webhook_events_resolution` (#603) adds four nullable text columns to `billing_webhook_events` (`resolved_at`, `resolved_by`,
`resolution_note`, `resolution_entry_id`) and the partial index `billing_webhook_events_review_idx (review_state, received_at)` that serves the list and the count of payment
reviews; no row changes, and the table stays instance level (the actor is an operator, the note is the operator's own text). See "Payment reviews" there.

### Balance notifications (#506)

`20261022030000_create_billing_notifications` adds `billing_notifications`: `workspace_id` (→ `workspaces.id`) and `kind` (`low` or `empty`, checked) as the primary key, `state` (`armed` or
`sent`, checked), `sent_at` (null for a crossing that was not mailed), `delivery` (`none`, `due`, `sending`, `delivered`, `failed`, checked) and `updated_at`; a partial index `billing_notifications_due (workspace_id, kind) where delivery = 'due'`
finds the mails that wait. The table is new and empty and no existing row is touched. **Customer data, workspace scoped** (`billing-notifications-repository.ts`, classified in `scoping.test.ts`, covered row by row in `scoped-isolation.integration.test.ts`);
the one instance-level reader, `billing-notification-directory-repository.ts`, only claims due mails and records how a delivery ended. Written in the transaction of every journal write, see `src/billing/README.md`, "Balance notifications (#506)".

### The notice of an incomplete billing setup (#632)

`20261023090000_widen_refusal_notice_codes_for_billing_setup` replaces the check on `refusal_notices.code` (Postgres) or rebuilds the table with the wider check
(SQLite, like #499) so it takes `billing_rates_incomplete`: a review refused because billing is switched on but its setup is not complete gets a notice on its pull
request. No column changes and every row survives, so the release that is still running is not affected; its `down` deletes the notices of that code first. See
`src/refusal-notices/README.md`, "An incomplete billing setup (#632)".

### A deleted workspace (#658)

`20261023150000_add_workspace_deleted_at` adds the nullable `workspaces.deleted_at` (ISO 8601 UTC text): when the workspace was deleted. Deleting removes the
customer data and keeps the `workspaces` row as an anonymised tombstone (name "Deleted workspace", slug `deleted-<id>`), because the append-only billing journal
points at it. No row is touched, so a workspace that exists before is alive and the release that is still running is not affected; its `down` drops the column.
Every reader of the table leaves a tombstone out through `NOT_DELETED` / `isDeleted` (`repositories/workspaces-repository.ts`); `getIncludingDeleted` is the one
way to read it. See `src/workspaces/README.md`, "Deleting a workspace (#658)".

### Implementer sessions and turns (#751)

`20261030140000_create_implementer_sessions_and_turns` (epic #745, the Implementer of the factory deployment) adds two tables and one index. It runs on every
database, including code-review.com's, which never reads the tables.

- `implementer_sessions` (`repositories/implementer-repository.ts`, scoped): a branch the agent works on. `slot` numbers the sessions of a repository from 1; the
  queue (#752) gives the job of a turn `-slot` as its pull request number, so the existing "one running job per pull request" index means one running turn per
  session. `(repository_id, slot)` and `(repository_id, branch)` are unique. `head_commit`, `opencode_session_id`, `opencode_version` and `summary` are null until
  a turn has produced them; `status` is `running` until a turn has ended, then `idle`.
- `implementer_turns`: one instruction (`number` from 1, unique per session; this slice makes one). `job_id` is unique: **the status of a turn is the status of its
  job**, there is no second state machine. `model_choice` is JSON text of exactly `{entryId}` or `{provider, model}` (`implementer-model-choice.ts`; stored text of
  another shape is `IMPLEMENTER_MODEL_CHOICE_UNREADABLE`, never a guess). `cost_limit_cents` is the customer's limit, null when none.
- Composite keys keep the workspaces apart in the database itself, like `repositories` and `jobs`: a session names its repository by `(repository_id,
workspace_id)`, a turn its session and its job by `(session_id, workspace_id)` and `(job_id, workspace_id)`. The target on `jobs` is the unique index
  `jobs_id_workspace_unique`, the one change to an existing table.
- `createSessionWithTurn(task, createJob)` locks the repository row (as the enqueue of a review does), takes the next slot, writes the session, calls `createJob`
  (the queue makes the jobs row there, in the same transaction, with `-slot`) and writes the turn. A branch that is taken is answered with
  `IMPLEMENTER_BRANCH_TAKEN` by `on conflict do nothing`, not by a violation, so a transaction of the caller is not aborted by it. The caller takes the instance
  gate lock before this, as the enqueue does.
- **The session is set `idle` only by `recordTurnResult`.** A turn whose job ends without any result report (failed, cancelled, timed out) must call it with
  null fields (`{headCommit: null, opencode: null, summary: null}`: nothing stored changes, the status becomes `idle`), otherwise the session stays `running` forever.
- `created_by` is a user reference: the account merge moves it to the admin (`github-signin/merge.ts`, `USER_REFERENCES`). The erasure of a workspace deletes turns
  and sessions before jobs and repositories.
- **Live database.** The migration is expand only. The unique index on `jobs` is a plain `create unique index` (the migrator's transaction cannot take
  `CONCURRENTLY`) and blocks writes to `jobs` while it builds and while it waits for a writer that has not ended. So the migration sets `lock_timeout` to 5 s for its
  own statements and puts the earlier value back. Both tables are created before anything touches `jobs` (the index, then the turns' link to `jobs` as an `alter table`),
  because a lock lives until the batch commits: waiting for a writer on `users`, `repositories` or `workspaces` must not hold `jobs` (the queue) meanwhile. The reverse holds
  too: the foreign keys of the two new tables take locks on `users`, `repositories` and `workspaces` that are held until the batch commits, so writes to those three wait for as long as the rest of the migration runs, which includes the index waiting for a writer on `jobs`. `lock_timeout` is per statement: each waiting statement gives up after 5 s, and the waits of several statements add up. If a long writer holds `jobs`, the migration gives up with `MIGRATION_FAILED`, the whole batch is rolled back and the
  deployment can be run again (`create-implementer-tables.integration.test.ts` holds a writer open and checks exactly that).

`20261030190000_widen_review_kind_checks_for_implementer` (#752) takes the kind `implementer` into the checks on `usage_records.review_kind` and
`billing_journal_entries.review_kind` (a turn of the Implementer has a usage record and journal entries of its own kind). It adds one index and changes nothing else, on the live
database too: the old check is dropped and the wider one added under the same name in one transaction (no moment without a check; `drop constraint if exists`, so it
can be run again). Both take an exclusive lock on a leaf table (nothing references them) until the batch commits, so `lock_timeout` is 5 s and
`statement_timeout` 30 s for its statements, put back afterwards; a long writer makes it give up with `MIGRATION_FAILED` and the deployment can be run again
(`widen-review-kind-checks-for-implementer.integration.test.ts`).
**The index on `jobs`.** Last of all (so that waiting for a leaf table never holds `jobs`) it creates the partial index
`jobs_ended_after_claim (review_kind, finished_at) where claimed_at is not null` (`if not exists`; `down` drops it). The sweep of `no_capable_runner`
(`runner-jobs-repository.ts`, `cancelStrandedDynamic`) asks for each waiting Dynamic or Implementer job, under the exclusive gate lock, whether a job of its kind ended
after a claim within the deadline; with 100 000 jobs and 20 waiting that scan took 888 ms per sweep and, with the index (and `jobs_status_run_after` for the
`running` half, joined by a BitmapOr), 1.3 ms. Like the unique index of #771 it is a plain `create index`: it blocks writes to `jobs` while it builds and until the
batch commits, under the same `lock_timeout` (a long writer on `jobs` makes the migration give up and roll the batch back; tested) and `statement_timeout`.
**In one batch with #771's migration its waits cost the queue too.** The unique index of `20261030140000_create_implementer_sessions_and_turns` is a plain
`create unique index` on `jobs`: it holds a `SHARE` lock on `jobs` (reads go on, every write waits) until the batch commits, not only while it builds. When both
migrations are pending, they run in one batch (one transaction), so this migration's two lock waits on `usage_records` and `billing_journal_entries` (up to
2 x 5 s with `lock_timeout` 5 s, if a long writer holds either) happen while `jobs` is still locked by #771's index (its own index on `jobs` comes after them): during them the claims, heartbeats and enqueues of the queue wait as
well, not only the writers of the two leaf tables. A batch that gives up rolls back, and with it that `SHARE` lock. The window is bounded, and a database that ran #771's
migration in an earlier deployment does not have it.

### Implementer turn steps (#745)

`20261104100000_create_implementer_turn_steps` (the live view of the Implementer) adds one table and one index of its own; no existing table changes.

- `implementer_turn_steps` (`repositories/implementer-steps-repository.ts`, scoped): what the agent thought and did, one row for each part of the engine's messages,
  keyed by `(job_id, part_id)`. `kind` is `reasoning`, `text`, `tool` or `step`; `payload` is the record without `kind`, `partId` and `seq` as JSON text (the schema is text and
  integers only, see "Portable schema conventions"); `bytes` is its size. **A tool's output is never stored**: a tool record carries name, status, title, input and error. `seq` is
  the highest the runner has sent for the part (a retry or an older record that comes late does not overwrite it: `recordSteps` keeps the higher one, in the statement too, so two
  batches at the same moment cannot undo each other); `ordinal` is the `seq` of the part's first record, which never changes: the order the page shows the parts in.
  The index `(job_id, seq)` serves "what changed after `seq`".
- `recordSteps(jobId, leaseToken, records)` proves the claim in the transaction that stores the rows (a running turn of the Implementer of this workspace with this lease
  token, the job row share-locked) and **does not extend the lease**. It bounds a turn on its own: `MAX_STEPS_PER_TURN` parts and `MAX_STEP_BYTES_PER_TURN` of payload;
  a record past a bound is dropped and counted. The caps are checked in the same transaction, not under a lock of the turn: a runner has one sender, and two batches at the
  same moment could pass the bound by one batch at most.
- The composite key `(job_id, workspace_id)` to `jobs` keeps the workspaces apart in the database, like the other Implementer tables. The erasure of a workspace deletes the steps
  before the turns and the jobs. The steps are kept as long as the job (no sweep, owner's decision of 2026-11-04).
- **Live database.** Expand only: the table is created first (waiting only for `workspaces`, which holds nothing of `jobs`), the index, then the link to `jobs` as an `alter table`
  last, with `lock_timeout` 5 s for its own statements (`create-implementer-turn-steps.integration.test.ts` holds a writer open and checks that the batch gives up and can be
  run again).

### A database that ran the removed billing migrations

Three migrations of an earlier billing design existed on `development` for a few days and are deleted (#491):
`20261018120000_create_billing_plans`, `20261018140000_protect_billing_plan_versions` and
`20261018160000_create_billing_plan_prices`. They never reached `main`, so **no production database ran them**, and no
removal migration exists: a deleted migration is deleted. A fresh database and a database of `main` migrate to latest
without them (`migrations/upgrade-from-main.integration.test.ts`).

A **local, preview or staging** database that ran `development` in that time has the three migrations recorded without a
file, and the migrator refuses to start (`previously executed migration ... is missing`, reported as
`MIGRATION_FAILED`). The fix is a manual maintainer step, never automated, and never against production data:

1. Look first, read-only: `SELECT name FROM kysely_migration WHERE name LIKE '%billing%';`. No row: nothing to do. Check
   `SELECT count(*) FROM billing_plans;` too: the tables hold only what an admin typed into the removed plans page.
2. Back the database up, then run, in one transaction (the tests run these very statements,
   `migrations/upgrade-from-main.integration.test.ts`):

   ```sql
   DROP TABLE billing_plan_versions;
   DROP TABLE billing_plan_prices;
   DROP TABLE billing_plans;
   DELETE FROM kysely_migration
     WHERE name IN (
       '20261018120000_create_billing_plans',
       '20261018140000_protect_billing_plan_versions',
       '20261018160000_create_billing_plan_prices'
     );
   DELETE FROM instance_settings WHERE key = 'billing_settings';
   DELETE FROM instance_settings
     WHERE key = 'default_entitlements' AND value LIKE '%"source":"billing"%';
   ```

   The order matters: a version points at its prices (`monthly_price_id`, `yearly_price_id`) and the prices and the
   versions point at the plans, so versions go first. SQLite and Postgres take these statements as they are; dropping a
   table drops its triggers on both.

   **Postgres only**, in the same transaction: a table drop does not drop the two trigger functions the migrations
   created, and they would stay in the schema. SQLite has no functions, and its triggers went with the tables.

   ```sql postgres
   DROP FUNCTION IF EXISTS billing_plan_versions_guard(), billing_plan_prices_guard();
   ```

   The two `DELETE FROM instance_settings` statements leave nothing behind that changes behaviour, which is why they are part of the reset and
   not optional:

   - `billing_settings` of the old shape can say `enabled: true` (with an environment, a client token and grace days).
     The code still reads that as on, and the billing routes of a later issue would run on a database with no payment
     adapter and no rates. The row goes, and billing is off ("never configured") until someone switches it on.
   - A `default_entitlements` row with `"source":"billing"` is the default that the removed billing design wrote, not a choice of the
     operator. Left in place it would silently become the operator's default for every workspace without its own
     limits (its limits and `modelAccess` included). The rule: a default that carries the marker goes, and the instance
     has no default again until the operator saves one (operator API `PUT /api/operator/v1/entitlements/default`). A
     default without the marker was saved by an operator and stays.

3. Start the app: the remaining migrations run as usual. The two encrypted rows of `secrets` named after the removed
   payment provider (`<provider>_api_key`, `<provider>_webhook_secret`) are ignored and may be deleted by hand.

## Workspace scoping

Every repository that reads or writes customer data is created for one workspace:
`createIntegrationsRepository(db, workspaceId, ...)`, and the same for repositories, projects,
app settings, jobs and runs. Every query it runs filters or sets `workspace_id`, and an id of another
workspace is simply not there: fetching, changing or deleting it behaves like a missing id.
`WorkspaceId` is a plain string; a repository takes it as its second parameter, always named
`workspaceId`.

- `repositories/scoping.test.ts` reads the source of the repositories and fails when a module is
  neither scoped nor on the explicit list of instance level modules, or when an exported function of a
  scoped one takes a database connection without a `workspaceId`.
- `repositories/scoped-isolation.integration.test.ts` calls every method of every scoped repository
  with the scope of one workspace against the ids of another and checks that nothing comes back and
  nothing changes. It has a row for every method; a method without one fails the test.

Not scoped, each for a reason (the list is in `scoping.test.ts`):

| Module                                                               | Why                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `app-meta`, `allowed-login-pins`, `webhook-deliveries`, `workspaces` | Not customer data (facts about the installation, the sign-in allow list, delivery ids, the owners themselves)                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `integration-directory-repository.ts`                                | Reads integrations of any workspace. A webhook names an installation before anybody knows the workspace, and the synchronization walks every connection. It only reads, and the answer carries `workspaceId`; everything done next goes through scoped repositories                                                                                                                                                                                                                                                              |
| `usage-feed-repository.ts`                                           | The settled usage records of every workspace in one ordered feed, and the grouped count of runs that settled without a cost per workspace and key mode (#385), for the operator API (#278): the operator serves many workspaces from one token. It only reads (never a `reserved` or `void` record), and every record and count carries `workspaceId`; the reads of one workspace go through the scoped usage records repository                                                                                                 |
| `job-directory-repository.ts`                                        | The jobs of every workspace for the instance admin's job view (#541): the operator looks at a run by its id without being a member of its workspace, to see what a run did. It only reads (a page of the newest jobs without their results, and one job by its id), and every answer names its workspace; the only callers are the pages of the admin portal behind the admin guard. What a member sees of a run goes through the scoped runs repository                                                                         |
| `runner-jobs-repository.ts`                                          | The lease side of the job queue (claim, heartbeat, complete, release, expiry). Runners serve the whole instance with one token, so a claim hands out the oldest due job of any workspace; every change is fenced by the lease token, and the job it returns carries `workspaceId`                                                                                                                                                                                                                                                |
| `claim-admission.ts`                                                 | The check of the entitlements of a job the claim just took (#277), inside the claim transaction of the lease side of the queue, for whichever workspace the job is in. It reads, through repositories created for that job's workspace (the instance default and the workspace row it locks are not customer data), and decides; the ending of a refused job is the lease side's own statement                                                                                                                                   |
| `plan-handoff-redeem-repository.ts`                                  | The redemption of a handoff token by the external plan page through the operator API (#284). The caller holds only the token, so there is no workspace to scope to before it is looked up by its hash; it never lists, and the answer names the workspace the token was made for. Making a token is the scoped plan handoff tokens repository; the clean-up only deletes expired rows                                                                                                                                            |
| `refusal-notices-sweep.ts`                                           | The notices of refused reviews that are due to be posted again (#281), for the cron sweep that serves the whole instance. It only reads the `pending` rows whose wait is over, and every answer carries `workspaceId`; the record itself goes through the scoped refusal notices repository                                                                                                                                                                                                                                      |
| `catalog-repository.ts`                                              | The operator's model catalog (#425): instance configuration, not customer data; no workspace owns an entry. Its one read across workspaces is `countProjectsUsing`, one number per entry of how many projects use it (those that select it, and in a workspace on the operator's key those that fall back to it as the instance default; for the operator's "used by" and the confirmation when the model behind it changes); it returns no row, project or workspace. The member view selects only the columns a member may see |
| `models-dev-repository.ts`                                           | The catalog read from models.dev (#548): the providers and models a job can use, and the state of the last fetch. Fetched at run time from a public source, so not customer data, and no workspace owns a row. It stores and reads whole rows, takes no workspace, returns none, and never deletes (a row that disappears upstream gets `unlisted_at`)                                                                                                                                                                           |
| `model-enablements-repository.ts`                                    | Whether the admin enabled a catalog model for the managed key (#549): one row per model, changed in place, who and when of the last change. Instance configuration, not customer data; no workspace owns a row.                                                                                                                                                                                                                                                                                                                  |
| `model-price-confirmations-repository.ts`                            | The append-only history of what an admin confirmed as a catalog model's price (#549); the latest row counts, the database refuses an update and a delete. Instance configuration, not customer data; no workspace owns a row.                                                                                                                                                                                                                                                                                                    |

A signed-in user works in the workspace named by the address (`/w/<slug>`) and only in one they are a member
of (`src/workspaces/README.md`); the repositories of members and invitations below follow the same rule,
and the question "which invitations wait for this address?" is answered by the instance level
`invitation-directory-repository.ts`, which only reads.

## Portable schema conventions

The schema was written to be portable between SQLite and Postgres, and keeps those conventions: the migrations, the
codecs and the repositories are written to them. Every table follows these rules; `migrate.integration.test.ts` checks the ones it can on the real
schema.

| Kind            | Column type          | Stored as                                                                                                                                      |
| --------------- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Identifier      | `text`               | An application generated id (for example a UUID). Never `autoincrement` or a database sequence                                                 |
| Timestamp       | `text`, named `*_at` | ISO 8601 in UTC with milliseconds, e.g. `2026-10-10T12:30:15.042Z` (`formatTimestamp`). Time is injected into repositories (`now: () => Date`) |
| JSON            | `text`               | `JSON.stringify` output (`encodeJson` / `decodeJson`); `undefined` is refused, use `null` for "no value"                                       |
| Boolean         | `integer`            | `1` or `0` (`encodeBoolean` / `decodeBoolean`)                                                                                                 |
| Everything else | `text` or `integer`  | Numbers that are not booleans are `integer`; no floating point, no `blob`, no dates or booleans as native types                                |

More rules: foreign keys are declared and enforced; use plain schema builder features (no database specific pragmas in migrations); keep SQL out of
repositories where the query builder can express it.

Kysely's own bookkeeping tables (`kysely_migration`, `kysely_migration_lock`) use `varchar` columns
and are exempt.

## Using the connection

`getDatabase()` (`startup.ts`) returns the connection that the server opened in `register()` (in
serverless mode it opens the pool on its first call, see "Serverless mode"). It
works at request time only: `next build` workers (page data collection, prerendering) never call
`register`, so a route or component that reads the database while it is being prerendered gets
"The database is not initialized". Read the database in code that only runs per request (route
handlers, server actions, dynamic rendering, for example after `await connection()`), never at
build time. The `src/db` modules import `server-only`, so importing them in a client component
fails the build.

## Repositories

A repository is a small module that takes a `Kysely<Database>` (or a transaction) and exposes
functions in domain terms, for example `createAppMetaRepository(db).get("key")`. It converts between
application values and column values through `codecs.ts`; callers never see a stored `0`/`1`, a JSON
string or a timestamp string format. Route handlers and server code get the connection from
`getDatabase()` (`startup.ts`) and pass it in; tests pass in a database from
`src/test-support/test-database.ts`.

`integrations` (migration `20261010134000_create_integrations`, repository `integrations-repository.ts`, plus the
instance level `integration-directory-repository.ts`) holds the connections to git platforms; see `src/integrations/README.md`. It keeps no secret of a GitHub App, and the
repository refuses secret-looking keys in `config`.

`repositories` (migration `20261010143000_create_repositories`, repository `repositories-repository.ts`)
holds the repositories each integration can see. A repository the platform stops listing becomes
inactive (`active = 0`), never deleted; `reconcile` makes the rows of one integration match a
complete list in one transaction.

`projects` (migration `20261010190000_create_projects`, repository `projects-repository.ts`) holds
the repositories that are reviewed: one row per repository (`repository_id` unique), created by the
first activation or the first save of settings (then off), switched off with `active = 0`, never deleted; see `src/projects/README.md`.
`settings` holds the project's JSON overrides: the Diff review settings and, for one project, the
project-only review kind, Dynamic model and optional skill (`src/review-settings/README.md`). Missing
keys read as their defaults, so no migration is needed for new JSON fields. `updateSettingsWith`
computes the next settings from the stored ones in the write transaction, reading them under a lock on
the workspace-scoped repository row (SQLite's `begin immediate` write lock; Postgres `FOR UPDATE`), so
a read-modify-write on either database cannot lose a concurrent update. `updateSettings` /
`updateSettingsWith` run an optional `afterChange` hook in that same transaction (the settings-change
hook #195 uses).

`webhook_deliveries` (migration `20261010170000_create_webhook_deliveries`, repository
`webhook-deliveries-repository.ts`) holds the delivery ids the webhook route has accepted, so a
redelivery produces no second trigger; rows are pruned after 7 days; see `src/webhooks/README.md`.

`jobs` (migration `20261010191500_create_jobs`, rebuilt by `20261011160100_add_workspace_to_customer_data`;
the scoped repository `jobs-repository.ts` creates, drops and reads jobs, the instance level
`runner-jobs-repository.ts` with the claim in `jobs-claim.ts` hands them to runners) is the job queue (the index `jobs_repository_recent`, migration `20261011100000_add_jobs_repository_recent_index`, serves the runs pages: newest job of a repository, `runs-repository.ts`); the rules (dedupe, supersession, leases, attempts, timeouts) are
in `src/jobs/README.md`. `jobs-claim.ts` holds the one statement that needs more than the query builder (Postgres' `FOR UPDATE SKIP LOCKED`
plus a savepoint retry; see its head comment); everything else is query builder code.

`app_settings` (migration `20261010201500_create_app_settings`, rebuilt per workspace by
`20261011160100_add_workspace_to_customer_data`, repository `app-settings-repository.ts`) holds settings of
one workspace, one row per setting with a JSON value; the first is `review_defaults`, the default values of
the review settings of the workspace (`src/review-settings/README.md`).

`workspaces` and `workspace_members` (migration `20261011160000_create_workspaces`, repositories
`workspaces-repository.ts` for the questions that start from a user and `workspace-members-repository.ts` for
the members of one workspace) are described under "Workspaces and the migration that introduced them" above
and in `src/workspaces/README.md`.

`invitations` (migration `20261012100000_create_invitations`, scoped repository `invitations-repository.ts`,
instance level `invitation-directory-repository.ts`): the links that bring a person into a workspace. Columns:
`workspace_id`, the canonical `email` it is bound to, the `role` (the same check as `workspace_members`),
`token_hash` (SHA-256 of the 256 bit token, unique; the token itself is never stored, a resend replaces the
hash), `invited_by`, `created_at`, `expires_at` (7 days), and the ways it ends: `accepted_at` with
`accepted_by`, or `revoked_at`. A partial unique index allows one open (neither accepted nor revoked)
invitation per workspace and address; an expired one is ended by the code before a new one is made. Every
statement that ends or renews an invitation only touches an open one, and accepting only an open one that has
not expired (`invitations-repository.integration.test.ts`).

`installation_link_requests` and `unclaimed_installations` (migration `20261012150000_create_installation_binding`, section 2.9;
`src/installation-binding/`): a request is a person's ask to link an installation whose organization role the app could not
read, decided by the instance admin (scoped repository `installation-link-requests-repository.ts`, instance level
`installation-link-request-directory-repository.ts`). Columns: `workspace_id`, `requested_by`, the requester's GitHub login,
the installation id and its account (`account_login`, `account_type`, `account_id`), a `status` (pending, approved,
denied, withdrawn; a check constraint), the evidence (`token_can_access` and `role_result` with `role_detail`; never a
token), and the times and the admin who decided. A partial unique index allows one pending request per workspace and
installation, and a pending request is refreshed instead of repeated. `unclaimed_installations` (instance level
`unclaimed-installations-repository.ts`) notes the installations of the App that no workspace has linked (id, account, first and
last seen, whether a webhook or a synchronization saw it). `integrations.status` gained the value `disconnected` (the column is
text without a check). Both tables are in the merge of the instance admin with an imported operator (`USER_REFERENCES`).

`app_meta` (a key/value table for facts about the installation) exists to prove the setup. Product
tables come with the tickets that need them: add the migration, the row type in `schema.ts` and the
repository in the same change.

## Testing

`server-only` throws when it is imported outside Next.js server code, so Vitest resolves it to an
empty module (`vitest.config.mts`) and the child process runs with `--conditions=react-server`.

Anything that touches this layer is an `*.integration.test.ts` against a real Postgres database (see
`TESTING.md`, "Integration tests and Postgres"). `src/test-support/db-template.global-setup.ts` migrates one template
database per run, `createTestDatabase()` clones it into a database of its own for each test and drops it afterwards, so
workers never share data. Tests that need a second connection or a second app instance use a real child process
(`db-process.ts`, `db-child.ts`). `pnpm migrate`, the schema check and the cold-instance health answer are integration
tests too (`migrate-cli.integration.test.ts`, `schema-status.integration.test.ts`,
`../health/health-schema.integration.test.ts`).
