// SPDX-License-Identifier: LicenseRef-Proprietary

// #1058: which status of a Jira project a name stands for, whatever language it is in.
import { describe, expect, it } from "vitest";
import {
  nameOfStatusId,
  sameStatus,
  statusIdsNamed,
  type StatusRef,
} from "./status-match.ts";

const STATUSES: StatusRef[] = [
  { id: "1", name: "Zu erledigen", untranslatedName: "To Do" },
  { id: "2", name: "In Arbeit", untranslatedName: "In Progress" },
  { id: "3", name: "Done" },
  // Another status that is also called "To Do" in some workflow.
  { id: "9", name: "To Do" },
];

describe("statusIdsNamed", () => {
  // #1058
  it("finds every status whose name or untranslated name is the text, trimmed and case-insensitive", () => {
    expect([...statusIdsNamed(STATUSES, " zu ERLEDIGEN ")]).toEqual(["1"]);
    expect([...statusIdsNamed(STATUSES, "to do")].sort()).toEqual(["1", "9"]);
    expect([...statusIdsNamed(STATUSES, "Done")]).toEqual(["3"]);
  });

  // #1058
  it("finds nothing for a name the project does not have, or for an empty one", () => {
    expect(statusIdsNamed(STATUSES, "Blocked").size).toBe(0);
    expect(statusIdsNamed(STATUSES, "  ").size).toBe(0);
    expect(statusIdsNamed([], "To Do").size).toBe(0);
  });
});

describe("sameStatus", () => {
  // #1058
  it("decides by id when both sides have one, whatever the names say", () => {
    expect(
      sameStatus({ id: "1", name: "Zu erledigen" }, { id: "1", name: "To Do" }),
    ).toBe(true);
    expect(
      sameStatus({ id: "1", name: "To Do" }, { id: "9", name: "To Do" }),
    ).toBe(false);
  });

  // #1058
  it("resolves a name through the project's statuses when one side has no id", () => {
    expect(
      sameStatus(
        { name: "Zu erledigen" },
        { id: "1", name: "To Do" },
        STATUSES,
      ),
    ).toBe(true);
    expect(
      sameStatus({ name: "In Arbeit" }, { id: "1", name: "To Do" }, STATUSES),
    ).toBe(false);
    expect(
      sameStatus({ name: "Zu erledigen" }, { name: "To Do" }, STATUSES),
    ).toBe(true);
  });

  // #1058
  it("compares the spelling when the project's statuses are not known, and never calls two empty names the same", () => {
    expect(sameStatus({ name: "To Do" }, { name: " to do " })).toBe(true);
    expect(sameStatus({ name: "To Do" }, { name: "Zu erledigen" })).toBe(false);
    expect(sameStatus({ name: "" }, { name: "" })).toBe(false);
  });
});

describe("nameOfStatusId", () => {
  // #1058
  it("gives the name the REST API reads, and nothing for an unknown or missing id", () => {
    expect(nameOfStatusId(STATUSES, "1")).toBe("Zu erledigen");
    expect(nameOfStatusId(STATUSES, "77")).toBeUndefined();
    expect(nameOfStatusId(STATUSES, undefined)).toBeUndefined();
    expect(nameOfStatusId(STATUSES, "")).toBeUndefined();
  });
});
