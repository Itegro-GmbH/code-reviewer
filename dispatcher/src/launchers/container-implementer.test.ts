// SPDX-License-Identifier: LicenseRef-Proprietary

import { describe, expect, it } from "vitest";
import {
  ContainerLauncher,
  ContainerSpecError,
  ENTRY_MODE_WORKER_ONCE,
  WORK_VOLUME_PATH,
  applyOverrides,
  renderDockerRunArguments,
  RESERVE_DISK_GIB,
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
  RUNNER_IMPLEMENTER_MODEL_DOOR: "docker",
  RUNNER_IMPLEMENTER_SANDBOX_PROOF: "proven",
  RUNNER_IMPLEMENTER_AGENT_MEMORY_MB: "2560",
};
const DOCKER_SOCKET_MOUNT =
  "type=bind,source=/var/run/docker.sock,target=/run/docker.sock,readonly";

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
  it("mounts the work volume at /work with the volume's options and the VM's Docker socket, and gives memory, pids and the four names", () => {
    const args = render({ environment: IMPLEMENTER_ENVIRONMENT });

    expect(valuesOf(args, "--mount")).toStrictEqual([
      `type=volume,source=${VOLUME},target=${WORK_VOLUME_PATH}`,
      DOCKER_SOCKET_MOUNT,
    ]);
    expect(WORK_VOLUME_PATH).toBe("/work");
    expect(valuesOf(args, "--memory")).toStrictEqual(["768m"]);
    expect(valuesOf(args, "--memory-reservation")).toStrictEqual(["512m"]);
    expect(valuesOf(args, "--memory-swap")).toStrictEqual(["768m"]);
    expect(valuesOf(args, "--pids-limit")).toStrictEqual(["2048"]);
    expect(valuesOf(args, "--env")).toStrictEqual([
      "RUNNER_IMPLEMENTER_AGENT_MEMORY_MB=2560",
      "RUNNER_IMPLEMENTER_MODEL_DOOR=docker",
      "RUNNER_IMPLEMENTER_SANDBOX_PROOF=proven",
      "RUNNER_IMPLEMENTER_WORK_DIR=/work",
    ]);
  });

  // #827-T02
  it("keeps Control out of the kernel's OOM choice at -1000, which root in the agent's container cannot lower its own score to", () => {
    expect(valuesOf(render(), "--oom-score-adj")).toStrictEqual(["-1000"]);
  });

  // #827-T02
  it("leaves every other profile's flags as they were: no OOM score in the default container", () => {
    const standard = renderDockerRunArguments(WORKER_CONTAINER_SPEC, {
      image: IMAGE,
      name: "code-reviewer-worker-job-1",
      command: [ENTRY_MODE_WORKER_ONCE],
      environment: { HOME: "/home/runner" },
    });
    expect(standard).not.toContain("--oom-score-adj");
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
      "--oom-score-adj",
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
  it("accepts the four names of the Implementer only in its own profile", () => {
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
    // Two mounts: the work volume, and the VM's Docker socket for the model door (#745), the only thing of the host that
    // is in the container, read-only. No second volume, no other bind.
    const mounts = valuesOf(args, "--mount");
    expect(mounts).toHaveLength(2);
    expect(mounts[0]).toMatch(
      /^type=volume,source=[A-Za-z0-9_.-]+,target=\/work$/,
    );
    expect(mounts[0]).not.toMatch(/bind|readonly|ro\b/);
    expect(mounts[1]).toBe(DOCKER_SOCKET_MOUNT);
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

  // #745-T14
  it.each<[string, Record<string, unknown>]>([
    [
      "another source",
      { dockerSocket: { source: "/", target: "/run/docker.sock" } },
    ],
    [
      "another target",
      {
        dockerSocket: {
          source: "/var/run/docker.sock",
          target: "/work/docker.sock",
        },
      },
    ],
    [
      "a second key in the socket",
      {
        dockerSocket: {
          source: "/var/run/docker.sock",
          target: "/run/docker.sock",
          readonly: false,
        },
      },
    ],
    [
      "a socket that is not an object",
      { dockerSocket: "/var/run/docker.sock" },
    ],
    [
      "a forbidden-keys list that says no spec has the socket",
      { forbiddenKeys: WORKER_CONTAINER_SPEC.forbiddenKeys },
    ],
  ])("refuses the profile with %s", (_name, change) => {
    expect(codeOf(() => render({}, { ...clone(), ...change }))).toBe(
      "spec_not_hardened",
    );
  });

  // #745-T14
  it("refuses the profile without the VM's Docker socket", () => {
    const changed = clone();
    delete changed.dockerSocket;

    expect(codeOf(() => render({}, changed))).toBe("spec_not_hardened");
  });

  // #745-T14
  it("gives the VM's Docker socket to the Implementer's profile and to no other", () => {
    expect(valuesOf(render(), "--mount")).toContain(DOCKER_SOCKET_MOUNT);
    const standard = renderDockerRunArguments(WORKER_CONTAINER_SPEC, {
      image: IMAGE,
      command: [ENTRY_MODE_WORKER_ONCE],
    });

    expect(standard.join(" ")).not.toContain("docker.sock");
    expect(
      codeOf(() =>
        renderDockerRunArguments(
          {
            ...structuredClone(WORKER_CONTAINER_SPEC),
            dockerSocket: IMPLEMENTER_CONTAINER_SPEC.dockerSocket,
          },
          { image: IMAGE },
        ),
      ),
    ).toBe("spec_forbidden_key");
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
      "work-volume-reserve-image",
      "work-volume-reserve-fs",
      "work-volume-reserve-mount",
      "work-volume-mount",
      "work-volume-options",
      "work-volume-check",
      "work-volume-create",
    ]);
    const image = `${ROOT}/${VOLUME}.reserve.img`;
    expect(
      commands.map((command) => [command.cmd, ...command.args]),
    ).toStrictEqual([
      ["mkdir", "-p", "--", `${directory}/reserve`],
      ["fallocate", "-l", "8G", image],
      [
        "mkfs.ext4",
        "-q",
        "-F",
        "-m",
        "0",
        "-O",
        "^has_journal",
        "-E",
        "lazy_itable_init=1,nodiscard",
        image,
      ],
      ["mount", "-o", "loop,nosuid,nodev", image, `${directory}/reserve`],
      ["mount", "--rbind", directory, directory],
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
        "o=rbind",
        VOLUME,
      ],
    ]);
    for (const command of commands) expect(command.sudo).toBe(true);
    // #745: the reserve disk is allocated (fallocate, not a sparse file) and is no sixteenth of the VM's disk or less
    expect(RESERVE_DISK_GIB).toBe(8);
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
    // The reserve disk below the volume: a mount of its own, as `rbind` shows it.
    const reserve = (options = "rw,nosuid,nodev,relatime") =>
      line(options, `${directory}/reserve`);

    it("accepts the mount the remount made: read-write, nosuid, nodev, with the reserve disk below it", () => {
      expect(
        check()(`${root}\n${line("rw,nosuid,nodev,relatime")}\n${reserve()}\n`),
      ).toBe(true);
    });

    // #745: the reserve disk is what keeps Control's mirror safe from a full disk, so it has to be there and be plain
    it.each([
      ["missing", ""],
      ["without nosuid", `${reserve("rw,nodev,relatime")}\n`],
      ["without nodev", `${reserve("rw,nosuid,relatime")}\n`],
      ["read-only", `${reserve("ro,nosuid,nodev,relatime")}\n`],
      ["noexec", `${reserve("rw,nosuid,nodev,noexec,relatime")}\n`],
    ])("refuses a volume whose reserve disk is %s", (_what, reserveLines) => {
      expect(
        check()(
          `${root}\n${line("rw,nosuid,nodev,relatime")}\n${reserveLines}`,
        ),
      ).toBe(false);
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
          `${line("rw,relatime")}\n${line("rw,nosuid,nodev,relatime")}\n${reserve()}\n`,
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
      DOCKER_SOCKET_MOUNT,
    ]);
    expect(args.join("\n")).not.toContain("crj_");
  });
});
