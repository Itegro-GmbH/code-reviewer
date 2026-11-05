// SPDX-License-Identifier: LicenseRef-Proprietary

// The version of the base a runner provides (#854), as `1.4.0` or `1.4.0-rc1`. The app may require a minimum: a runner below it gets
// no jobs and the reason "update needed". Pure.
import { BASE_VERSION_PATTERN } from "./announcement.ts";

type Parsed = {
  numbers: [number, number, number];
  prerelease: string | undefined;
};

function parse(version: string): Parsed | undefined {
  if (!BASE_VERSION_PATTERN.test(version)) return undefined;
  const [core, ...rest] = version.split("-");
  const numbers = (core ?? "").split(".").map(Number) as [
    number,
    number,
    number,
  ];
  return {
    numbers,
    prerelease: rest.length > 0 ? rest.join("-") : undefined,
  };
}

/**
 * Whether `version` is at least `minimum`. A pre-release (`1.4.0-rc1`) is below its release (`1.4.0`) and above every smaller one; two
 * pre-releases of the same release compare by their tags, in plain character order (`rc1` < `rc2`). A
 * version that is not of the form, on either side, is not enough: a runner that cannot say what it is does not get jobs.
 */
export function meetsMinimum(version: string, minimum: string): boolean {
  const have = parse(version);
  const need = parse(minimum);
  if (have === undefined || need === undefined) return false;
  for (const index of [0, 1, 2] as const) {
    const a = have.numbers[index];
    const b = need.numbers[index];
    if (a !== b) return a > b;
  }
  if (have.prerelease === undefined) return true;
  if (need.prerelease === undefined) return false;
  return have.prerelease >= need.prerelease;
}
