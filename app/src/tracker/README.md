# Ticket mirror

A read cache of the issues and pull requests of a repository (#923, epic #915), rebuilt from the provider at any time and **never the
source of truth**. The page for people is [`docs/ticket-mirror.md`](../../../docs/ticket-mirror.md); this file is the map of the code.

| File                         | Role                                                                                                                                                                                                                                                                                                                                                                                                          |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mirror.ts`                  | `createTrackerMirror`: applies one `TrackerChange` of a webhook delivery to the cache of one workspace (only for a repository with an active project)                                                                                                                                                                                                                                                         |
| `sync.ts`                    | `createTrackerSync`: the full sync, one page of one phase (`issues`, `checks`, `board`) at a time, resumable through the cursor in `tracker_sync_state`; claimed atomically (one sync at a time); ends with the rebuild rule (rows not written since the sync began are removed unless a ticket could not be read, board statuses no board saw are emptied, the pull requests of the issues are linked again) |
| `service.ts`                 | `createTrackerService`: the list of the tickets with the enrichment read at the time of the question (`lane`, `costUsd`, from `workflow_runs.ticket_ref`) and the sync for one repository                                                                                                                                                                                                                     |
| `../cron/tracker-resync.ts`  | The nightly resync (#932): walks the active projects with the same sync, one project's failure never stops the others (`resyncTargets` in `shared.ts` lists them)                                                                                                                                                                                                                                             |
| `http.ts`                    | The handlers behind `GET .../repositories/:id/issues` and `POST .../repositories/:id/issues/sync`; the strict query check (`path`, `code`, `message`, `available`)                                                                                                                                                                                                                                            |
| `errors.ts`                  | The stable codes (`TRACKER_*`) and their statuses                                                                                                                                                                                                                                                                                                                                                             |
| `shared.ts`                  | The wiring on the running server: `trackerMirrorFor`, `trackerSyncFor`, `trackerServiceFor`                                                                                                                                                                                                                                                                                                                   |
| `fake-tracker-repository.ts` | The in-memory repository of the unit tests; it has to behave like the SQL one (`tracker-repository.integration.test.ts` proves the SQL)                                                                                                                                                                                                                                                                       |

Where the rest lives: the tables and the only SQL are in `src/db/repositories/tracker-repository.ts` (migration
`20261107160000_create_tracker_mirror.ts`); what a GitHub payload means is in `src/integrations/providers/github-app/`
(`tracker-events.ts` turns a delivery into a `TrackerChange`, `tracker-map.ts` turns issue and pull request JSON into
`TrackerItemFields` and the check suites into one state, `client.ts` has the three reads of the sync). This folder knows no GitHub: it
talks to the provider through `IntegrationProvider.parseTrackerChange`, `readTrackerPage` and `readChecksState`.

Rules that hold here:

- **Nothing is mapped.** The state, the type, the reason and the board status are the provider's words.
- **The cache never fails what else a delivery does.** The webhook handler logs a failure of the mirror by its code and goes on with the
  review or the workflow; only an event that the mirror alone reads (`sub_issues`, `projects_v2_item`, `check_suite`) fails the delivery
  so that GitHub redelivers it.
- **An older delivery never replaces a newer one**: a ticket, a parent change and a deletion are ordered by the provider's `updated_at`, and a deleted issue stays as a tombstone (`docs/ticket-mirror.md`, "Deliveries out of order").
- **The sync and the webhooks write the same shape with the same functions**, so that a cache that was deleted and synced holds what a cache
  that was kept current holds (`sync.test.ts`, "the rebuild rule").
- **`src/webhooks/` and `src/projects/` do not import this folder** (the import-cycle test): the routes wire it in
  (`app/api/webhooks/github-app/route.ts`, `.../repositories/[repositoryId]/project/route.ts`).
