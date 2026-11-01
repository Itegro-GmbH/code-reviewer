// SPDX-License-Identifier: LicenseRef-Proprietary

import { describe, expect, it } from "vitest";
import {
  ContainerLauncher,
  ContainerSpecError,
  ENTRY_MODE_WORKER_ONCE,
  WORK_VOLUME_PATH,
  applyOverrides,
  renderDockerRunArguments,
  workVolumeCommands,
  workVolumeName,
  type ContainerErrorCode,
  type ContainerInvocation,
  type RenderOptions,
} from "./container.ts";
import {
  IMPLEMENTER_CONTAINER_SPEC,
  SANDBOX_LAUNCHER_ADDITIONS,
  WORKER_CONTAINER_SPEC,
} from "./container-spec.ts";

const IMAGE =
  "registry.invalid/code-reviewer-worker@sha256:0000000000000000000000000000000000000000000000000000000000000000";
const VOLUME = "code-reviewer-work-job-1";
const ROOT = "/var/lib/code-reviewer-work";
const IMPLEMENTER_ENVIRONMENT = {
  RUNNER_IMPLEMENTER_WORK_DIR: "/work",
  RUNNER_IMPLEMENTER_EGRESS_PORT: "10182",
  RUNNER_IMPLEMENTER_NETWORK: "registries",
};

function codeOf(run: () => unknown): ContainerErrorCode | undefined {
  try {
    run();
  } catch (error) {
    if (error instanceof ContainerSpecError) return error.code;
    throw error;
  }
  return undefined;
}

function render(
  options: Partial<RenderOptions> = {},
  from: unknown = IMPLEMENTER_CONTAINER_SPEC,
): string[] {
  return renderDockerRunArguments(from, {
    image: IMAGE,
    name: "code-reviewer-worker-job-1",
    command: [ENTRY_MODE_WORKER_ONCE],
    workVolume: VOLUME,
    ...options,
  });
}

function valuesOf(args: readonly string[], flag: string): string[] {
  return args.flatMap((arg, index) =>
    arg === flag ? [args[index + 1] ?? ""] : [],
  );
}

/** The arguments without these flags and their values: what is left must be the same for every profile. */
function without(args: readonly string[], flags: readonly string[]): string[] {
  return args.filter(
    (arg, index) =>
      !flags.includes(arg) && !flags.includes(args[index - 1] ?? ""),
  );
}

function clone(): Record<string, unknown> {
  return structuredClone(IMPLEMENTER_CONTAINER_SPEC) as unknown as Record<
    string,
    unknown
  >;
}

describe("rendering the implementer profile", () => {
  // #760-T02
  it("mounts the work volume at /work with the volume's options and gives memory, pids and the three names", () => {
    const args = render({ environment: IMPLEMENTER_ENVIRONMENT });

    expect(valuesOf(args, "--mount")).toStrictEqual([
      `type=volume,source=${VOLUME},target=${WORK_VOLUME_PATH}`,
    ]);
    expect(WORK_VOLUME_PATH).toBe("/work");
    expect(valuesOf(args, "--memory")).toStrictEqual(["3g"]);
    expect(valuesOf(args, "--memory-reservation")).toStrictEqual(["2560m"]);
    expect(valuesOf(args, "--memory-swap")).toStrictEqual(["3g"]);
    expect(valuesOf(args, "--pids-limit")).toStrictEqual(["2048"]);
    expect(valuesOf(args, "--env")).toStrictEqual([
      "RUNNER_IMPLEMENTER_EGRESS_PORT=10182",
      "RUNNER_IMPLEMENTER_NETWORK=registries",
      "RUNNER_IMPLEMENTER_WORK_DIR=/work",
    ]);
  });

  // #760-T02
  it("is the default container in every other flag", () => {
    const environment = { HOME: "/home/runner" };
    const implementer = render({ environment, workVolume: VOLUME });
    const standard = renderDockerRunArguments(WORKER_CONTAINER_SPEC, {
      image: IMAGE,
      name: "code-reviewer-worker-job-1",
      command: [ENTRY_MODE_WORKER_ONCE],
      environment,
    });

    const changed = [
      "--mount",
      "--memory",
      "--memory-reservation",
      "--memory-swap",
      "--pids-limit",
    ];
    expect(without(implementer, changed)).toStrictEqual(
      without(standard, changed),
    );
    // The Sandbox additions still apply on top of the profile.
    expect(
      valuesOf(render({ additions: SANDBOX_LAUNCHER_ADDITIONS }), "--sysctl"),
    ).toHaveLength(2);
  });

  // #760-T02
  it("accepts the three names of the Implementer only in its own profile", () => {
    expect(
      codeOf(() => render({ environment: IMPLEMENTER_ENVIRONMENT })),
    ).toBeUndefined();
    expect(
      codeOf(() =>
        renderDockerRunArguments(WORKER_CONTAINER_SPEC, {
          image: IMAGE,
          environment: IMPLEMENTER_ENVIRONMENT,
        }),
      ),
    ).toBe("environment_not_allowed");
  });

  // #760-T07
  it("keeps the root read-only and every tmpfs noexec: the work volume is the only writable path that can run a program", () => {
    const args = render();

    expect(args).toContain("--read-only");
    const tmpfs = valuesOf(args, "--tmpfs");
    expect(tmpfs).toHaveLength(3);
    for (const mount of tmpfs) expect(mount).toContain("noexec");
    // One mount, the work volume; nothing from the host and no second volume.
    const mounts = valuesOf(args, "--mount");
    expect(mounts).toHaveLength(1);
    expect(mounts[0]).toMatch(
      /^type=volume,source=[A-Za-z0-9_.-]+,target=\/work$/,
    );
    expect(mounts[0]).not.toMatch(/bind|readonly|ro\b/);
    for (const flag of [
      "--volume",
      "-v",
      "--device",
      "--privileged",
      "--pid",
      "--ipc",
      "--uts",
      "--userns",
      "--cgroupns",
    ])
      expect(args).not.toContain(flag);
    expect(valuesOf(args, "--cap-drop")).toStrictEqual(["ALL"]);
    expect(valuesOf(args, "--security-opt")).toStrictEqual([
      "no-new-privileges:true",
    ]);
  });

  // #760-T02
  it("takes a memory override like the default profile and refuses one that weakens it", () => {
    const sized = applyOverrides(IMPLEMENTER_CONTAINER_SPEC, {
      memory: { limit: "6g", reservation: "5g" },
    });
    expect(sized.memory).toStrictEqual({
      limit: "6g",
      reservation: "5g",
      swap: "6g",
    });
    expect(
      valuesOf(
        render({ overrides: { memory: { limit: "6g", reservation: "5g" } } }),
        "--memory",
      ),
    ).toStrictEqual(["6g"]);
    expect(
      codeOf(() =>
        render({ overrides: { memory: { limit: "1g", reservation: "2g" } } }),
      ),
    ).toBe("override_invalid");
  });

  // #760-T01
  it.each<[string, Record<string, unknown>]>([
    ["no work volume", { workVolume: undefined }],
    [
      "another path",
      {
        workVolume: {
          path: "/data",
          options: ["rw", "nosuid", "nodev"],
          source: "named-volume",
        },
      },
    ],
    [
      "a volume without nosuid",
      {
        workVolume: {
          path: "/work",
          options: ["rw", "nodev"],
          source: "named-volume",
        },
      },
    ],
    [
      "a volume without nodev",
      {
        workVolume: {
          path: "/work",
          options: ["rw", "nosuid"],
          source: "named-volume",
        },
      },
    ],
    [
      "a volume with another option",
      {
        workVolume: {
          path: "/work",
          options: ["rw", "nosuid", "nodev", "suid"],
          source: "named-volume",
        },
      },
    ],
    [
      "a host path as the source",
      {
        workVolume: {
          path: "/work",
          options: ["rw", "nosuid", "nodev"],
          source: "/var/lib",
        },
      },
    ],
    [
      "a second key in the work volume",
      {
        workVolume: {
          path: "/work",
          options: ["rw", "nosuid", "nodev"],
          source: "named-volume",
          propagation: "shared",
        },
      },
    ],
    ["another pids limit", { pids: { limit: 512 } }],
    ["a pids limit above the profile's", { pids: { limit: 4096 } }],
    [
      "an environment without the three names",
      { allowedEnvironment: ["HOME", "RUNNER_JOB_TIMEOUT_SECONDS"] },
    ],
    ["a second volume", { volumes: ["/data:/data"] }],
    ["a bind", { binds: ["/:/host"] }],
  ])("refuses a profile with %s", (_name, change) => {
    const changed = { ...clone(), ...change };
    if ("workVolume" in change && change.workVolume === undefined)
      delete (changed as { workVolume?: unknown }).workVolume;

    expect(codeOf(() => render({}, changed))).toBeDefined();
  });

  // #760-T01
  it("refuses a default spec that carries a work volume without the rest of the profile", () => {
    const hybrid = {
      ...structuredClone(WORKER_CONTAINER_SPEC),
      workVolume: IMPLEMENTER_CONTAINER_SPEC.workVolume,
    };

    expect(codeOf(() => render({ workVolume: undefined }, hybrid))).toBe(
      "spec_not_hardened",
    );
  });

  // #760-T02
  it.each([
    ["with an option as the name", "--privileged"],
    ["with a comma that adds an option", "work,target=/etc"],
    ["with a path", "../work"],
    ["with a space", "a b"],
    ["that is empty", ""],
  ])("refuses a work volume %s", (_name, name) => {
    expect(codeOf(() => render({ workVolume: name }))).toBe("option_invalid");
  });

  // #760-T02
  it("refuses the profile without the name of its volume", () => {
    expect(
      codeOf(() =>
        renderDockerRunArguments(IMPLEMENTER_CONTAINER_SPEC, { image: IMAGE }),
      ),
    ).toBe("option_invalid");
  });

  // #760-T02
  it("refuses a work volume for the default profile", () => {
    expect(
      codeOf(() => render({ workVolume: VOLUME }, WORKER_CONTAINER_SPEC)),
    ).toBe("option_invalid");
  });
});

describe("the commands that make the work volume", () => {
  // #760-T02
  it("make a mount with the volume's options and a named volume over it, as root and without a shell", () => {
    const commands = workVolumeCommands(IMPLEMENTER_CONTAINER_SPEC, {
      name: VOLUME,
      root: ROOT,
    });
    const directory = `${ROOT}/${VOLUME}`;

    expect(commands.map((command) => command.label)).toStrictEqual([
      "work-volume-dir",
      "work-volume-mount",
      "work-volume-options",
      "work-volume-check",
      "work-volume-create",
    ]);
    expect(
      commands.map((command) => [command.cmd, ...command.args]),
    ).toStrictEqual([
      ["mkdir", "-p", "--", directory],
      ["mount", "--bind", directory, directory],
      ["mount", "-o", "remount,bind,rw,nosuid,nodev", directory],
      ["cat", "/proc/self/mountinfo"],
      [
        "docker",
        "volume",
        "create",
        "--driver",
        "local",
        "--opt",
        "type=none",
        "--opt",
        `device=${directory}`,
        "--opt",
        "o=bind",
        VOLUME,
      ],
    ]);
    for (const command of commands) expect(command.sudo).toBe(true);
    // Programs may run on the volume: no noexec anywhere, and no shell.
    expect(JSON.stringify(commands)).not.toContain("noexec");
    expect(commands.map((command) => command.cmd)).not.toContain("sh");
  });

  // #760-T09
  describe("the check of the mount options between the remount and the volume", () => {
    const directory = `${ROOT}/${VOLUME}`;
    const check = () => {
      const found = workVolumeCommands(IMPLEMENTER_CONTAINER_SPEC, {
        name: VOLUME,
        root: ROOT,
      }).find((command) => command.label === "work-volume-check");
      if (found?.check === undefined) throw new Error("the step has no check");
      return found.check;
    };
    const line = (options: string, mountPoint = directory) =>
      `101 22 8:1 ${directory} ${mountPoint} ${options} shared:1 - ext4 /dev/sda1 rw,nosuid,nodev`;
    const root = "22 1 8:1 / / rw,relatime shared:1 - ext4 /dev/sda1 rw";

    it("accepts the mount the remount made: read-write, nosuid, nodev", () => {
      expect(check()(`${root}\n${line("rw,nosuid,nodev,relatime")}\n`)).toBe(
        true,
      );
    });

    it.each([
      ["no nosuid", "rw,nodev,relatime"],
      ["no nodev", "rw,nosuid,relatime"],
      ["noexec", "rw,nosuid,nodev,noexec,relatime"],
      ["a read-only mount", "ro,nosuid,nodev,relatime"],
      ["none of them", "rw,relatime"],
    ])("refuses a mount with %s", (_what, options) => {
      expect(check()(`${root}\n${line(options)}\n`)).toBe(false);
    });

    it("reads the options of the mount, not the options of the superblock behind it", () => {
      // The last field of a line is the superblock's (`rw,nosuid,nodev` here): it must not stand in for the mount's.
      expect(check()(`${root}\n${line("rw,relatime")}\n`)).toBe(false);
    });

    it("refuses an output with no mount at the directory, an empty one, and a mount of another path", () => {
      expect(check()("")).toBe(false);
      expect(check()(`${root}\n`)).toBe(false);
      expect(
        check()(`${root}\n${line("rw,nosuid,nodev", `${directory}-other`)}\n`),
      ).toBe(false);
    });

    it("judges the last mount at the directory: what a later mount hides is not the volume", () => {
      expect(
        check()(
          `${line("rw,nosuid,nodev,relatime")}\n${line("rw,relatime")}\n`,
        ),
      ).toBe(false);
      expect(
        check()(
          `${line("rw,relatime")}\n${line("rw,nosuid,nodev,relatime")}\n`,
        ),
      ).toBe(true);
    });
  });

  // #760-T02
  it("are made for the implementer profile only, with a plain name and a plain root", () => {
    expect(
      codeOf(() =>
        workVolumeCommands(WORKER_CONTAINER_SPEC, { name: VOLUME, root: ROOT }),
      ),
    ).toBe("option_invalid");
    for (const [name, root] of [
      ["--privileged", ROOT],
      ["a,b", ROOT],
      [VOLUME, "relative/dir"],
      [VOLUME, "/var/../etc"],
      [VOLUME, "/var/lib/a b"],
      [VOLUME, "/"],
    ] as const)
      expect(
        codeOf(() =>
          workVolumeCommands(IMPLEMENTER_CONTAINER_SPEC, { name, root }),
        ),
      ).toBe("option_invalid");
  });

  // #760-T02
  it("name the volume after the job", () => {
    expect(workVolumeName("job-1")).toBe("code-reviewer-work-job-1");
  });
});

describe("the container launcher with the implementer profile", () => {
  // #760-T02
  it("renders the work volume of the job into the container it starts and keeps the credential out of the arguments", async () => {
    const launches: ContainerInvocation[] = [];
    const launcher = new ContainerLauncher({
      host: {
        run(invocation) {
          launches.push(invocation);
          return Promise.resolve({ exitCode: 0 });
        },
      },
      spec: IMPLEMENTER_CONTAINER_SPEC,
      image: IMAGE,
      environment: { HOME: "/home/runner", ...IMPLEMENTER_ENVIRONMENT },
    });

    await launcher.launch({
      appId: "factory",
      appUrl: "https://factory.example.invalid",
      jobId: "job-7",
      credential: "crj_dummy-credential-0123456789",
      kind: "implementer",
      timeoutSeconds: 3600,
      config: {},
    });

    const args = launches[0]?.args ?? [];
    expect(valuesOf(args, "--mount")).toStrictEqual([
      "type=volume,source=code-reviewer-work-job-7,target=/work",
    ]);
    expect(args.join("\n")).not.toContain("crj_");
  });
});
