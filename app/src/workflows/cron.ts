// SPDX-License-Identifier: LicenseRef-Proprietary

// The cron expression of a `schedule` trigger (#916, started by #1140): five fields separated by one space, evaluated in UTC.
//
//   minute (0-59)  hour (0-23)  day of month (1-31)  month (1-12)  day of week (0-7, 0 and 7 are Sunday)
//
// Each field is a list of items separated by commas; an item is `*`, a number `n`, a range `a-b`, and each of those but a plain number may
// be followed by a step `/s` (`*/15`, `10-40/10`; `5/20` runs from 5 to the end of the field in steps of 20). Names (`MON`, `JAN`), `?`,
// `L`, `W`, `#` and seconds are not part of the format. When both the day of month and the day of week are restricted a day matches if
// EITHER does (the rule of the classic cron); when only one is, the other is no filter.
//
// A small local reader instead of a dependency: it is the whole feature, a library would bring time zones and dialects the format
// does not have. Pure, no clock, no I/O.

type Field = { min: number; max: number };

const MINUTE: Field = { min: 0, max: 59 };
const HOUR: Field = { min: 0, max: 23 };
const DAY_OF_MONTH: Field = { min: 1, max: 31 };
const MONTH: Field = { min: 1, max: 12 };
// 7 is read as 0 (Sunday).
const DAY_OF_WEEK: Field = { min: 0, max: 7 };

const NUMBER = /^\d{1,2}$/;

/** A cron expression as the sets of the values each field matches. */
export type CronSchedule = {
  minutes: ReadonlySet<number>;
  hours: ReadonlySet<number>;
  daysOfMonth: ReadonlySet<number>;
  months: ReadonlySet<number>;
  /** 0 to 6, Sunday is 0. */
  daysOfWeek: ReadonlySet<number>;
  /** Whether the field is not `*`: the day rule needs to know. */
  dayOfMonthRestricted: boolean;
  dayOfWeekRestricted: boolean;
};

const MINUTE_MS = 60_000;

/** Reads one number of a field; undefined when it is no number or lies outside the field. */
function numberIn(text: string, field: Field): number | undefined {
  if (!NUMBER.test(text)) return undefined;
  const value = Number(text);
  return value >= field.min && value <= field.max ? value : undefined;
}

/** The values one item (`*`, `n`, `a-b`, each with an optional `/s`) stands for; undefined when it is not valid. */
function itemValues(item: string, field: Field): number[] | undefined {
  const parts = item.split("/");
  if (parts.length > 2) return undefined;
  const [range = "", stepText] = parts;
  let step = 1;
  if (stepText !== undefined) {
    if (!NUMBER.test(stepText)) return undefined;
    step = Number(stepText);
    if (step < 1) return undefined;
  }
  let from: number | undefined;
  let to: number | undefined;
  if (range === "*") {
    from = field.min;
    to = field.max;
  } else if (range.includes("-")) {
    const bounds = range.split("-");
    if (bounds.length !== 2) return undefined;
    from = numberIn(bounds[0] ?? "", field);
    to = numberIn(bounds[1] ?? "", field);
  } else {
    from = numberIn(range, field);
    // `5/20` runs to the end of the field; a plain `5` is that one value.
    to = stepText === undefined ? from : field.max;
  }
  if (from === undefined || to === undefined || from > to) return undefined;
  const values: number[] = [];
  for (let value = from; value <= to; value += step) values.push(value);
  return values;
}

function fieldValues(text: string, field: Field): Set<number> | undefined {
  const values = new Set<number>();
  for (const item of text.split(",")) {
    const found = itemValues(item, field);
    if (found === undefined) return undefined;
    for (const value of found) values.add(value);
  }
  return values;
}

/** The expression as sets of values, or undefined when it is not five valid fields separated by one space. */
export function parseCron(text: string): CronSchedule | undefined {
  const fields = text.split(" ");
  if (fields.length !== 5) return undefined;
  const [minute = "", hour = "", dayOfMonth = "", month = "", dayOfWeek = ""] =
    fields;
  const minutes = fieldValues(minute, MINUTE);
  const hours = fieldValues(hour, HOUR);
  const daysOfMonth = fieldValues(dayOfMonth, DAY_OF_MONTH);
  const months = fieldValues(month, MONTH);
  const weekdays = fieldValues(dayOfWeek, DAY_OF_WEEK);
  if (
    minutes === undefined ||
    hours === undefined ||
    daysOfMonth === undefined ||
    months === undefined ||
    weekdays === undefined
  )
    return undefined;
  return {
    minutes,
    hours,
    daysOfMonth,
    months,
    daysOfWeek: new Set([...weekdays].map((day) => day % 7)),
    dayOfMonthRestricted: !dayOfMonth.startsWith("*"),
    dayOfWeekRestricted: !dayOfWeek.startsWith("*"),
  };
}

/** Whether the minute of `at` (UTC; seconds are ignored) is one the expression names. */
export function cronMatches(schedule: CronSchedule, at: Date): boolean {
  if (
    !schedule.minutes.has(at.getUTCMinutes()) ||
    !schedule.hours.has(at.getUTCHours()) ||
    !schedule.months.has(at.getUTCMonth() + 1)
  )
    return false;
  const dayOfMonth = schedule.daysOfMonth.has(at.getUTCDate());
  const dayOfWeek = schedule.daysOfWeek.has(at.getUTCDay());
  return schedule.dayOfMonthRestricted && schedule.dayOfWeekRestricted
    ? dayOfMonth || dayOfWeek
    : dayOfMonth && dayOfWeek;
}

/** How far back a search goes at the most: a year, so a yearly schedule (a leap day too, when it was this year) is found, nothing older. */
const SEARCH_MAX_MS = 366 * 24 * 60 * MINUTE_MS;

/**
 * The latest minute the expression names in `[notBefore, atOrBefore]` (both included, `atOrBefore` taken down to its minute), or
 * undefined when there is none. The search goes back minute by minute, so its cost is the span: callers pass the span they care about.
 */
export function latestOccurrence(
  schedule: CronSchedule,
  span: { atOrBefore: Date; notBefore: Date },
): Date | undefined {
  const end = Math.floor(span.atOrBefore.getTime() / MINUTE_MS) * MINUTE_MS;
  const start = Math.max(span.notBefore.getTime(), end - SEARCH_MAX_MS);
  for (let at = end; at >= start; at -= MINUTE_MS) {
    const candidate = new Date(at);
    if (cronMatches(schedule, candidate)) return candidate;
  }
  return undefined;
}
