// SPDX-License-Identifier: LicenseRef-Proprietary

// #1140: the cron expression of a `schedule` trigger: five fields, evaluated in UTC.
import { describe, expect, it } from "vitest";
import { cronMatches, latestOccurrence, parseCron } from "./cron.ts";

const at = (iso: string) => new Date(iso);

function parsed(text: string) {
  const schedule = parseCron(text);
  if (schedule === undefined) throw new Error(`${text} did not parse`);
  return schedule;
}

describe("parseCron", () => {
  // #1140-T01
  it.each([
    "* * * * *",
    "0 6 * * 0",
    "*/15 * * * *",
    "0 6,18 * * 1-5",
    "5-10/2 0 1 1 *",
    "0 0 1,15 * *",
    "30 6 * * 7",
    "0 0 * 12 *",
    "5/20 * * * *",
  ])("accepts %s", (text) => {
    expect(parseCron(text)).toBeDefined();
  });

  // #1140-T01
  it.each([
    ["", "empty"],
    ["0 6 * *", "four fields"],
    ["0 6 * * * *", "six fields"],
    ["0  6 * * *", "two spaces"],
    [" 0 6 * * *", "leading space"],
    ["60 * * * *", "minute out of range"],
    ["* 24 * * *", "hour out of range"],
    ["* * 0 * *", "day of month below 1"],
    ["* * 32 * *", "day of month above 31"],
    ["* * * 0 *", "month below 1"],
    ["* * * 13 *", "month above 12"],
    ["* * * * 8", "day of week above 7"],
    ["5-3 * * * *", "descending range"],
    ["*/0 * * * *", "step zero"],
    ["*/-1 * * * *", "negative step"],
    ["*/x * * * *", "step is no number"],
    ["a * * * *", "letters"],
    ["1,,2 * * * *", "empty list item"],
    ["1- * * * *", "open range"],
    ["*/2/3 * * * *", "two steps"],
    ["MON * * * *", "names are not supported"],
    ["1.5 * * * *", "decimal"],
    ["-1 * * * *", "sign"],
  ])("refuses %s (%s)", (text) => {
    expect(parseCron(text)).toBeUndefined();
  });
});

describe("cronMatches", () => {
  // #1140-T01
  it("matches every minute for five stars", () => {
    expect(cronMatches(parsed("* * * * *"), at("2026-11-29T06:07:00Z"))).toBe(
      true,
    );
  });

  // #1140-T01
  it("matches the owner's schedule, every Sunday 06:00 UTC", () => {
    const sunday = parsed("0 6 * * 0");
    expect(cronMatches(sunday, at("2026-11-29T06:00:00Z"))).toBe(true);
    expect(cronMatches(sunday, at("2026-11-29T06:01:00Z"))).toBe(false);
    expect(cronMatches(sunday, at("2026-11-29T07:00:00Z"))).toBe(false);
    expect(cronMatches(sunday, at("2026-11-30T06:00:00Z"))).toBe(false);
    expect(cronMatches(sunday, at("2026-11-22T06:00:00Z"))).toBe(true);
  });

  // #1140-T01
  it("reads 7 as Sunday too", () => {
    expect(cronMatches(parsed("0 6 * * 7"), at("2026-11-29T06:00:00Z"))).toBe(
      true,
    );
  });

  // #1140-T01
  it("evaluates in UTC, whatever the offset of the date's text", () => {
    // 08:00 at +02:00 is 06:00 UTC.
    expect(
      cronMatches(parsed("0 6 * * *"), at("2026-11-29T08:00:00+02:00")),
    ).toBe(true);
    expect(
      cronMatches(parsed("0 8 * * *"), at("2026-11-29T08:00:00+02:00")),
    ).toBe(false);
  });

  // #1140-T01
  it("takes lists, ranges and steps", () => {
    const schedule = parsed("*/20 6,18 * * 1-5");
    // 2026-11-23 is a Monday.
    expect(cronMatches(schedule, at("2026-11-23T06:00:00Z"))).toBe(true);
    expect(cronMatches(schedule, at("2026-11-23T06:20:00Z"))).toBe(true);
    expect(cronMatches(schedule, at("2026-11-23T18:40:00Z"))).toBe(true);
    expect(cronMatches(schedule, at("2026-11-23T06:10:00Z"))).toBe(false);
    expect(cronMatches(schedule, at("2026-11-23T12:00:00Z"))).toBe(false);
    // Sunday 2026-11-29.
    expect(cronMatches(schedule, at("2026-11-29T06:00:00Z"))).toBe(false);
  });

  // #1140-T01
  it("takes a step from a start without an end: 5/20 is 5, 25, 45", () => {
    const schedule = parsed("5/20 * * * *");
    const minutes = [0, 5, 25, 45, 46].map((minute) =>
      cronMatches(schedule, new Date(Date.UTC(2026, 10, 29, 6, minute))),
    );
    expect(minutes).toEqual([false, true, true, true, false]);
  });

  // #1140-T01
  it("matches the day of month AND the month", () => {
    const schedule = parsed("0 0 1 1 *");
    expect(cronMatches(schedule, at("2027-01-01T00:00:00Z"))).toBe(true);
    expect(cronMatches(schedule, at("2026-12-01T00:00:00Z"))).toBe(false);
  });

  // #1140-T01
  it("matches day of month OR day of week when both are restricted (the cron rule)", () => {
    // The 1st of a month, or any Monday.
    const schedule = parsed("0 0 1 * 1");
    expect(cronMatches(schedule, at("2026-12-01T00:00:00Z"))).toBe(true); // Tuesday the 1st
    expect(cronMatches(schedule, at("2026-11-23T00:00:00Z"))).toBe(true); // Monday the 23rd
    expect(cronMatches(schedule, at("2026-11-24T00:00:00Z"))).toBe(false); // Tuesday the 24th
  });

  // #1140-T01
  it("keeps the other one as a filter when only one of them is restricted", () => {
    expect(cronMatches(parsed("0 0 15 * *"), at("2026-11-15T00:00:00Z"))).toBe(
      true,
    );
    expect(cronMatches(parsed("0 0 15 * *"), at("2026-11-16T00:00:00Z"))).toBe(
      false,
    );
    expect(cronMatches(parsed("0 0 * * 1"), at("2026-11-23T00:00:00Z"))).toBe(
      true,
    );
    expect(cronMatches(parsed("0 0 * * 1"), at("2026-11-24T00:00:00Z"))).toBe(
      false,
    );
  });

  // #1140-T01
  it("handles a leap day", () => {
    const schedule = parsed("0 0 29 2 *");
    expect(cronMatches(schedule, at("2028-02-29T00:00:00Z"))).toBe(true);
    expect(cronMatches(schedule, at("2027-03-01T00:00:00Z"))).toBe(false);
  });

  // #1140-T01
  it("ignores the seconds of the date", () => {
    expect(
      cronMatches(parsed("0 6 * * *"), at("2026-11-29T06:00:42.500Z")),
    ).toBe(true);
  });
});

describe("latestOccurrence", () => {
  const sunday = parsed("0 6 * * 0");

  // #1140-T02
  it("finds the occurrence of the tick's own minute", () => {
    expect(
      latestOccurrence(sunday, {
        atOrBefore: at("2026-11-29T06:00:00Z"),
        notBefore: at("2026-11-28T06:00:00Z"),
      }),
    ).toEqual(at("2026-11-29T06:00:00Z"));
  });

  // #1140-T02
  it("finds the most recent one before the tick", () => {
    expect(
      latestOccurrence(sunday, {
        atOrBefore: at("2026-11-29T07:00:00Z"),
        notBefore: at("2026-11-28T07:00:00Z"),
      }),
    ).toEqual(at("2026-11-29T06:00:00Z"));
  });

  // #1140-T02
  it("returns the latest of several in the span, never an earlier one", () => {
    expect(
      latestOccurrence(parsed("0 * * * *"), {
        atOrBefore: at("2026-11-29T07:30:00Z"),
        notBefore: at("2026-11-29T00:00:00Z"),
      }),
    ).toEqual(at("2026-11-29T07:00:00Z"));
  });

  // #1140-T02
  it("is undefined when none lies in the span", () => {
    expect(
      latestOccurrence(sunday, {
        atOrBefore: at("2026-11-30T06:00:00Z"),
        notBefore: at("2026-11-29T06:30:00Z"),
      }),
    ).toBeUndefined();
  });

  // #1140-T02
  it("takes the start of the span as included", () => {
    expect(
      latestOccurrence(sunday, {
        atOrBefore: at("2026-11-29T09:00:00Z"),
        notBefore: at("2026-11-29T06:00:00Z"),
      }),
    ).toEqual(at("2026-11-29T06:00:00Z"));
  });

  // #1140-T02
  it("is undefined for an empty or reversed span", () => {
    expect(
      latestOccurrence(sunday, {
        atOrBefore: at("2026-11-22T06:00:00Z"),
        notBefore: at("2026-11-29T06:00:00Z"),
      }),
    ).toBeUndefined();
  });

  // #1140-T02
  it("finds a leap-day occurrence a year back", () => {
    expect(
      latestOccurrence(parsed("0 0 29 2 *"), {
        atOrBefore: at("2029-01-01T00:00:00Z"),
        notBefore: at("2028-01-01T00:00:00Z"),
      }),
    ).toEqual(at("2028-02-29T00:00:00Z"));
  });
});
