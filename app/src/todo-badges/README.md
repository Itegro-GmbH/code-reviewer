# ToDo badges (#925)

The numbers of open ToDos that the navigation shows: the badge on the sidebar's ToDos link and the one on the ToDos tab of a project. A leaf of its
own, so that the shell, the project cockpit and the ToDos page (which sends the event) can use it without importing each other.

| File         | Role                                                                                                                                                                                                                              |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `events.ts`  | `TODOS_CHANGED_EVENT` (`factory:todos-changed`): sent by the ToDos page after an answer or a review and when its poll finds other open ToDos; the badges read again, fresh                                                        |
| `reader.ts`  | `readTodoCounts`: `GET /api/w/<slug>/todos/count` (`{ open, projects }`, `?fresh=1` after the event); reads of one workspace at the same time are one request; never throws, a failed read is `null`                              |
| `badges.tsx` | `TodoCount` (sidebar) and `ProjectTodoBadge` (the ToDos tab of a project, by project id): read when the page changes and on the event, drop a read that ends after a newer one started, show nothing for none or on a failed read |

The server side is `src/todos/` (`countOpen`, the 10 s cache in `shared.ts`); [`docs/todos.md`](../../../docs/todos.md#the-page) describes the behaviour.
