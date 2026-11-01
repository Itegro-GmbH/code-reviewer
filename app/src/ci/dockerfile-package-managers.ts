// SPDX-License-Identifier: LicenseRef-Proprietary

// What the Dockerfile tests of the Worker image use to keep package managers out of its build (#202, #761).
// The image carries Node.js with npm and pnpm for the Implementer's agent, so a Dockerfile may name them (in
// a link, a path); what it must not do is RUN one: every package manager command fetches from a registry
// at a version nobody pinned (`npx pkg`, `npm update`, `pnpm up`, `pnpm fetch`, `corepack prepare`, ...).
// Not a list of forbidden subcommands, which is always one short: no RUN instruction runs any of them.

const MANAGERS = new Set(["npm", "npx", "pnpm", "pnpx", "corepack", "yarn"]);
// The files those commands are links to; `node <file>` runs them as well.
const MANAGER_FILES = new Set([
  "npm-cli.js",
  "npx-cli.js",
  "pnpm.cjs",
  "pnpx.cjs",
  "corepack.js",
]);
// Words in front of the command that run it: `env CI=1 npm i`, `xargs npm i`, `node npm-cli.js i`.
const WRAPPERS = new Set([
  "env",
  "exec",
  "command",
  "time",
  "nice",
  "xargs",
  "sudo",
  "node",
  "nodejs",
  "sh",
  "bash",
  "dash",
]);

/**
 * The exact RUN instructions (continued lines joined, spaces squeezed) that may run a package manager.
 * None: the image only needs the managers to be there, and the smoke test runs their version checks.
 */
export const ALLOWED_PACKAGE_MANAGER_RUNS: readonly string[] = [];

/** The RUN instructions of a Dockerfile, continued lines joined, spaces squeezed. */
export function runInstructions(source: string): string[] {
  return source
    .replace(/\\\n/g, " ")
    .split("\n")
    .map((line) => line.trim().replace(/\s+/g, " "))
    .filter((line) => line.startsWith("RUN "));
}

function words(text: string): string[] {
  return text.split(/[\s"'`()<>{}]+/).filter((word) => word !== "");
}

// Words after which a command follows: `find -exec npm i {} \;`, `sh -c "npm i"`.
const LAUNCHERS = new Set(["-exec", "-execdir", "-c"]);

/** Whether a RUN instruction runs npm, npx, pnpm, pnpx, corepack or yarn, however it is wrapped. */
export function runsPackageManager(run: string): boolean {
  const body = run.slice("RUN ".length);
  // Commands are split at && || ; | wherever they stand (also inside `sh -c "..."`, whose quotes are
  // dropped), and a command is its first real word: after variable assignments, wrappers and their flags,
  // or after -exec / -c. A name that only is an argument (`--component pnpm`) is no run; a link to the
  // executable (`ln -s .../npm-cli.js /usr/local/bin/npm`) is not run either.
  return body.split(/&&|\|\||[;|]/).some((command) => {
    let expectCommand = true;
    for (const word of words(command)) {
      if (LAUNCHERS.has(word)) expectCommand = true;
      else if (!expectCommand) continue;
      else if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word) || WRAPPERS.has(word))
        continue;
      else if (word.startsWith("-")) continue;
      else {
        const name = word.split("/").at(-1) ?? "";
        if (MANAGERS.has(name) || MANAGER_FILES.has(name)) return true;
        expectCommand = false;
      }
    }
    return false;
  });
}

/** The RUN instructions that run a package manager and are not on the allowed list. */
export function packageManagerRuns(source: string): string[] {
  return runInstructions(source).filter(
    (run) =>
      !ALLOWED_PACKAGE_MANAGER_RUNS.includes(run) && runsPackageManager(run),
  );
}
