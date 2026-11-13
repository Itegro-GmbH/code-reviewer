// SPDX-License-Identifier: LicenseRef-Proprietary

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../snapshot/config.ts";
import {
  PATHS,
  daemonConfigJson,
  installDockerScript,
  installHostScriptsScript,
  installSysboxScript,
  probeScript,
  writeDaemonConfigScript,
} from "../snapshot/scripts.ts";
import { RECIPE_FILES, recipeFiles, writeRecipe } from "./recipe.ts";

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

const byName = (name: string): string => {
  const file = recipeFiles(DEFAULT_CONFIG).find((f) => f.name === name);
  if (!file) throw new Error(`no recipe file ${name}`);
  return file.content;
};

describe("the recipe the local root file system is built from", () => {
  // #976-T02
  it("is the golden snapshot's own install scripts, byte for byte", () => {
    expect(byName(RECIPE_FILES.installDocker)).toBe(
      installDockerScript(DEFAULT_CONFIG),
    );
    expect(byName(RECIPE_FILES.installSysbox)).toBe(
      installSysboxScript(DEFAULT_CONFIG),
    );
    expect(byName(RECIPE_FILES.daemonJson)).toBe(daemonConfigJson());
    expect(byName(RECIPE_FILES.writeDaemonConfig)).toBe(
      writeDaemonConfigScript(),
    );
    expect(byName(RECIPE_FILES.installHostScripts)).toBe(
      installHostScriptsScript(),
    );
  });

  // #976-T02
  it("hands the pinned versions and the Sysbox checksum to the build as data, from the same configuration", () => {
    const recipe = JSON.parse(byName(RECIPE_FILES.recipe)) as Record<
      string,
      unknown
    >;

    expect(recipe).toMatchObject({
      dockerVersion: DEFAULT_CONFIG.dockerVersion,
      buildxVersion: DEFAULT_CONFIG.buildxVersion,
      sysboxVersion: DEFAULT_CONFIG.sysboxVersion,
      sysboxSha256: DEFAULT_CONFIG.sysboxSha256,
      dockerfile: DEFAULT_CONFIG.dockerfile,
      worker: { target: DEFAULT_CONFIG.target, tag: DEFAULT_CONFIG.imageTag },
      agent: {
        target: DEFAULT_CONFIG.agentTarget,
        tag: DEFAULT_CONFIG.agentImageTag,
      },
      paths: {
        daemonJson: PATHS.daemonJson,
        vmPrepare: PATHS.vmPrepare,
        sysboxPrepare: PATHS.sysboxPrepare,
      },
    });
  });

  // #976-T02
  it("carries the golden snapshot's Worker self-check as a script the smoke boot runs", () => {
    expect(byName(RECIPE_FILES.workerProbe)).toBe(probeScript(DEFAULT_CONFIG));
  });

  it("writes executable scripts and a readable data file, and stops on any error", () => {
    dir = mkdtempSync(join(tmpdir(), "recipe-"));
    writeRecipe(dir, DEFAULT_CONFIG);

    for (const file of recipeFiles(DEFAULT_CONFIG)) {
      const path = join(dir, file.name);
      expect(readFileSync(path, "utf8")).toBe(file.content);
      if (file.name.endsWith(".sh")) {
        expect(statSync(path).mode & 0o111, file.name).not.toBe(0);
        expect(file.content).toContain("set -euo pipefail");
        // Parses as bash: the scripts are text from a template, so a syntax slip would only show in a build.
        const check = spawnSync("bash", ["-n", path]);
        expect(check.status, file.name).toBe(0);
      }
    }
  });
});
