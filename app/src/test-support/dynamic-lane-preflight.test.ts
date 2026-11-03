// SPDX-License-Identifier: LicenseRef-Proprietary

// Pins down the preflight of the privileged Dynamic e2e lane (#253): before anything of the lane starts,
// the pinned OpenCode binary, `rg`, `nft`, the engine user and root are checked, and a missing item
// fails the lane loudly and by name. The facts are injected, so every item is proven without root.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  checkLane,
  collectFacts,
  describeMissing,
  ENGINE_UID,
  GIT_PATH,
  LANE_ITEMS,
  OPENCODE_PATH,
  RIPGREP_PATH,
  type LaneFacts,
  type LaneProbes,
} from "../../e2e/helpers/dynamic-preflight.ts";

const GOOD: LaneFacts = {
  uid: 0,
  opencode: { path: OPENCODE_PATH, executable: true },
  ripgrep: { path: RIPGREP_PATH, executable: true },
  nft: { usable: true, detail: "" },
  engineUid: ENGINE_UID,
  engineUser: { uid: ENGINE_UID, gid: ENGINE_UID },
  git: { path: GIT_PATH, version: "git version 2.53.0" },
};

const PREFLIGHT = fileURLToPath(
  new URL("../../e2e/helpers/dynamic-preflight-command.ts", import.meta.url),
);

describe("the preflight of the privileged Dynamic e2e lane", () => {
  // #253-P00
  it("passes when everything the lane needs is there", () => {
    expect(checkLane(GOOD)).toEqual([]);
  });

  // #253-P01
  it("names the OpenCode binary when it is missing and says how to get the pinned one", () => {
    const missing = checkLane({
      ...GOOD,
      opencode: { path: OPENCODE_PATH, executable: false },
    });

    expect(missing.map((item) => item.item)).toEqual(["opencode_binary"]);
    expect(missing[0]?.message).toContain(OPENCODE_PATH);
    expect(missing[0]?.message).toContain("fetch_opencode.py");
  });

  // #253-P02
  it("names rg when it is missing", () => {
    const missing = checkLane({
      ...GOOD,
      ripgrep: { path: RIPGREP_PATH, executable: false },
    });

    expect(missing.map((item) => item.item)).toEqual(["ripgrep"]);
    expect(missing[0]?.message).toContain(RIPGREP_PATH);
    expect(missing[0]?.message).toContain("fetch_ripgrep.py");
  });

  // #253-P03
  it("names nft when it cannot be used and says why", () => {
    const missing = checkLane({
      ...GOOD,
      nft: { usable: false, detail: "nft: command not found" },
    });

    expect(missing.map((item) => item.item)).toEqual(["nft"]);
    expect(missing[0]?.message).toContain("nft: command not found");
  });

  // #253-P04
  it("names the engine user when it does not exist", () => {
    const missing = checkLane({ ...GOOD, engineUser: null });

    expect(missing.map((item) => item.item)).toEqual(["engine_user"]);
    expect(missing[0]?.message).toContain(String(ENGINE_UID));
  });

  // #253-P04
  it("names the engine user when its group is not its own", () => {
    const missing = checkLane({
      ...GOOD,
      engineUser: { uid: ENGINE_UID, gid: 100 },
    });

    expect(missing.map((item) => item.item)).toEqual(["engine_user"]);
  });

  // #253-P05
  it("names root when the lane does not run as root", () => {
    const missing = checkLane({ ...GOOD, uid: 1001 });

    expect(missing.map((item) => item.item)).toEqual(["root"]);
    expect(missing[0]?.message).toContain("1001");
  });

  // #767
  it("names git when it cannot be run, and accepts any version that runs", () => {
    const none = checkLane({ ...GOOD, git: { path: GIT_PATH, version: null } });
    const old = checkLane({
      ...GOOD,
      git: { path: GIT_PATH, version: "git version 2.43.0" },
    });

    expect(none.map((item) => item.item)).toEqual(["git"]);
    expect(old).toEqual([]);
  });

  // #253-P06
  it("lists every missing item at once, not only the first", () => {
    const missing = checkLane({
      uid: 1001,
      opencode: { path: OPENCODE_PATH, executable: false },
      ripgrep: { path: RIPGREP_PATH, executable: false },
      nft: { usable: false, detail: "" },
      engineUid: ENGINE_UID,
      engineUser: null,
      git: { path: GIT_PATH, version: null },
    });

    expect(missing.map((item) => item.item).sort()).toEqual(
      [...LANE_ITEMS].sort(),
    );
    const text = describeMissing(missing);
    for (const item of LANE_ITEMS) expect(text).toContain(item);
  });

  // #253-P07
  it("collects its facts from the probes of the machine", () => {
    const asked: string[] = [];
    const probes: LaneProbes = {
      uid: () => 0,
      isExecutable: (path) => {
        asked.push(path);
        return path === OPENCODE_PATH;
      },
      run: (command, args) => {
        asked.push([command, ...args].join(" "));
        if (command === "nft") return { ok: true, output: "" };
        if (command === GIT_PATH)
          return { ok: true, output: "git version 2.53.0" };
        return {
          ok: true,
          output: "cr-engine:x:10101:10101::/nonexistent:/sbin/nologin\n",
        };
      },
    };

    const facts = collectFacts({}, probes);

    expect(facts.git).toEqual({
      path: GIT_PATH,
      version: "git version 2.53.0",
    });
    expect(facts.uid).toBe(0);
    expect(facts.opencode.executable).toBe(true);
    expect(facts.ripgrep.executable).toBe(false);
    expect(facts.nft.usable).toBe(true);
    expect(facts.engineUser).toEqual({ uid: 10101, gid: 10101 });
    expect(facts.engineUid).toBe(10101);
    expect(asked).toContain(`${GIT_PATH} --version`);
    expect(asked).toContain("nft list ruleset");
    expect(asked).toContain("getent passwd 10101");
  });

  // #253-P07
  it("treats a machine whose probes fail as missing, never as present", () => {
    const probes: LaneProbes = {
      uid: () => 1000,
      isExecutable: () => false,
      run: () => ({ ok: false, output: "boom" }),
    };

    const missing = checkLane(collectFacts({}, probes));

    expect(missing.map((item) => item.item).sort()).toEqual(
      [...LANE_ITEMS].sort(),
    );
  });

  // #253-P08
  it("fails the command loudly: a non-zero exit and one line per missing item on stderr", () => {
    const environment: Record<string, string> = {
      NODE_OPTIONS: "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON",
      PATH: "/nonexistent",
      LANE_OPENCODE_PATH: "/nonexistent/opencode",
      LANE_RIPGREP_PATH: "/nonexistent/rg",
      LANE_ENGINE_UID: "4242",
      LANE_GIT_PATH: "/nonexistent/git",
    };
    const done = spawnSync(process.execPath, [PREFLIGHT], {
      encoding: "utf8",
      // Next's types make NODE_ENV a required variable; the command does not read it.
      env: environment as NodeJS.ProcessEnv,
    });

    expect(done.status).not.toBe(0);
    expect(done.stdout).toBe("");
    for (const item of [
      "opencode_binary",
      "ripgrep",
      "nft",
      "engine_user",
      "git",
    ] as const)
      expect(done.stderr, item).toContain(item);
    expect(done.stderr).toContain("/nonexistent/opencode");
    expect(done.stderr).toContain("4242");
  });
});
