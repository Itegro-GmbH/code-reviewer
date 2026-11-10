// SPDX-License-Identifier: LicenseRef-Proprietary

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  IPV6_OFF_COMMANDS,
  IPV6_OFF_STEP_TIMEOUT_MS,
  DOCKER_TMPDIR,
  RUN_DIRECTORY_COMMANDS,
  RUN_DIRECTORY_STEP_TIMEOUT_MS,
  SYSBOX_PREPARE_PATH,
  SYSBOX_PREPARE_TIMEOUT_MS,
  VM_PREPARE_PATH,
  VM_PREPARE_TIMEOUT_MS,
  WORK_VOLUME_STEP_TIMEOUT_MS,
} from "./sandbox-host.ts";
import { workVolumeCommands, workVolumeName } from "./container.ts";
import { IMPLEMENTER_CONTAINER_SPEC } from "./container-spec.ts";
import { WORK_VOLUME_ROOT } from "./sandbox.ts";

// The commands of the hosted launcher that vm-init makes in a local VM, as the Dispatcher's code renders them. The runner's tests
// (runner/tests/unit/test_vm_init_steps.py) read the same file and hold vm-init's own steps equal to it, so the hosted launcher and
// vm-init cannot drift apart unseen: a change of a step here fails the runner's suite until vm-init has it too, and the other way
// round. The check of the work volume's mount options is code on both sides and is pinned by each side's own tests.
interface GoldenStep {
  label: string;
  argv: string[];
  timeoutSeconds?: number;
}

const seconds = (ms: number): number => ms / 1000;

function rendered(): {
  preDaemon: GoldenStep[];
  sysbox: GoldenStep;
  workVolume: GoldenStep[];
} {
  const plain = (
    command: { label: string; cmd: string; args: readonly string[] },
    timeoutMs: number,
  ): GoldenStep => ({
    label: command.label,
    argv: [command.cmd, ...command.args],
    timeoutSeconds: seconds(timeoutMs),
  });
  return {
    preDaemon: [
      ...RUN_DIRECTORY_COMMANDS.map((c) =>
        plain(c, RUN_DIRECTORY_STEP_TIMEOUT_MS),
      ),
      ...IPV6_OFF_COMMANDS.map((c) => plain(c, IPV6_OFF_STEP_TIMEOUT_MS)),
      // `prepare()` of the host: the daemon starts with its temporary directory on the memory directory.
      {
        label: "vm-prepare",
        argv: ["env", `TMPDIR=${DOCKER_TMPDIR}`, VM_PREPARE_PATH],
        timeoutSeconds: seconds(VM_PREPARE_TIMEOUT_MS),
      },
    ],
    sysbox: {
      label: "sysbox-prepare",
      argv: [SYSBOX_PREPARE_PATH],
      timeoutSeconds: seconds(SYSBOX_PREPARE_TIMEOUT_MS),
    },
    workVolume: workVolumeCommands(IMPLEMENTER_CONTAINER_SPEC, {
      name: workVolumeName("job-1"),
      root: WORK_VOLUME_ROOT,
    }).map((c) => plain(c, WORK_VOLUME_STEP_TIMEOUT_MS)),
  };
}

describe("the steps vm-init makes after the hosted launcher", () => {
  // #977-T01
  it("are the steps of the golden file the runner's vm-init holds itself to", () => {
    const golden = JSON.parse(
      readFileSync(
        new URL("./testdata/vm-steps.golden.json", import.meta.url),
        "utf8",
      ),
    ) as unknown;

    expect(rendered()).toEqual(golden);
  });

  // #977-T01
  // The image check of `prepare()` sits between the daemon and Sysbox: it needs the start's `image`, so vm-init makes it after
  // the start was read (runner/tests/unit/test_vm_init_agent.py pins that order).
  it("are the hosted order: directories on memory, IPv6 off, the daemon, [the image check], Sysbox, the work volume", () => {
    const { preDaemon, sysbox, workVolume } = rendered();

    expect(preDaemon.map((s) => s.label)).toEqual([
      "run-directories",
      "run-directory-docker",
      "run-directory-containerd",
      "ipv6-off",
      "vm-prepare",
    ]);
    expect(sysbox.label).toBe("sysbox-prepare");
    expect(workVolume.map((s) => s.label)).toEqual([
      "work-volume-dir",
      "work-volume-reserve-image",
      "work-volume-reserve-fs",
      "work-volume-reserve-mount",
      "work-volume-mount",
      "work-volume-options",
      "work-volume-check",
      "work-volume-create",
    ]);
  });
});
