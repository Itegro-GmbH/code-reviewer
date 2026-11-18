// SPDX-License-Identifier: LicenseRef-Proprietary

// #166-T02: `app/src/app/theme.css` is the one place with the app's colors. This test parses it:
// every token exists for light and for dark, the "system" state (prefers-color-scheme) and the
// explicit dark choice carry the same values, and the documented color pairs meet the WCAG 2.1
// contrast (body text 4.5:1, non-text 3:1) that the palette was checked against.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { contrastRatio, declarationBlock, resolveToken } from "./tokens.ts";

const css = readFileSync(
  fileURLToPath(new URL("../../app/theme.css", import.meta.url)),
  "utf8",
);
const light = declarationBlock(css, ":root");
const systemDark = declarationBlock(css, ":root:not([data-theme])");
const explicitDark = declarationBlock(css, ':root[data-theme="dark"]');

// Every color token the theme must carry (the shadcn set plus the status, sidebar and chart sets).
const TOKENS = [
  "background",
  "foreground",
  "card",
  "card-foreground",
  "popover",
  "popover-foreground",
  "primary",
  "primary-foreground",
  "primary-hover",
  "secondary",
  "secondary-foreground",
  "muted",
  "muted-foreground",
  "accent",
  "accent-foreground",
  "destructive",
  "destructive-foreground",
  "border",
  "input",
  "ring",
  "success",
  "success-foreground",
  "success-soft",
  "warning",
  "warning-foreground",
  "warning-soft",
  "danger",
  "danger-soft",
  "info",
  "info-foreground",
  "info-soft",
  "flow-done",
  "flow-done-soft",
  "flow-running",
  "flow-running-soft",
  "flow-waiting",
  "flow-waiting-soft",
  "flow-failed",
  "flow-failed-soft",
  "chart-1",
  "chart-2",
  "chart-3",
  "chart-4",
  "chart-5",
  "sidebar",
  "sidebar-foreground",
  "sidebar-primary",
  "sidebar-primary-foreground",
  "sidebar-accent",
  "sidebar-accent-foreground",
  "sidebar-border",
  "sidebar-ring",
].map((name) => `--${name}`);

// The app design board (docs/design/index.html, #633) is the source of the palette: its light `:root`
// and its explicit dark block carry the tokens (`muted` there is the supporting text, `fg-muted` here).
const board = readFileSync(
  fileURLToPath(new URL("../../../../docs/design/index.html", import.meta.url)),
  "utf8",
);
function boardBlock(selector: string): Record<string, string> {
  const start = board.indexOf(`${selector}{`);
  if (start === -1) throw new Error(`no board block for ${selector}`);
  const body = board.slice(
    start + selector.length + 1,
    board.indexOf("}", start),
  );
  return Object.fromEntries(
    [...body.matchAll(/(--[a-z-]+):(#[0-9a-f]{6})/gi)].map((m) => [
      m[1]!,
      m[2]!,
    ]),
  );
}
const boardLight = boardBlock(":root");
const boardDark = boardBlock(':root[data-theme="dark"]');
const BOARD_TOKENS = Object.keys(boardDark).map((name) => [
  name,
  name === "--muted" ? "--fg-muted" : name,
]);

// [foreground token, background token, minimum ratio] - text pairs 4.5, non-text 3.
const CONTRAST_PAIRS: [string, string, number][] = [
  ["--foreground", "--background", 4.5],
  ["--card-foreground", "--card", 4.5],
  ["--popover-foreground", "--popover", 4.5],
  ["--primary", "--background", 4.5],
  ["--muted-foreground", "--background", 4.5],
  ["--primary-foreground", "--primary", 4.5],
  ["--secondary-foreground", "--secondary", 4.5],
  ["--accent-foreground", "--accent", 4.5],
  ["--destructive-foreground", "--destructive", 4.5],
  ["--success", "--success-soft", 4.5],
  ["--warning", "--warning-soft", 4.5],
  ["--danger", "--danger-soft", 4.5],
  ["--info", "--info-soft", 4.5],
  // #1079: the states of a node of a lane run, on their own ground and on the page.
  ["--flow-done", "--flow-done-soft", 4.5],
  ["--flow-running", "--flow-running-soft", 4.5],
  ["--flow-waiting", "--flow-waiting-soft", 4.5],
  ["--flow-failed", "--flow-failed-soft", 4.5],
  ["--flow-done", "--background", 4.5],
  ["--flow-running", "--background", 4.5],
  ["--flow-waiting", "--background", 4.5],
  ["--flow-failed", "--background", 4.5],
  ["--input", "--background", 3],
  ["--ring", "--background", 3],
  // #633: supporting text and the warning marker on every ground of the board.
  ["--muted-foreground", "--card", 4.5],
  ["--muted-foreground", "--muted", 4.5],
  ["--muted-foreground", "--warm", 4.5],
  ["--primary-foreground", "--primary-hover", 4.5],
  ["--ring", "--card", 3],
  ["--input", "--card", 3],
];

describe("theme.css tokens", () => {
  // #166-T02
  it("defines every token for the light and the dark state", () => {
    expect(TOKENS.filter((token) => !(token in light))).toEqual([]);
    expect(TOKENS.filter((token) => !(token in explicitDark))).toEqual([]);
  });

  // #633-T01
  it("reads the colour tokens of the design board", () => {
    expect(BOARD_TOKENS.length).toBeGreaterThanOrEqual(13);
  });

  // #633-T01
  it.each(BOARD_TOKENS)(
    "carries the board token %s as %s in light and dark",
    (boardName, appName) => {
      expect(resolveToken(light, appName!)).toBe(boardLight[boardName!]);
      expect(resolveToken(explicitDark, appName!)).toBe(boardDark[boardName!]);
      expect(resolveToken(systemDark, appName!)).toBe(boardDark[boardName!]);
    },
  );

  // #166-T02
  it("gives the system state the same values as the explicit dark choice", () => {
    expect(systemDark).toEqual(explicitDark);
  });

  // #166-T02
  it.each(CONTRAST_PAIRS)(
    "meets the contrast of %s on %s (light and dark)",
    (foreground, background, minimum) => {
      for (const tokens of [light, explicitDark]) {
        const ratio = contrastRatio(
          resolveToken(tokens, foreground),
          resolveToken(tokens, background),
        );
        expect(ratio, `${foreground} on ${background}`).toBeGreaterThanOrEqual(
          minimum,
        );
      }
    },
  );
});
