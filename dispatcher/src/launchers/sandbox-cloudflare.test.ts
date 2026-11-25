// SPDX-License-Identifier: LicenseRef-Proprietary

// The Sandbox-Launcher on the Cloudflare placement (#1158, epic #1157): the same steps as on Vercel (create, the run directories, IPv6 off, `vm-prepare.sh`,
// the image check, `sysbox-prepare.sh`, the work volume, `docker run`), against the double of the cf-sandbox API, with what differs: the image id comes from the
// Worker's health, the reserve disk is 2 GiB, the Worker container gets the intercept CA, the VM's name carries the placement, and a job that names the
// placement without the configuration, or for a size nobody configured, is refused before a VM exists.
import { beforeEach, describe, expect, it } from "vitest";
import { FakeCfSandbox } from "../../../fakes/cf-sandbox/service.ts";
import { FakeSandboxService } from "../../../fakes/sandbox/service.ts";
import { LaunchError, type LaunchSpec, type Launcher } from "../core/types.ts";
import { ManualClock, settle } from "../test-support/manual-clock.ts";
import {
  recordingLogger,
  type RecordedLogger,
} from "../test-support/harness.ts";
import { createCfSandboxService } from "./cf-sandbox.ts";
import { createPlacementPlatform } from "./placement.ts";
import {
  CLOUDFLARE_IMAGE,
  SANDBOX_HANDOVER_SECONDS,
  createSandboxLauncher,
  type SandboxLauncherOptions,
} from "./sandbox.ts";

const TOKEN = "t".repeat(40);
const IMAGE_ID = `sha256:${"c".repeat(64)}`;
const VERCEL_IMAGE_ID = `sha256:${"a".repeat(64)}`;
const CREDENTIAL = "crj_dummy-credential-0123456789-abcdefghijklmnopq";
const JOB_ID = "00000000-0000-4000-8000-000000000001";

let vercel: FakeSandboxService;
let cf: FakeCfSandbox;
let clock: ManualClock;
let logger: RecordedLogger;

beforeEach(() => {
  vercel = new FakeSandboxService();
  vercel.onExec("image-id", { stdout: `${VERCEL_IMAGE_ID}\n` });
  cf = new FakeCfSandbox({
    token: TOKEN,
    workerImageId: IMAGE_ID,
    workerFeatures: ["implementer_workspace_token"],
  });
  cf.onExec("image-id", { exitCode: 0, stdout: `${IMAGE_ID}\n` });
  clock = new ManualClock();
  logger = recordingLogger();
});

function client() {
  return createCfSandboxService({
    baseUrl: "https://cr-sandbox.example",
    token: TOKEN,
    instanceTypes: new Map([[4, "standard-4"]]),
    fetch: cf.fetch,
  });
}

function build(overrides: Partial<SandboxLauncherOptions> = {}): Launcher {
  const cloudflare = client();
  return createSandboxLauncher({
    service: createPlacementPlatform({ vercel, cloudflare, logger }),
    snapshotId: "snap_dummy_golden_0001",
    imageDigest: VERCEL_IMAGE_ID,
    logger,
    clock,
    cloudflare: {
      health: async () => cloudflare.health(),
      sizes: [4],
      sysboxProof: "proven",
    },
    ...overrides,
  });
}

function spec(overrides: Partial<LaunchSpec> = {}): LaunchSpec {
  return {
    appId: "reviewer",
    appUrl: "https://app.example.invalid",
    jobId: JOB_ID,
    credential: CREDENTIAL,
    kind: "implementer",
    timeoutSeconds: 3600,
    config: {},
    vcpus: 4,
    placement: "cloudflare",
    ...overrides,
  };
}

async function launch(
  launcher: Launcher,
  launchSpec: LaunchSpec = spec(),
  signal: AbortSignal = new AbortController().signal,
): Promise<{ ok: true } | { ok: false; error: unknown }> {
  const ended = launcher.launch(launchSpec, signal).then(
    () => ({ ok: true }) as const,
    (error: unknown) => ({ ok: false, error }) as const,
  );
  // The calls are real (the double of the API answers on the event loop), the hand-over wait is the manual clock's.
  for (let step = 0; step < 50; step += 1)
    await new Promise((r) => setTimeout(r, 2));
  await settle();
  await clock.advance(SANDBOX_HANDOVER_SECONDS * 1000);
  return ended;
}

const labels = () =>
  cf.requests
    .filter((r) => r.method === "POST" && r.path.endsWith("/exec"))
    .map((r) => (r.body as { label: string }).label);

const run = () =>
  cf.requests.find(
    (r) =>
      r.path.endsWith("/processes") &&
      (r.body as { label: string }).label === "docker-run",
  )?.body as { args: string[] } | undefined;

describe("the Sandbox-Launcher on the Cloudflare placement", () => {
  // #1158-L01
  it("creates the VM on Cloudflare with the instance type of its size and a name that carries the placement, and nothing on Vercel", async () => {
    const result = await launch(build());

    expect(result).toStrictEqual({ ok: true });
    const [created] = [...cf.vms.values()];
    expect(created?.name).toMatch(
      new RegExp(`^cr-implementer-${JOB_ID}-cf-[0-9a-f]{8}$`),
    );
    expect(created?.instanceType).toBe("standard-4");
    expect(created?.tags).toEqual({
      app: "code-reviewer",
      kind: "implementer",
      job: JOB_ID,
      tenant: "reviewer",
    });
    expect(vercel.creates).toEqual([]);
    expect(CLOUDFLARE_IMAGE).toBe("cloudflare-image");
  });

  // #1158-L02
  it("runs the steps of the golden snapshot in their order, with a reserve disk of 2 GiB", async () => {
    await launch(build());

    expect(labels()).toEqual([
      "run-directories",
      "run-directory-docker",
      "run-directory-containerd",
      "ipv6-off",
      "vm-prepare",
      "image-id",
      "sysbox-prepare",
      "work-volume-dir",
      "work-volume-reserve-image",
      "work-volume-reserve-fs",
      "work-volume-reserve-mount",
      "work-volume-mount",
      "work-volume-options",
      "work-volume-check",
      "work-volume-create",
    ]);
    const reserve = cf.requests.find(
      (r) =>
        (r.body as { label?: string } | undefined)?.label ===
        "work-volume-reserve-image",
    );
    expect((reserve?.body as { args: string[] }).args).toContain("2G");
  });

  // #1158-L03
  it("checks the Worker image in the VM against the id the Worker's health names, not the snapshot's", async () => {
    expect(await launch(build())).toStrictEqual({ ok: true });
    const checked = cf.requests.find(
      (r) => (r.body as { label?: string } | undefined)?.label === "image-id",
    );
    expect((checked?.body as { args: string[] }).args).toContain(
      "code-reviewer-worker:golden",
    );

    cf = new FakeCfSandbox({ token: TOKEN, workerImageId: IMAGE_ID });
    cf.onExec("image-id", { exitCode: 0, stdout: `${VERCEL_IMAGE_ID}\n` });
    const mismatch = await launch(build());
    expect(mismatch.ok).toBe(false);
    expect((mismatch as { error: LaunchError }).error.code).toBe(
      "image_mismatch",
    );
    // The VM that failed its check is stopped: nothing is left running.
    expect(cf.vms.size).toBe(0);
  });

  // #1158-L04
  it("starts the Worker container with the image id, the intercept CA bundle and its variables, the credential only on stdin, and the proof of the placement", async () => {
    await launch(build());

    const args = run()?.args ?? [];
    expect(args).toContain(IMAGE_ID);
    expect(args).toContain(
      "type=bind,source=/etc/cr-sandbox/ca-bundle.crt,target=/etc/cr-sandbox/ca-bundle.crt,readonly",
    );
    for (const name of [
      "SSL_CERT_FILE",
      "REQUESTS_CA_BUNDLE",
      "CURL_CA_BUNDLE",
      "NODE_EXTRA_CA_CERTS",
      "GIT_SSL_CAINFO",
    ])
      expect(args).toContain(`${name}=/etc/cr-sandbox/ca-bundle.crt`);
    expect(args).toContain("RUNNER_IMPLEMENTER_SANDBOX_PROOF=proven");
    expect(cf.requestText()).not.toContain(CREDENTIAL);
    expect(cf.stdinOf([...cf.vms.keys()][0] ?? "")).toContain(CREDENTIAL);
  });

  // #1158-L05
  it("passes the Sysbox proof of the placement, `unproven` when it is configured so", async () => {
    await launch(
      build({
        cloudflare: {
          health: async () => client().health(),
          sizes: [4],
          sysboxProof: "unproven",
        },
      }),
    );

    expect(run()?.args).toContain("RUNNER_IMPLEMENTER_SANDBOX_PROOF=unproven");
  });

  // #1158-L06
  it("refuses a Cloudflare job without the configuration, a size nobody configured, or for a review, before any VM exists", async () => {
    const without = await launch(build({ cloudflare: undefined }));
    expect((without as { error: LaunchError }).error.code).toBe(
      "sandbox_placement_unavailable",
    );

    const size = await launch(build(), spec({ vcpus: 8 }));
    expect((size as { error: LaunchError }).error.code).toBe(
      "sandbox_size_unsupported",
    );

    const review = await launch(build(), spec({ kind: "diff" }));
    expect((review as { error: LaunchError }).error.code).toBe(
      "sandbox_placement_unavailable",
    );
    expect(
      cf.requests.filter((r) => r.path === "/v1/vms" && r.method === "POST"),
    ).toEqual([]);
  });

  // #1158-L07
  it("fails retryable, before any VM exists, when the Worker's health cannot be read or names no image id", async () => {
    cf.healthDown();
    const down = await launch(build());
    const error = (down as { error: LaunchError }).error;
    expect(error.code).toBe("sandbox_unavailable");
    expect(error.retryable).toBe(true);

    cf = new FakeCfSandbox({ token: TOKEN, workerImageId: null });
    const noImage = await launch(build());
    expect((noImage as { error: LaunchError }).error.code).toBe(
      "sandbox_unavailable",
    );
    expect(cf.vms.size).toBe(0);
  });

  // #1158-L08
  it("stops the VM by name on its fleet when a step fails", async () => {
    cf.onExec("vm-prepare", { exitCode: 1, stderr: "boom" });

    const result = await launch(build());

    expect((result as { error: LaunchError }).error.code).toBe(
      "docker_not_ready",
    );
    expect(cf.vms.size).toBe(0);
    expect(cf.requests.some((r) => r.method === "DELETE")).toBe(true);
    expect(vercel.stops ?? []).toEqual([]);
  });

  // #1158-L09
  it("is the launch it was on Vercel for a job that names no placement: no call to Cloudflare, the snapshot and the 8 GiB reserve", async () => {
    const result = await launch(
      build(),
      spec({ placement: undefined, vcpus: 4 }),
    );

    expect(result).toStrictEqual({ ok: true });
    expect(cf.requests).toEqual([]);
    expect(vercel.creates[0]?.snapshotId).toBe("snap_dummy_golden_0001");
    expect(vercel.creates[0]?.name).not.toContain("-cf-");
  });
});
