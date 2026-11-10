// SPDX-License-Identifier: LicenseRef-Proprietary

// One recipe, two outputs (#976): the golden snapshot pipeline (dispatcher/src/snapshot) installs Docker and Sysbox, writes the daemon's
// configuration and installs the two prepare scripts by running the scripts of `scripts.ts` in a Vercel Sandbox VM. The local root file
// system is built by running the same scripts, unchanged, in a chroot of Ubuntu Base (docker/vm/rootfs/build.sh). This module writes them
// to a directory, as the pipeline would send them, together with the pins as data; nothing here is a second copy of a version or a
// command, so a bump of the hosted pin is a bump of the local one.
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../snapshot/config.ts";
import type { PipelineConfig } from "../snapshot/config.ts";
import {
  PATHS,
  daemonConfigJson,
  installDockerScript,
  installHostScriptsScript,
  installSysboxScript,
  probeScript,
  writeDaemonConfigScript,
} from "../snapshot/scripts.ts";

/** The files of the recipe, by the name the build script reads them under. The numbers are the order the pipeline runs them in. */
export const RECIPE_FILES = {
  installDocker: "10-install-docker.sh",
  installSysbox: "20-install-sysbox.sh",
  daemonJson: "30-daemon.json",
  writeDaemonConfig: "31-write-daemon-config.sh",
  installHostScripts: "40-install-host-scripts.sh",
  workerProbe: "check-worker-probe.sh",
  recipe: "recipe.json",
} as const;

export type RecipeFile = { name: string; content: string; executable: boolean };

export function recipeFiles(
  config: PipelineConfig = DEFAULT_CONFIG,
): RecipeFile[] {
  const recipe = {
    dockerVersion: config.dockerVersion,
    buildxVersion: config.buildxVersion,
    sysboxVersion: config.sysboxVersion,
    sysboxSha256: config.sysboxSha256,
    dockerfile: config.dockerfile,
    worker: { target: config.target, tag: config.imageTag },
    agent: { target: config.agentTarget, tag: config.agentImageTag },
    // Where the pipeline stages a file before its script installs it: the build stages them at the same paths.
    paths: {
      daemonJson: PATHS.daemonJson,
      vmPrepare: PATHS.vmPrepare,
      sysboxPrepare: PATHS.sysboxPrepare,
    },
  };
  return [
    {
      name: RECIPE_FILES.installDocker,
      content: installDockerScript(config),
      executable: true,
    },
    {
      name: RECIPE_FILES.installSysbox,
      content: installSysboxScript(config),
      executable: true,
    },
    {
      name: RECIPE_FILES.daemonJson,
      content: daemonConfigJson(),
      executable: false,
    },
    {
      name: RECIPE_FILES.writeDaemonConfig,
      content: writeDaemonConfigScript(),
      executable: true,
    },
    {
      name: RECIPE_FILES.installHostScripts,
      content: installHostScriptsScript(),
      executable: true,
    },
    {
      name: RECIPE_FILES.workerProbe,
      content: probeScript(config),
      executable: true,
    },
    {
      name: RECIPE_FILES.recipe,
      content: `${JSON.stringify(recipe, null, 2)}\n`,
      executable: false,
    },
  ];
}

export function writeRecipe(
  dir: string,
  config: PipelineConfig = DEFAULT_CONFIG,
): void {
  mkdirSync(dir, { recursive: true });
  for (const file of recipeFiles(config)) {
    const path = join(dir, file.name);
    writeFileSync(path, file.content);
    chmodSync(path, file.executable ? 0o755 : 0o644);
  }
}
