// SPDX-License-Identifier: LicenseRef-Proprietary

// The preflight of the privileged Dynamic e2e lane (#253): the first thing the lane does, before it
// starts a server, a runner or a browser. The lane needs a root supervisor, the pinned OpenCode and `rg`
// where the Dynamic image has them, `nft`, and the engine user; when one is missing it stops, says which
// one, and never goes on without it. Nothing is skipped silently. All missing items are listed at once, so
// a CI run does not have to be repeated once per item.
//
//   node app/e2e/helpers/dynamic-preflight-command.ts
//
// The check itself (`checkLane`) works on injected facts; `collectFacts` reads them from the machine. The
// command exits 0 when the lane can run and 1 with one line per missing item on stderr otherwise. It only
// uses Node's own modules, so Node runs it as it is (no build step, like the fakes).
import { spawnSync } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";

/** What the Dynamic image installs, and what the runner's startup self-check reads (`DEFAULT_TOOLS`). */
export const OPENCODE_PATH = "/usr/local/bin/opencode";
export const RIPGREP_PATH = "/usr/local/bin/rg";
/** The dedicated engine user of the image: uid and gid 10101. */
export const ENGINE_UID = 10101;
/** What the Implementer's image adds (#761): git 2.53 or newer first on the runner's trusted path, and the guard files. */
export const GIT_PATH = "/usr/local/bin/git";
export const MIN_GIT_VERSION = [2, 53] as const;
export const GUARD_DIR = "/opt/code-reviewer/guard";
export const GUARD_FILES = [
  "reference-transaction",
  "guard_matrix.sh",
] as const;

/** The stable names of the things the lane needs; a failure names them. */
export const LANE_ITEMS = [
  "opencode_binary",
  "ripgrep",
  "nft",
  "engine_user",
  "root",
  "git",
  "guard_files",
] as const;
export type LaneItem = (typeof LANE_ITEMS)[number];

export type LaneFacts = {
  /** The effective user id of this process. */
  uid: number;
  opencode: { path: string; executable: boolean };
  ripgrep: { path: string; executable: boolean };
  /** Whether `nft list ruleset` works: the binary, the kernel module and `NET_ADMIN` in one. */
  nft: { usable: boolean; detail: string };
  /** The uid of the engine user the lane looks for, and the user with its primary group (null: none). */
  engineUid: number;
  engineUser: { uid: number; gid: number } | null;
  /** The output of `git --version` at `path`, or null when it cannot be run. */
  git: { path: string; version: string | null };
  /** The guard files of the Implementer's image that are not executable files. */
  guard: { dir: string; missing: string[] };
};

export type Missing = { item: LaneItem; message: string };

export function checkLane(facts: LaneFacts): Missing[] {
  const missing: Missing[] = [];
  if (!facts.opencode.executable)
    missing.push({
      item: "opencode_binary",
      message: `The pinned OpenCode is not an executable file at ${facts.opencode.path}. Fetch it with "uv run python scripts/fetch_opencode.py" in runner/ and let the lane install it there (the Dynamic image has it at that path, and the runner's self-check reads it there).`,
    });
  if (!facts.ripgrep.executable)
    missing.push({
      item: "ripgrep",
      message: `rg is not an executable file at ${facts.ripgrep.path}. Fetch the pinned one with "uv run python scripts/fetch_ripgrep.py" in runner/ and let the lane install it there; the engine's grep and glob need it.`,
    });
  if (!facts.nft.usable)
    missing.push({
      item: "nft",
      message: `nft cannot list the ruleset (${facts.nft.detail || "no detail"}). The lane installs the engine user's network rules and the network guard with it: it needs the nftables package, the nf_tables kernel module and NET_ADMIN.`,
    });
  const user = facts.engineUser;
  if (user === null || user.gid !== user.uid)
    missing.push({
      item: "engine_user",
      message:
        user === null
          ? `The engine user ${String(facts.engineUid)} does not exist. The Dynamic image has it with its own group ${String(facts.engineUid)}; the lane adds it to the passwd and group files of its mount namespace.`
          : `The engine user ${String(user.uid)} has the group ${String(user.gid)}, not a group of its own: the runner's self-check refuses it.`,
    });
  const gitVersion = parseGitVersion(facts.git.version);
  if (gitVersion === null || !atLeast(gitVersion, MIN_GIT_VERSION))
    missing.push({
      item: "git",
      message: `git ${MIN_GIT_VERSION.join(".")} or newer is not at ${facts.git.path} (${facts.git.version ?? "it cannot be run"}). The Implementer's branch guard is blind to a switch of branch on older git, so the Worker refuses to advertise the kind. The lane builds the pinned release ("scripts/build_lane_git.sh" in runner/) and installs it there.`,
    });
  if (facts.guard.missing.length > 0)
    missing.push({
      item: "guard_files",
      message: `The guard files of the Implementer (${facts.guard.missing.join(", ")}) are not executable files in ${facts.guard.dir}. The lane installs runner/guard/reference-transaction and runner/scripts/guard_matrix.sh there, root-owned, as the image does.`,
    });
  if (facts.uid !== 0)
    missing.push({
      item: "root",
      message: `The lane does not run as root (uid ${String(facts.uid)}). The runner is the root supervisor of the Dynamic image, and nft and the user switch need it: start the lane with scripts/run_dynamic_e2e.sh, which uses sudo.`,
    });
  return missing;
}

/** The text a failing preflight prints: one line per missing item, the item first. */
export function describeMissing(missing: readonly Missing[]): string {
  const lines = missing.map((item) => `- ${item.item}: ${item.message}`);
  return [
    `The Dynamic e2e lane cannot run: ${String(missing.length)} thing${missing.length === 1 ? " is" : "s are"} missing.`,
    ...lines,
  ].join("\n");
}

function parseGitVersion(text: string | null): number[] | null {
  const found = /git version (\d+(?:\.\d+)*)/.exec(text ?? "");
  return found?.[1] === undefined ? null : found[1].split(".").map(Number);
}

function atLeast(version: number[], minimum: readonly number[]): boolean {
  for (const [index, wanted] of minimum.entries()) {
    const got = version[index] ?? 0;
    if (got !== wanted) return got > wanted;
  }
  return true;
}

export type LaneProbes = {
  uid(): number;
  isExecutable(path: string): boolean;
  /** Runs a command with no shell; `ok` is a zero exit status. */
  run(command: string, args: string[]): { ok: boolean; output: string };
};

export const machineProbes: LaneProbes = {
  uid: () => process.geteuid?.() ?? -1,
  isExecutable(path) {
    try {
      accessSync(path, constants.X_OK);
      return statSync(path).isFile();
    } catch {
      return false;
    }
  },
  run(command, args) {
    const done = spawnSync(command, args, {
      encoding: "utf8",
      timeout: 30_000,
    });
    if (done.error) return { ok: false, output: done.error.message };
    return {
      ok: done.status === 0,
      output: `${done.stdout}${done.stderr}`.trim(),
    };
  },
};

/** The overrides the command accepts (for tests of the command; the lane sets none). */
export type LaneEnvironment = {
  LANE_OPENCODE_PATH?: string | undefined;
  LANE_RIPGREP_PATH?: string | undefined;
  LANE_ENGINE_UID?: string | undefined;
  LANE_GIT_PATH?: string | undefined;
  LANE_GUARD_DIR?: string | undefined;
};

export function collectFacts(
  environment: LaneEnvironment,
  probes: LaneProbes = machineProbes,
): LaneFacts {
  const opencode = environment.LANE_OPENCODE_PATH || OPENCODE_PATH;
  const ripgrep = environment.LANE_RIPGREP_PATH || RIPGREP_PATH;
  const engineUid = Number(environment.LANE_ENGINE_UID || ENGINE_UID);
  const nft = probes.run("nft", ["list", "ruleset"]);
  const passwd = probes.run("getent", ["passwd", String(engineUid)]);
  // name:password:uid:gid:gecos:home:shell
  const fields = passwd.ok
    ? passwd.output.split("\n")[0]?.split(":")
    : undefined;
  const engineUser =
    fields !== undefined && Number(fields[2]) === engineUid
      ? { uid: engineUid, gid: Number(fields[3]) }
      : null;
  const git = environment.LANE_GIT_PATH || GIT_PATH;
  const gitRun = probes.run(git, ["--version"]);
  const guardDir = environment.LANE_GUARD_DIR || GUARD_DIR;
  return {
    git: { path: git, version: gitRun.ok ? gitRun.output : null },
    guard: {
      dir: guardDir,
      missing: GUARD_FILES.filter(
        (name) => !probes.isExecutable(`${guardDir}/${name}`),
      ),
    },
    uid: probes.uid(),
    opencode: { path: opencode, executable: probes.isExecutable(opencode) },
    ripgrep: { path: ripgrep, executable: probes.isExecutable(ripgrep) },
    nft: { usable: nft.ok, detail: nft.ok ? "" : nft.output },
    engineUid,
    engineUser,
  };
}

/** Runs the preflight on this machine; returns the exit status of the command. */
export function runPreflight(
  environment: LaneEnvironment,
  probes: LaneProbes = machineProbes,
  fail: (text: string) => void = (text) => process.stderr.write(`${text}\n`),
): number {
  const missing = checkLane(collectFacts(environment, probes));
  if (missing.length === 0) return 0;
  fail(describeMissing(missing));
  return 1;
}
