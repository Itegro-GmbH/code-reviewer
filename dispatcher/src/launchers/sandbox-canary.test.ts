// SPDX-License-Identifier: LicenseRef-Proprietary

import { beforeEach, describe, expect, it } from "vitest";
import { FakeSandboxService } from "../../../fakes/sandbox/service.ts";
import {
  ProbeRunError,
  createCapabilityProbe,
} from "../probe/capability-probe.ts";
import { Hono } from "hono";
import { runCanary as runDeployCanary } from "../probe/canary.ts";
import { withProbeEndpoint } from "../probe/probe-endpoint.ts";
import { mountProbeRoute } from "../probe/route.ts";
import { parseProbeOutput } from "../probe/verdict.ts";
import { DISPATCHER_TOKEN } from "../test-support/harness.ts";
import {
  recordingLogger,
  type RecordedLogger,
} from "../test-support/harness.ts";
import { ManualClock, settle } from "../test-support/manual-clock.ts";
import {
  createSandboxCanary,
  type SandboxCanaryOptions,
} from "./sandbox-canary.ts";
import { createSandboxLauncher } from "./sandbox.ts";
import {
  SANDBOX_FAILURE_KINDS,
  SandboxServiceError,
  type SandboxFailureKind,
} from "./sandbox-service.ts";

const IMAGE_ID = `sha256:${"a".repeat(64)}`;
const OTHER_IMAGE_ID = `sha256:${"b".repeat(64)}`;
const SNAPSHOT_ID = "snap_dummy_golden_0001";
const PASSING = `${JSON.stringify({ version: 1, engines: ["pr-agent", "opencode"], reasons: [] })}\n`;
const DENYING = `${JSON.stringify({ version: 1, engines: ["pr-agent"], reasons: ["ipv6_not_disabled"] })}\n`;

let service: FakeSandboxService;
let clock: ManualClock;
let logger: RecordedLogger;

beforeEach(() => {
  service = new FakeSandboxService();
  service.onExec("image-id", { stdout: `${IMAGE_ID}\n` });
  service.onExec("probe", { stdout: PASSING });
  clock = new ManualClock();
  logger = recordingLogger();
});

function canary(overrides: Partial<SandboxCanaryOptions> = {}) {
  return createSandboxCanary({
    service,
    snapshotId: SNAPSHOT_ID,
    imageDigest: IMAGE_ID,
    logger,
    clock,
    config: {},
    ...overrides,
  });
}

const signal = () => new AbortController().signal;
const valuesOf = (args: readonly string[], flag: string) =>
  args.flatMap((arg, index) => (arg === flag ? [args[index + 1] ?? ""] : []));
const probeCall = () => service.execs.find((call) => call.label === "probe");

async function failure(run: Promise<string>): Promise<ProbeRunError> {
  try {
    await run;
  } catch (error) {
    expect(error).toBeInstanceOf(ProbeRunError);
    return error as ProbeRunError;
  }
  throw new Error("the probe was expected to fail");
}

describe("the canary VM of the capability probe", () => {
  // #331-T01
  it("clones a VM from the golden snapshot, prepares it like a job VM, runs the probe and stops the VM", async () => {
    const stdout = await canary()(signal());

    expect(stdout).toBe(PASSING);
    expect(service.creates).toHaveLength(1);
    const [created] = service.creates;
    expect(created).toMatchObject({
      snapshotId: SNAPSHOT_ID,
      region: "fra1",
      persistent: false,
      vcpus: 1,
    });
    expect(created?.name).toMatch(/^cr-canary-[a-z0-9]{8}$/);
    expect(created?.tags).toStrictEqual({
      app: "code-reviewer",
      kind: "canary",
      job: "canary",
    });
    expect(service.events).toStrictEqual([
      `create:${created?.name}`,
      "exec:vm-prepare",
      "exec:image-id",
      "exec:probe",
      `stop:${created?.name}`,
    ]);
    expect(service.running()).toStrictEqual([]);
  });

  // #331-T01
  it("runs the probe with the real hardened flags of the Dynamic-Worker, from the image id, in its `probe` mode", async () => {
    await canary()(signal());

    const call = probeCall();
    expect(call).toMatchObject({ cmd: "docker", sudo: true });
    const args = call?.args ?? [];
    expect(args[0]).toBe("run");
    expect(args).toContain("--read-only");
    expect(args).toContain("--rm");
    expect(valuesOf(args, "--cap-drop")).toStrictEqual(["ALL"]);
    expect(valuesOf(args, "--cap-add")).toStrictEqual([
      "SETUID",
      "SETGID",
      "KILL",
      "CHOWN",
      "DAC_OVERRIDE",
      "FOWNER",
      "NET_ADMIN",
      "SETPCAP",
    ]);
    expect(valuesOf(args, "--security-opt")).toStrictEqual([
      "no-new-privileges:true",
    ]);
    expect(valuesOf(args, "--sysctl")).toStrictEqual([
      "net.ipv6.conf.all.disable_ipv6=1",
      "net.ipv6.conf.default.disable_ipv6=1",
    ]);
    expect(valuesOf(args, "--network")).toStrictEqual(["bridge"]);
    expect(valuesOf(args, "--memory")).toStrictEqual(["1536m"]);
    expect(valuesOf(args, "--tmpfs")).toHaveLength(3);
    expect(args.slice(-2)).toStrictEqual([IMAGE_ID, "probe"]);
    expect(args).not.toContain("--privileged");
    expect(args).not.toContain("--volume");
    expect(args).not.toContain("--device");
  });

  // #331-T01
  it("uses the VM size and the memory limit that a Dynamic job gets, from the configuration", async () => {
    await canary({
      config: {
        launcher: { vcpus: 2 },
        container: { memory: { limit: "3g", reservation: "2g", swap: "3g" } },
      },
    })(signal());

    expect(service.creates[0]?.vcpus).toBe(2);
    expect(valuesOf(probeCall()?.args ?? [], "--memory")).toStrictEqual(["3g"]);
  });

  // #331-T01
  it("gives the probe the Dynamic environment of a job, so that it proves the configuration the job will have", async () => {
    await canary({
      environment: {
        RUNNER_DYNAMIC_CAPABILITIES: '{"tool_choice_required":true}',
        RUNNER_DYNAMIC_MAX_COST_USD: "2.5",
      },
    })(signal());

    const environment = valuesOf(probeCall()?.args ?? [], "--env");
    expect(environment).toContain("RUNNER_DYNAMIC_MAX_COST_USD=2.5");
    expect(environment).toContain(
      'RUNNER_DYNAMIC_CAPABILITIES={"tool_choice_required":true}',
    );
    expect(environment).toContain("HOME=/home/runner");
  });

  // #331-T05
  it("sends no credential, no URL and no token to the canary VM", async () => {
    await canary()(signal());

    const text = service.requestText();
    expect(text).not.toMatch(
      /crj_|Bearer|RUNNER_TOKEN|RUNNER_API_URL|appUrl|credential/,
    );
    expect(service.stdinOf(service.creates[0]?.name ?? "")).toBe("");
  });

  // #331-T01
  it("sets a VM timeout beyond the probe's own as the backstop that ends a VM nobody stopped", async () => {
    await canary({ timeoutSeconds: 150, vmTimeoutMarginSeconds: 180 })(
      signal(),
    );

    expect(service.creates[0]?.timeoutMs).toBe((150 + 180) * 1000);
  });

  // #331-T02
  it.each<[SandboxFailureKind, string]>([
    ["rate_limited", "sandbox_rate_limited"],
    ["quota_exceeded", "sandbox_quota_exceeded"],
    ["network", "sandbox_network"],
    ["unavailable", "sandbox_unavailable"],
    ["not_ready", "image_not_ready"],
    ["snapshot_missing", "sandbox_snapshot_missing"],
    ["region_mismatch", "sandbox_region_mismatch"],
    ["rejected", "sandbox_rejected"],
    ["auth_failed", "sandbox_auth_failed"],
  ])(
    "fails with the launch code of a refused create (%s: %s)",
    async (kind, code) => {
      service.failNextCreate(new SandboxServiceError(kind));

      const error = await failure(canary()(signal()));

      expect(error.code).toBe(code);
      expect(service.execs).toHaveLength(0);
    },
  );

  // #331-T02
  it("covers every failure kind of the port", () => {
    expect(SANDBOX_FAILURE_KINDS).toHaveLength(9);
  });

  // #331-T02
  it("fails with a code of its own and without the text of an error it does not know", async () => {
    service.failNextCreate(new Error("secret platform text 12345"));

    const error = await failure(canary()(signal()));

    expect(error.code).toBe("sandbox_create_failed");
    expect(logger.text()).not.toContain("12345");
  });

  // #331-T02
  it("stops the VM and fails when the daemon does not become ready", async () => {
    service.onExec("vm-prepare", { exitCode: 1 });

    const error = await failure(canary()(signal()));

    expect(error.code).toBe("docker_not_ready");
    expect(service.stops).toStrictEqual([service.creates[0]?.name]);
    expect(probeCall()).toBeUndefined();
  });

  // #473-T03
  it("logs a stable code and the tail of the stderr of a failed vm-prepare.sh", async () => {
    service.onExec("vm-prepare", {
      exitCode: 1,
      stderr:
        "vm-prepare: cgroup_root_busy tries=100 last_error=Device or resource busy\n",
    });

    await failure(canary()(signal()));

    const line = logger.lines.find((entry) =>
      entry.startsWith("warn vm_prepare_failed "),
    );
    expect(line).toContain('"code":"docker_not_ready"');
    expect(line).toContain('"exitCode":1');
    expect(line).toContain('"canary":true');
    expect(line).toContain("cgroup_root_busy tries=100");
  });

  // #331-T02
  it("refuses an image that is not the configured one: a probe of another image proves nothing", async () => {
    service.onExec("image-id", { stdout: `${OTHER_IMAGE_ID}\n` });

    const error = await failure(canary()(signal()));

    expect(error.code).toBe("image_mismatch");
    expect(probeCall()).toBeUndefined();
    expect(service.running()).toStrictEqual([]);
  });

  // #331-T02
  it("fails when the probe container exits with an error, whatever it printed, and never logs its output", async () => {
    service.onExec("probe", {
      exitCode: 2,
      stdout: `${JSON.stringify({ version: 1, engines: ["pr-agent", "opencode"], reasons: [] })}\n`,
      stderr: "token ghp_" + "0123456789abcdef0123456789abcdef0123",
    });

    const error = await failure(canary()(signal()));

    expect(error.code).toBe("probe_exit_nonzero");
    expect(service.running()).toStrictEqual([]);
    expect(logger.text()).not.toContain("ghp_");
  });

  // #331-T02
  it("fails when the command could not be run to its end (the platform's timeout, a lost connection)", async () => {
    service.onExec("probe", () => {
      throw new Error("the command timed out");
    });

    const error = await failure(canary()(signal()));

    expect(error.code).toBe("probe_exec_failed");
    expect(service.running()).toStrictEqual([]);
  });

  // #331-T02
  it("stops the VM when the probe is aborted, whatever step it is in, and stays quiet when the stop fails", async () => {
    const hold = service.holdNextCreate();
    const controller = new AbortController();
    const running = canary()(controller.signal);
    await settle();
    controller.abort();

    const error = await failure(running);
    hold.release();

    expect(error.code).toBe("probe_aborted");
    expect(service.stops).toStrictEqual([service.creates[0]?.name]);

    service.failStops(new Error("platform text 777"));
    await failure(canary()(controller.signal));
    expect(logger.text()).not.toContain("777");
  });

  // #331-T08
  it("hands the output on unread and keeps it out of the log: reading it is the probe's job", async () => {
    const secret = "ghp_" + "0123456789abcdef0123456789abcdef0123";
    service.onExec("probe", { stdout: `${secret}\n${PASSING}` });

    const stdout = await canary()(signal());

    expect(stdout).toContain(secret);
    expect(logger.text()).not.toContain(secret);
  });
});

describe("a Sandbox-Launcher with the probe endpoint over its canary VM (#479)", () => {
  function behind(stdout: string, options: { forceReuseMs?: number } = {}) {
    service.onExec("probe", { stdout });
    const launcher = createSandboxLauncher({
      service,
      snapshotId: SNAPSHOT_ID,
      imageDigest: IMAGE_ID,
      logger,
      clock,
    });
    const probe = createCapabilityProbe({
      run: canary(),
      clock,
      now: () => clock.now(),
      logger,
      ...options,
    });
    return { probed: withProbeEndpoint({ launcher, probe }) };
  }

  // #479-T04
  it("advertises opencode to a dispatch without any canary VM: only the deploy canary's POST /probe makes one", async () => {
    const { probed } = behind(PASSING);

    expect(await probed.capabilities(signal())).toStrictEqual([
      "pr-agent",
      "opencode",
    ]);
    expect(await probed.capabilities(signal())).toStrictEqual([
      "pr-agent",
      "opencode",
    ]);

    expect(service.creates).toStrictEqual([]);
  });

  // #331-T01
  it("proves opencode with a canary VM when the deploy canary asks, and stops the VM", async () => {
    const { probed } = behind(PASSING);

    expect(await probed.probe?.(signal())).toMatchObject({
      status: "passed",
      engines: ["pr-agent", "opencode"],
    });

    expect(service.creates).toHaveLength(1);
    expect(service.running()).toStrictEqual([]);
  });

  // #331-T02
  it("reports a denial of the canary container to the deploy canary", async () => {
    const { probed } = behind(DENYING);

    expect(await probed.probe?.(signal())).toMatchObject({
      status: "denied",
      reasons: ["ipv6_not_disabled"],
    });
  });

  // #331-T02
  it("reports a canary VM that cannot be created, and probes again once the reuse time is over", async () => {
    const { probed } = behind(PASSING);
    service.failNextCreate(new SandboxServiceError("unavailable"));

    expect(await probed.probe?.(signal())).toMatchObject({
      status: "failed",
      engines: ["pr-agent"],
    });
    await clock.advance(61_000);

    expect(await probed.probe?.(signal())).toMatchObject({
      status: "passed",
      engines: ["pr-agent", "opencode"],
    });
    expect(service.creates).toHaveLength(2);
  });

  // #331-T06
  it("runs one canary VM for any number of forced probes at once", async () => {
    const { probed } = behind(PASSING);

    const calls = [probed.probe?.(signal()), probed.probe?.(signal())];
    await settle();
    await Promise.all(calls);

    expect(service.creates).toHaveLength(1);
  });
});

// #765: a deployment that serves the Implementer has the canary prove it, in a container of the Implementer's profile.
describe("the canary VM of a deployment that serves the Implementer (#765)", () => {
  const WITH_IMPLEMENTER = `${JSON.stringify({ version: 1, engines: ["pr-agent", "opencode", "implementer"], reasons: [] })}\n`;
  const WITHOUT_IMPLEMENTER = `${JSON.stringify({ version: 1, engines: ["pr-agent", "opencode"], reasons: ["implementer_work_dir_not_exec"] })}\n`;
  const implementerCall = () =>
    service.execs.find((call) => call.label === "probe-implementer");

  function serving(overrides: Partial<SandboxCanaryOptions> = {}) {
    return canary({ implementer: { config: {} }, ...overrides });
  }

  it("runs a second probe in the same VM, after the work volume is made, in the Implementer's profile", async () => {
    service.onExec("probe-implementer", { stdout: WITH_IMPLEMENTER });

    await serving()(signal());

    expect(service.creates).toHaveLength(1);
    const labels = service.execs.map((call) => call.label);
    expect(labels).toStrictEqual([
      "vm-prepare",
      "image-id",
      "probe",
      "work-volume-dir",
      "work-volume-mount",
      "work-volume-options",
      "work-volume-check",
      "work-volume-create",
      "probe-implementer",
    ]);
    const args = implementerCall()?.args ?? [];
    expect(args.join(" ")).toMatch(
      /--mount type=volume,source=code-reviewer-work-canary-[a-z0-9]{8},target=\/work/,
    );
    expect(args).toContain("--read-only");
    expect(valuesOf(args, "--env")).toEqual(
      expect.arrayContaining([
        "RUNNER_IMPLEMENTER_WORK_DIR=/work",
        "RUNNER_IMPLEMENTER_NETWORK=registries",
      ]),
    );
    expect(args.at(-1)).toBe("probe");
    expect(args).toContain(IMAGE_ID);
    expect(service.running()).toStrictEqual([]);
    // The Dynamic probe stays what it was: no work volume in it.
    expect(probeCall()?.args.join(" ")).not.toContain("type=volume");
    expect(probeCall()?.args.join(" ")).not.toContain("RUNNER_IMPLEMENTER");
  });

  it("answers one verdict that holds `implementer` only when the Implementer's container proved it", async () => {
    service.onExec("probe-implementer", { stdout: WITH_IMPLEMENTER });
    const proven = parseProbeOutput(await serving()(signal()));
    service.onExec("probe-implementer", { stdout: WITHOUT_IMPLEMENTER });
    const refused = parseProbeOutput(await serving()(signal()));

    expect(proven?.engines).toStrictEqual([
      "pr-agent",
      "opencode",
      "implementer",
    ]);
    expect(refused?.engines).toStrictEqual(["pr-agent", "opencode"]);
    expect(refused?.reasons).toStrictEqual(["implementer_work_dir_not_exec"]);
  });

  it("does not let a failure of the Dynamic container be hidden by the Implementer's", async () => {
    service.onExec("probe", { stdout: DENYING });
    service.onExec("probe-implementer", { stdout: WITH_IMPLEMENTER });

    const verdict = parseProbeOutput(await serving()(signal()));

    expect(verdict?.passed).toBe(false);
    expect(verdict?.engines).not.toContain("opencode");
    expect(verdict?.engines).not.toContain("implementer");
  });

  it("reports an Implementer container that does not answer as a probe failure, and stops the VM", async () => {
    service.onExec("probe-implementer", { exitCode: 2 });

    expect((await failure(serving()(signal()))).code).toBe(
      "probe_exit_nonzero",
    );
    service.onExec("work-volume-create", { exitCode: 1 });
    expect((await failure(serving()(signal()))).code).toBe(
      "work_volume_failed",
    );
    expect(service.running()).toStrictEqual([]);
  });

  it("does nothing more for a deployment without the kind: one probe, no work volume", async () => {
    await canary()(signal());

    expect(implementerCall()).toBeUndefined();
    expect(
      service.execs.filter((call) => call.label.startsWith("work-volume")),
    ).toStrictEqual([]);
    expect(service.execs.filter((call) => call.label === "probe")).toHaveLength(
      1,
    );
  });
});

/** The deploy canary (`pnpm probe:canary`) reading this answer of `POST /probe`, with its default `--engines`. */
async function runCanary(
  report: unknown,
  status: number,
  lines: string[],
): Promise<number> {
  const answer: typeof fetch = (input) =>
    Promise.resolve(
      String(input).endsWith("/health")
        ? new Response("{}")
        : new Response(JSON.stringify(report), { status }),
    );
  return runDeployCanary({
    url: "https://dispatcher.example",
    token: DISPATCHER_TOKEN,
    fetch: answer,
    clock: { sleep: () => Promise.resolve() },
    write: (line) => lines.push(line),
  });
}

// #765: the whole chain behind `POST /probe`: the Launcher, its canary, the endpoint and the route.
describe("POST /probe of a Sandbox-Launcher that serves the Implementer (#765)", () => {
  const WITH_IMPLEMENTER = `${JSON.stringify({ version: 1, engines: ["pr-agent", "opencode", "implementer"], reasons: [] })}\n`;
  const LACKING = `${JSON.stringify({ version: 1, engines: ["pr-agent", "opencode"], reasons: [] })}\n`;

  async function probeRoute(options: {
    serves: boolean;
    implementerStdout: string;
  }) {
    service.onExec("probe-implementer", { stdout: options.implementerStdout });
    const launcher = createSandboxLauncher({
      service,
      snapshotId: SNAPSHOT_ID,
      imageDigest: IMAGE_ID,
      logger,
      clock,
      ...(options.serves ? { servesImplementer: true } : {}),
    });
    const probe = createCapabilityProbe({
      run: canary(options.serves ? { implementer: { config: {} } } : {}),
      clock,
      now: () => clock.now(),
      logger,
    });
    const app = new Hono();
    mountProbeRoute(app, {
      token: "operator-token-for-the-tests-0000000001",
      engines: options.serves
        ? ["pr-agent", "opencode", "implementer"]
        : ["pr-agent", "opencode"],
      launcher: withProbeEndpoint({ launcher, probe }),
      logger,
    });
    const response = await app.request("/probe", {
      method: "POST",
      headers: {
        authorization: "Bearer operator-token-for-the-tests-0000000001",
      },
    });
    return {
      status: response.status,
      body: (await response.json()) as Record<string, unknown>,
    };
  }

  it("answers 200 and names `implementer` when the canary proved it", async () => {
    const { status, body } = await probeRoute({
      serves: true,
      implementerStdout: WITH_IMPLEMENTER,
    });

    expect(status).toBe(200);
    expect(body).toMatchObject({
      ok: true,
      status: "passed",
      engines: ["pr-agent", "opencode", "implementer"],
      required: ["pr-agent", "opencode", "implementer"],
    });
  });

  it("answers 503 when the report lacks `implementer`, and the deploy canary blocks with `missing`", async () => {
    const { status, body } = await probeRoute({
      serves: true,
      implementerStdout: LACKING,
    });

    expect(status).toBe(503);
    expect(body).toMatchObject({
      ok: false,
      required: ["pr-agent", "opencode", "implementer"],
    });
    expect(body.engines).not.toContain("implementer");
    const lines: string[] = [];
    const code = await runCanary(body, status, lines);
    expect(code).toBe(1);
    expect(lines.join("\n")).toContain("missing=implementer");
  });

  it("is unchanged for a deployment without the kind: 200 with no `implementer` anywhere, one canary probe", async () => {
    const { status, body } = await probeRoute({
      serves: false,
      implementerStdout: "not read",
    });

    expect(status).toBe(200);
    expect(body).toMatchObject({
      ok: true,
      engines: ["pr-agent", "opencode"],
      required: ["pr-agent", "opencode"],
    });
    expect(
      service.execs.some((call) => call.label === "probe-implementer"),
    ).toBe(false);
  });

  it("makes the deploy canary pass on a deployment with the kind and its default `--engines`", async () => {
    const { status, body } = await probeRoute({
      serves: true,
      implementerStdout: WITH_IMPLEMENTER,
    });
    const lines: string[] = [];

    expect(await runCanary(body, status, lines)).toBe(0);
    expect(lines.join("\n")).toContain("engines=pr-agent,opencode,implementer");
  });
});
