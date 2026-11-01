// SPDX-License-Identifier: LicenseRef-Proprietary

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type {
  WorkerContainerOverrides,
  WorkerContainerSpec,
} from "../contracts/worker-container.ts";
import type { LaunchSpec, ReviewKind } from "../core/types.ts";
import {
  ContainerLauncher,
  ContainerSpecError,
  ENTRY_MODE_WORKER_ONCE,
  applyOverrides,
  renderDockerRunArguments,
  type ContainerErrorCode,
  type ContainerHost,
  type ContainerInvocation,
} from "./container.ts";
import {
  IMPLEMENTER_CONTAINER_SPEC,
  SANDBOX_LAUNCHER_ADDITIONS,
  WORKER_CONTAINER_SPEC,
} from "./container-spec.ts";

const IMAGE =
  "registry.invalid/code-reviewer-worker@sha256:0000000000000000000000000000000000000000000000000000000000000000";
const CREDENTIAL = "crj_dummy-credential-0123456789";

// Both profiles of the contract: what a refusal must hold for, and the option the implementer's volume needs.
const PROFILES = [
  ["default", WORKER_CONTAINER_SPEC, {}],
  [
    "implementer",
    IMPLEMENTER_CONTAINER_SPEC,
    { workVolume: "code-reviewer-work-job-1" },
  ],
] as const;

function spec(): Record<string, unknown> {
  return structuredClone(WORKER_CONTAINER_SPEC) as unknown as Record<
    string,
    unknown
  >;
}

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
  options: Partial<Parameters<typeof renderDockerRunArguments>[1]> = {},
  from: unknown = WORKER_CONTAINER_SPEC,
): string[] {
  return renderDockerRunArguments(from, {
    image: IMAGE,
    command: [ENTRY_MODE_WORKER_ONCE],
    ...options,
  });
}

/** The values that follow every occurrence of a flag. */
function valuesOf(args: string[], flag: string): string[] {
  return args.flatMap((arg, index) =>
    arg === flag ? [args[index + 1] ?? ""] : [],
  );
}

describe("rendering the hardened container spec", () => {
  // #325-T01
  it("renders arguments that equal the golden file", () => {
    const golden = JSON.parse(
      readFileSync(
        new URL("./testdata/docker-run.golden.json", import.meta.url),
        "utf8",
      ),
    ) as string[];

    expect(
      render({
        name: "code-reviewer-worker-job-1",
        environment: {
          HOME: "/home/runner",
          RUNNER_JOB_TIMEOUT_SECONDS: "1200",
        },
      }),
    ).toEqual(golden);
  });

  // #325-T01
  it("attaches stdin, stays in the foreground and carries every flag of the spec", () => {
    const args = render();

    expect(args.slice(0, 3)).toEqual(["run", "--interactive", "--rm"]);
    expect(args).not.toContain("--detach");
    expect(valuesOf(args, "--user")).toEqual(["0:0"]);
    expect(valuesOf(args, "--cap-drop")).toEqual(["ALL"]);
    expect(valuesOf(args, "--cap-add")).toEqual([
      "SETUID",
      "SETGID",
      "KILL",
      "CHOWN",
      "DAC_OVERRIDE",
      "FOWNER",
      "NET_ADMIN",
      "SETPCAP",
    ]);
    expect(valuesOf(args, "--security-opt")).toEqual([
      "no-new-privileges:true",
    ]);
    expect(args).toContain("--read-only");
    expect(valuesOf(args, "--pids-limit")).toEqual(["512"]);
    expect(valuesOf(args, "--stop-timeout")).toEqual(["90"]);
    expect(valuesOf(args, "--network")).toEqual(["bridge"]);
    expect(args.slice(-2)).toEqual([IMAGE, ENTRY_MODE_WORKER_ONCE]);
  });

  // #325-T01
  it("renders every tmpfs as the compose file writes it", () => {
    expect(valuesOf(render(), "--tmpfs")).toEqual([
      "/tmp:rw,noexec,nosuid,nodev,size=512m,mode=1777",
      "/run:rw,noexec,nosuid,nodev,size=1m,mode=0755",
      "/home/runner:rw,noexec,nosuid,nodev,size=64m,uid=10001,gid=10001,mode=0700",
    ]);
  });

  // #325-T03
  it("never emits a flag of the forbidden kinds", () => {
    const args = render({ seccompProfile: "/etc/code-reviewer/seccomp.json" });

    for (const flag of [
      "--privileged",
      "--volume",
      "-v",
      "--mount",
      "--device",
      "--pid",
      "--ipc",
      "--uts",
      "--userns",
      "--cgroupns",
      "--sysctl",
      "--detach",
    ])
      expect(args).not.toContain(flag);
    expect(valuesOf(args, "--network")).not.toContain("host");
    expect(args.join(" ")).not.toContain("unconfined");
    expect(args.join(" ")).not.toContain("docker.sock");
  });

  // #325-T03, #760-T01: the same negative fixtures for every profile
  describe.each(PROFILES)("the %s profile", (_profile, base, options) => {
    it.each<[string, Record<string, unknown>, ContainerErrorCode]>([
      ["privileged", { privileged: true }, "spec_forbidden_key"],
      [
        "a bind mount",
        { binds: ["/var/run/docker.sock:/var/run/docker.sock"] },
        "spec_forbidden_key",
      ],
      ["a volume", { volumes: ["/data:/data"] }, "spec_forbidden_key"],
      ["a device", { devices: ["/dev/kvm"] }, "spec_forbidden_key"],
      ["host network (key)", { networkMode: "host" }, "spec_forbidden_key"],
      ["the host pid namespace", { pid: "host" }, "spec_forbidden_key"],
      ["the host ipc namespace", { ipc: "host" }, "spec_forbidden_key"],
      ["the docker socket", { dockerSocket: true }, "spec_forbidden_key"],
      [
        "host network (value)",
        { network: { mode: "host" } },
        "spec_not_hardened",
      ],
      ["no network", { network: { mode: "none" } }, "spec_not_hardened"],
      [
        "an unconfined seccomp profile",
        { securityOpt: ["no-new-privileges:true", "seccomp=unconfined"] },
        "spec_not_hardened",
      ],
      [
        "an unconfined apparmor profile",
        { securityOpt: ["no-new-privileges:true", "apparmor=unconfined"] },
        "spec_not_hardened",
      ],
      ["no no-new-privileges", { securityOpt: [] }, "spec_not_hardened"],
      ["a writable root", { readOnly: false }, "spec_not_hardened"],
      ["another user", { user: "10001:10001" }, "spec_not_hardened"],
      [
        "not dropping everything",
        { capDrop: ["NET_RAW"] },
        "spec_not_hardened",
      ],
      [
        "a capability outside the list",
        { capAdd: [{ name: "SYS_ADMIN", startupOnly: false }] },
        "spec_not_hardened",
      ],
      [
        "NET_ADMIN not marked startup-only",
        { capAdd: [{ name: "NET_ADMIN", startupOnly: false }] },
        "spec_not_hardened",
      ],
      [
        "a pids limit above the ceiling",
        { pids: { limit: 100000 } },
        "spec_not_hardened",
      ],
      ["an unknown key", { somethingNew: 1 }, "spec_unknown_key"],
      ["a version it does not know", { version: 2 }, "spec_not_hardened"],
      [
        "a secret in the allowed environment",
        { allowedEnvironment: ["RUNNER_TOKEN"] },
        "spec_not_hardened",
      ],
    ])("refuses a spec that asks for %s", (_name, change, code) => {
      expect(
        codeOf(() => render(options, { ...structuredClone(base), ...change })),
      ).toBe(code);
    });
  });

  // #325-T03
  it.each([
    ["a missing noexec", "noexec"],
    ["a missing nosuid", "nosuid"],
    ["a missing nodev", "nodev"],
  ])("refuses a tmpfs with %s", (_name, option) => {
    const weakened = spec();
    const tmpfs = weakened.tmpfs as Array<{ options: string[] }>;
    tmpfs[0] = {
      ...(tmpfs[0] as { options: string[] }),
      options: (tmpfs[0] as { options: string[] }).options.filter(
        (o) => o !== option,
      ),
    };

    expect(codeOf(() => render({}, weakened))).toBe("spec_not_hardened");
  });

  // #325-T03
  it.each(["0m", "00m", "0g"])(
    "refuses a spec with the memory size %s",
    (size) => {
      const changed = spec();
      changed.memory = { limit: size, reservation: size, swap: size };

      expect(codeOf(() => render({}, changed))).toBe("spec_not_hardened");
    },
  );

  // #325-T03
  it("refuses a tmpfs path outside the three private ones", () => {
    const changed = spec();
    const tmpfs = changed.tmpfs as Array<Record<string, unknown>>;
    tmpfs[1] = { ...tmpfs[1], path: "/" };

    expect(codeOf(() => render({}, changed))).toBe("spec_not_hardened");
  });

  // #325-T03
  it("refuses what is not an object", () => {
    for (const bad of [null, "spec", 1, []])
      expect(codeOf(() => render({}, bad))).toBe("spec_not_hardened");
  });

  // #325-T03
  it.each([
    ["an image that is an option", "--privileged"],
    ["an empty image", ""],
    ["an image with a space", "image name"],
  ])("refuses %s", (_name, image) => {
    expect(codeOf(() => render({ image }))).toBe("option_invalid");
  });

  // #325-T03
  it("refuses a container name that is an option or has a space", () => {
    expect(codeOf(() => render({ name: "--privileged" }))).toBe(
      "option_invalid",
    );
    expect(codeOf(() => render({ name: "a b" }))).toBe("option_invalid");
  });

  // #325-T04
  it("refuses an environment name the spec does not allow, and a secret-looking one", () => {
    expect(codeOf(() => render({ environment: { PATH: "/bin" } }))).toBe(
      "environment_not_allowed",
    );
    expect(codeOf(() => render({ environment: { RUNNER_TOKEN: "x" } }))).toBe(
      "environment_not_allowed",
    );
    expect(
      codeOf(() => render({ environment: { WORKER_CREDENTIAL: "x" } })),
    ).toBe("environment_not_allowed");
  });

  // #325-T04
  it("refuses an environment value with a line break", () => {
    expect(
      codeOf(() => render({ environment: { HOME: "/home/runner\nX=1" } })),
    ).toBe("option_invalid");
  });
});

describe("the memory limit per Worker kind", () => {
  // #325-T05
  it("takes the spec's memory when nothing is overridden", () => {
    const args = render();

    expect(valuesOf(args, "--memory")).toEqual(["2g"]);
    expect(valuesOf(args, "--memory-reservation")).toEqual(["1536m"]);
    expect(valuesOf(args, "--memory-swap")).toEqual(["2g"]);
  });

  // #325-T05
  it("overrides the limit and keeps the swap equal to it", () => {
    const args = render({ overrides: { memory: { limit: "1536m" } } });

    expect(valuesOf(args, "--memory")).toEqual(["1536m"]);
    expect(valuesOf(args, "--memory-swap")).toEqual(["1536m"]);
    // The reservation of the spec (1536m) still fits under the new limit.
    expect(valuesOf(args, "--memory-reservation")).toEqual(["1536m"]);
  });

  // #325-T05
  it("overrides limit, reservation and swap together", () => {
    const overrides: WorkerContainerOverrides = {
      memory: { limit: "1536m", reservation: "1280m", swap: "1536m" },
    };

    const args = render({ overrides });

    expect(valuesOf(args, "--memory-reservation")).toEqual(["1280m"]);
    expect(applyOverrides(WORKER_CONTAINER_SPEC, overrides).memory).toEqual(
      overrides.memory,
    );
  });

  // #325-T05
  it("changes nothing but the memory keys", () => {
    const changed = applyOverrides(WORKER_CONTAINER_SPEC, {
      memory: { limit: "1g", reservation: "512m" },
    });

    expect({ ...changed, memory: undefined }).toEqual({
      ...WORKER_CONTAINER_SPEC,
      memory: undefined,
    });
    expect(changed.memory).toEqual({
      limit: "1g",
      reservation: "512m",
      swap: "1g",
    });
  });

  // #325-T05
  it.each<[string, unknown]>([
    ["the user", { user: "10001:10001" }],
    ["the root filesystem", { readOnly: false }],
    ["the pids limit", { pids: { limit: 4096 } }],
    ["the capabilities", { capAdd: [] }],
    ["privileged", { privileged: true }],
    ["a tmpfs size", { tmpfs: [] }],
    ["an unknown memory key", { memory: { limit: "1g", hard: "2g" } }],
    ["a non-object", "1536m"],
    ["null", null],
  ])("refuses an override of %s", (_name, overrides) => {
    expect(
      codeOf(() => applyOverrides(WORKER_CONTAINER_SPEC, overrides as never)),
    ).toBe("override_not_allowed");
  });

  // #325-T05
  it("refuses an override the spec does not list as overridable", () => {
    const narrow = {
      ...(spec() as object),
      overridable: ["memory.limit"],
    } as unknown as WorkerContainerSpec;

    expect(
      codeOf(() => applyOverrides(narrow, { memory: { reservation: "512m" } })),
    ).toBe("override_not_allowed");
    expect(
      applyOverrides(narrow, { memory: { limit: "1536m" } }).memory.limit,
    ).toBe("1536m");
  });

  // #325-T05
  it.each<[string, WorkerContainerOverrides]>([
    ["a swap above the limit", { memory: { limit: "1g", swap: "2g" } }],
    ["a swap below the limit", { memory: { limit: "1g", swap: "512m" } }],
    [
      "a reservation above the limit",
      { memory: { limit: "1g", reservation: "2g" } },
    ],
    ["a new limit below the spec's reservation", { memory: { limit: "1g" } }],
    ["a limit that is not a size", { memory: { limit: "lots" } }],
    ["a limit in bytes", { memory: { limit: "1073741824" } }],
    [
      "a zero limit, which Docker reads as no limit",
      { memory: { limit: "0m", reservation: "0m" } },
    ],
    [
      "a zero limit in gigabytes",
      { memory: { limit: "0g", reservation: "512m" } },
    ],
    ["a zero reservation", { memory: { reservation: "0m" } }],
  ])("refuses %s", (_name, overrides) => {
    expect(codeOf(() => applyOverrides(WORKER_CONTAINER_SPEC, overrides))).toBe(
      "override_invalid",
    );
  });

  // #325-T05
  it("lets the Diff and the Dynamic Worker differ", async () => {
    const launches: ContainerInvocation[] = [];
    const launcher = new ContainerLauncher({
      host: recordingHost(launches),
      spec: WORKER_CONTAINER_SPEC,
      image: IMAGE,
    });

    await launcher.launch(
      request("diff", { memory: { limit: "1g", reservation: "768m" } }),
    );
    await launcher.launch(
      request("dynamic", { memory: { limit: "1536m", reservation: "1280m" } }),
    );

    const [diff, dynamic] = launches;
    expect(valuesOf(diff?.args ?? [], "--memory")).toEqual(["1g"]);
    expect(valuesOf(diff?.args ?? [], "--memory-swap")).toEqual(["1g"]);
    expect(valuesOf(dynamic?.args ?? [], "--memory")).toEqual(["1536m"]);
    expect(valuesOf(dynamic?.args ?? [], "--memory-swap")).toEqual(["1536m"]);
  });

  // #325-T05
  it("uses the spec's memory for a job without an override", async () => {
    const launches: ContainerInvocation[] = [];
    const launcher = new ContainerLauncher({
      host: recordingHost(launches),
      spec: WORKER_CONTAINER_SPEC,
      image: IMAGE,
    });

    await launcher.launch(request("diff"));

    expect(valuesOf(launches[0]?.args ?? [], "--memory")).toEqual(["2g"]);
  });

  // #325-T05
  it("refuses a job whose configuration overrides more than the memory", async () => {
    const launches: ContainerInvocation[] = [];
    const launcher = new ContainerLauncher({
      host: recordingHost(launches),
      spec: WORKER_CONTAINER_SPEC,
      image: IMAGE,
    });

    await expect(
      launcher.launch(
        request("dynamic", { user: "10001:10001" } as WorkerContainerOverrides),
      ),
    ).rejects.toMatchObject({ code: "override_not_allowed" });
    expect(launches).toEqual([]);
  });
});

describe("the per-launcher additions (IPv6 off)", () => {
  const IPV6_OFF = [
    "net.ipv6.conf.all.disable_ipv6=1",
    "net.ipv6.conf.default.disable_ipv6=1",
  ];

  // #325-T08
  it("renders no sysctl unless a launcher asks for the additions", () => {
    expect(valuesOf(render(), "--sysctl")).toEqual([]);
    expect(valuesOf(render({ additions: {} }), "--sysctl")).toEqual([]);
  });

  // #325-T08
  it("renders the two IPv6 switches for the Sandbox variant", () => {
    const args = render({ additions: SANDBOX_LAUNCHER_ADDITIONS });

    expect(valuesOf(args, "--sysctl")).toEqual(IPV6_OFF);
    // Everything else is the spec: the additions change nothing but the two flags.
    expect(args.filter((_, i) => !isSysctl(args, i))).toEqual(render());
  });

  // #325-T08
  it("renders arguments for the Sandbox variant that equal the golden file", () => {
    const golden = JSON.parse(
      readFileSync(
        new URL("./testdata/docker-run.sandbox.golden.json", import.meta.url),
        "utf8",
      ),
    ) as string[];

    expect(
      render({
        name: "code-reviewer-worker-job-1",
        environment: { HOME: "/home/runner" },
        overrides: { memory: { limit: "1536m", reservation: "1280m" } },
        additions: SANDBOX_LAUNCHER_ADDITIONS,
      }),
    ).toEqual(golden);
  });

  // #325-T08
  it.each<[string, unknown]>([
    ["another sysctl", { sysctls: { "net.ipv4.ip_forward": "1" } }],
    [
      "an extra sysctl",
      {
        sysctls: {
          "net.ipv6.conf.all.disable_ipv6": "1",
          "net.ipv6.conf.default.disable_ipv6": "1",
          "kernel.core_pattern": "x",
        },
      },
    ],
    [
      "only one of the two",
      { sysctls: { "net.ipv6.conf.all.disable_ipv6": "1" } },
    ],
    [
      "a switch left on",
      {
        sysctls: {
          "net.ipv6.conf.all.disable_ipv6": "0",
          "net.ipv6.conf.default.disable_ipv6": "1",
        },
      },
    ],
    ["another key", { privileged: true }],
    ["a device", { devices: ["/dev/kvm"] }],
    ["a non-object", "net.ipv6.conf.all.disable_ipv6=1"],
  ])("refuses additions with %s", (_name, additions) => {
    expect(codeOf(() => render({ additions: additions as never }))).toBe(
      "additions_not_allowed",
    );
  });

  // #325-T08
  it("is added by the launcher to every container it starts, and only when configured", async () => {
    const launches: ContainerInvocation[] = [];
    const sandbox = new ContainerLauncher({
      host: recordingHost(launches),
      spec: WORKER_CONTAINER_SPEC,
      image: IMAGE,
      additions: SANDBOX_LAUNCHER_ADDITIONS,
    });
    const selfHosted = new ContainerLauncher({
      host: recordingHost(launches),
      spec: WORKER_CONTAINER_SPEC,
      image: IMAGE,
    });

    await sandbox.launch(request("dynamic"));
    await sandbox.launch(request("diff"));
    await selfHosted.launch(request("dynamic"));

    expect(launches.map((l) => valuesOf(l.args, "--sysctl"))).toEqual([
      IPV6_OFF,
      IPV6_OFF,
      [],
    ]);
  });

  // #325-T08
  it("refuses invalid additions when the launcher is created", () => {
    expect(
      codeOf(
        () =>
          new ContainerLauncher({
            host: recordingHost([]),
            spec: WORKER_CONTAINER_SPEC,
            image: IMAGE,
            additions: { sysctls: { "net.ipv4.ip_forward": "1" } } as never,
          }),
      ),
    ).toBe("additions_not_allowed");
  });
});

/** Whether the argument at `index` is `--sysctl` or the value after it. */
function isSysctl(args: string[], index: number): boolean {
  return args[index] === "--sysctl" || args[index - 1] === "--sysctl";
}

describe("the optional seccomp profile", () => {
  const PROFILE = "/etc/code-reviewer/seccomp-no-vsock.json";

  // #325-T06
  it("adds the profile argument when it is enabled", () => {
    expect(
      valuesOf(render({ seccompProfile: PROFILE }), "--security-opt"),
    ).toEqual(["no-new-privileges:true", `seccomp=${PROFILE}`]);
  });

  // #325-T06
  it("adds nothing when it is disabled", () => {
    expect(render().join(" ")).not.toContain("seccomp");
  });

  // #325-T06
  it.each([
    ["unconfined", "unconfined"],
    ["a path with a space", "/etc/a b.json"],
    ["an option", "--privileged"],
    ["an empty value", ""],
  ])("refuses %s", (_name, seccompProfile) => {
    expect(codeOf(() => render({ seccompProfile }))).toBe("option_invalid");
  });

  // #325-T06
  it("uses the profile the spec itself names, and refuses a second one", () => {
    const named = {
      ...spec(),
      securityOpt: ["no-new-privileges:true", "seccomp=/etc/spec-profile.json"],
    };

    expect(valuesOf(render({}, named), "--security-opt")).toEqual([
      "no-new-privileges:true",
      "seccomp=/etc/spec-profile.json",
    ]);
    expect(codeOf(() => render({ seccompProfile: PROFILE }, named))).toBe(
      "option_invalid",
    );
  });
});

function request(
  kind: ReviewKind,
  container?: WorkerContainerOverrides,
): LaunchSpec {
  return {
    appId: "reviewer",
    appUrl: "https://app.example.invalid",
    jobId: `job-${kind}`,
    credential: CREDENTIAL,
    kind,
    timeoutSeconds: 1200,
    config: container === undefined ? {} : { container },
  };
}

function recordingHost(launches: ContainerInvocation[]): ContainerHost {
  return {
    run(invocation) {
      launches.push(invocation);
      return Promise.resolve({ exitCode: 0 });
    },
  };
}

describe("the container launcher", () => {
  // #325-T04
  it("hands the credential over on stdin and nowhere else", async () => {
    const launches: ContainerInvocation[] = [];
    const launcher = new ContainerLauncher({
      host: recordingHost(launches),
      spec: WORKER_CONTAINER_SPEC,
      image: IMAGE,
      environment: { HOME: "/home/runner" },
    });

    await launcher.launch(request("dynamic"));

    const [invocation] = launches;
    expect(invocation?.args.join("\n")).not.toContain(CREDENTIAL);
    expect(invocation?.args.join("\n")).not.toContain("crj_");
    expect(JSON.parse(invocation?.stdin ?? "")).toEqual({
      appUrl: "https://app.example.invalid",
      jobId: "job-dynamic",
      credential: CREDENTIAL,
    });
    expect(invocation?.args).toContain("--interactive");
    expect(invocation?.args.at(-1)).toBe(ENTRY_MODE_WORKER_ONCE);
  });

  // #325-T04
  it("refuses to start when an environment value holds the credential", async () => {
    const launches: ContainerInvocation[] = [];
    const launcher = new ContainerLauncher({
      host: recordingHost(launches),
      spec: WORKER_CONTAINER_SPEC,
      image: IMAGE,
      environment: { HOME: `/home/${CREDENTIAL}` },
    });

    await expect(launcher.launch(request("dynamic"))).rejects.toMatchObject({
      code: "credential_in_arguments",
    });
    expect(launches).toEqual([]);
  });

  // #325-T04
  it("keeps the credential out of every error it raises", async () => {
    const launcher = new ContainerLauncher({
      host: recordingHost([]),
      spec: WORKER_CONTAINER_SPEC,
      image: IMAGE,
      environment: { HOME: `/home/${CREDENTIAL}` },
    });

    const error: unknown = await launcher
      .launch(request("dynamic"))
      .catch((caught: unknown) => caught);

    expect(String(error)).not.toContain(CREDENTIAL);
    expect(JSON.stringify(error)).not.toContain(CREDENTIAL);
  });

  // #325-T04
  it("refuses a job id that could become a flag", async () => {
    const launcher = new ContainerLauncher({
      host: recordingHost([]),
      spec: WORKER_CONTAINER_SPEC,
      image: IMAGE,
    });

    await expect(
      launcher.launch({ ...request("dynamic"), jobId: "--privileged" }),
    ).rejects.toMatchObject({ code: "option_invalid" });
  });

  // #325-T04
  it("refuses an empty credential", async () => {
    const launcher = new ContainerLauncher({
      host: recordingHost([]),
      spec: WORKER_CONTAINER_SPEC,
      image: IMAGE,
    });

    await expect(
      launcher.launch({ ...request("dynamic"), credential: "" }),
    ).rejects.toMatchObject({ code: "option_invalid" });
  });

  // #325-T04
  it("names the container after the job so that a launcher can stop it", async () => {
    const launches: ContainerInvocation[] = [];
    const launcher = new ContainerLauncher({
      host: recordingHost(launches),
      spec: WORKER_CONTAINER_SPEC,
      image: IMAGE,
    });

    await launcher.launch(request("diff"));

    expect(valuesOf(launches[0]?.args ?? [], "--name")).toEqual([
      "code-reviewer-worker-job-diff",
    ]);
  });

  // #325-T04
  it("gives the Worker the job's timeout and passes the abort signal on", async () => {
    const launches: ContainerInvocation[] = [];
    const launcher = new ContainerLauncher({
      host: recordingHost(launches),
      spec: WORKER_CONTAINER_SPEC,
      image: IMAGE,
    });
    const controller = new AbortController();

    await launcher.launch(request("dynamic"), controller.signal);

    expect(valuesOf(launches[0]?.args ?? [], "--env")).toEqual([
      "RUNNER_JOB_TIMEOUT_SECONDS=1200",
    ]);
    expect(launches[0]?.signal).toBe(controller.signal);
  });

  // #325-T03
  it("refuses a configuration the spec does not allow when it is created", () => {
    expect(
      codeOf(
        () =>
          new ContainerLauncher({
            host: recordingHost([]),
            spec: WORKER_CONTAINER_SPEC,
            image: IMAGE,
            environment: { RUNNER_TOKEN: "x" },
          }),
      ),
    ).toBe("environment_not_allowed");
    expect(
      codeOf(
        () =>
          new ContainerLauncher({
            host: recordingHost([]),
            spec: { ...spec(), privileged: true },
            image: IMAGE,
          }),
      ),
    ).toBe("spec_forbidden_key");
  });

  // #325-T03
  it("refuses at creation a spec that does not allow the timeout variable the launcher sets", () => {
    const narrow = {
      ...spec(),
      allowedEnvironment: ["HOME"],
    };

    expect(
      codeOf(
        () =>
          new ContainerLauncher({
            host: recordingHost([]),
            spec: narrow,
            image: IMAGE,
          }),
      ),
    ).toBe("environment_not_allowed");
  });
});
