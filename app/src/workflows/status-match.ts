// SPDX-License-Identifier: LicenseRef-Proprietary

// Which status of a Jira project a name stands for (#1058, epic #1034). Jira localizes the status names it answers a REST call with (the
// language of the connected user: `Zu erledigen`), while a webhook delivery carries the name Jira keeps for every language (`To Do`). A name
// therefore says nothing; the id of the status does. A name is resolved to the ids of the project's statuses whose `name` or
// `untranslatedName` it equals (trimmed, case-insensitive), and two statuses are the same when their ids are. Pure: no network, no database
// (it lives here, not in `src/jira/`, because `workflow-runs` may not import `jira`: an import cycle).

/** A status of a project's workflow as Jira lists it. */
export type StatusRef = {
  id: string;
  name: string;
  /** The name Jira keeps for every language, when it says one. */
  untranslatedName?: string | undefined;
};

/** A status as one side of a comparison knows it: always a name, an id when the payload or the REST answer carried one. */
export type StatusSpec = { id?: string | undefined; name: string };

const fold = (name: string): string => name.trim().toLowerCase();

/** The ids of the statuses a name stands for (the localized or the untranslated spelling); empty for a name the project does not have. */
export function statusIdsNamed(
  statuses: readonly StatusRef[],
  name: string,
): Set<string> {
  const wanted = fold(name);
  const ids = new Set<string>();
  if (wanted === "") return ids;
  for (const status of statuses)
    if (
      fold(status.name) === wanted ||
      (status.untranslatedName !== undefined &&
        fold(status.untranslatedName) === wanted)
    )
      ids.add(status.id);
  return ids;
}

/**
 * Whether two statuses are the same one. Ids decide when both sides have one; otherwise the names do, as they are spelled or through the
 * project's statuses (`statuses` may be empty or unknown: then only the spelling is compared).
 */
export function sameStatus(
  a: StatusSpec,
  b: StatusSpec,
  statuses: readonly StatusRef[] = [],
): boolean {
  if (a.id !== undefined && a.id !== "" && b.id !== undefined && b.id !== "")
    return a.id === b.id;
  if (fold(a.name) === fold(b.name) && fold(a.name) !== "") return true;
  const first =
    a.id !== undefined && a.id !== ""
      ? new Set([a.id])
      : statusIdsNamed(statuses, a.name);
  const second =
    b.id !== undefined && b.id !== ""
      ? new Set([b.id])
      : statusIdsNamed(statuses, b.name);
  for (const id of first) if (second.has(id)) return true;
  return false;
}

/** The name the REST API reads the status with (the picker's spelling) for an id; undefined for an id the project does not have. */
export function nameOfStatusId(
  statuses: readonly StatusRef[],
  id: string | undefined,
): string | undefined {
  if (id === undefined || id === "") return undefined;
  return statuses.find((status) => status.id === id)?.name;
}
