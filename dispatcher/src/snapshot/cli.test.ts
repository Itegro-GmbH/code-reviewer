// SPDX-License-Identifier: LicenseRef-Proprietary

import { describe, expect, it } from "vitest";
import { FakeSandboxService } from "../../../fakes/vercel-sandbox/service.ts";
import {
  IMAGE_ID,
  SYSBOX_PREPARE_TEXT,
  VM_PREPARE_TEXT,
  happyFake,
} from "../test-support/snapshot-harness.ts";
import { runCli } from "./cli.ts";
import type { CliDeps, VercelCredentials } from "./cli.ts";
import { STEPS } from "./scripts.ts";

const TOKEN = "dummy-vercel-token-0123456789abcdef";
const ENV = {
  VERCEL_TOKEN: TOKEN,
  VERCEL_TEAM_ID: "team_dummy",
  VERCEL_PROJECT_ID: "prj_dummy",
};
const ARGS = [
  "--context",
  "ctx.tgz",
  "--vm-prepare",
  "vm-prepare.sh",
  "--sysbox-prepare",
  "sysbox-prepare.sh",
  "--out",
  "record.json",
];

type Harness = {
  deps: CliDeps;
  fake: FakeSandboxService;
  stdout: string[];
  stderr: string[];
  files: Map<string, string>;
  credentials: (VercelCredentials | undefined)[];
};

function harness(
  options: {
    env?: Record<string, string>;
    fake?: FakeSandboxService;
    files?: Record<string, string>;
  } = {},
): Harness {
  const fake = options.fake ?? happyFake();
  const files = new Map<string, string>(
    Object.entries({
      "ctx.tgz": "tarball-bytes",
      "vm-prepare.sh": VM_PREPARE_TEXT,
      "sysbox-prepare.sh": SYSBOX_PREPARE_TEXT,
      ...options.files,
    }),
  );
  const stdout: string[] = [];
  const stderr: string[] = [];
  const credentials: (VercelCredentials | undefined)[] = [];
  const deps: CliDeps = {
    env: options.env ?? ENV,
    stdout: (text) => stdout.push(text),
    stderr: (line) => stderr.push(line),
    readFile: (path) => {
      const content = files.get(path);
      if (content === undefined) throw new Error("ENOENT");
      return new TextEncoder().encode(content);
    },
    writeFile: (path, text) => void files.set(path, text),
    removeFile: (path) => void files.delete(path),
    createService: (given) => {
      credentials.push(given);
      return fake;
    },
    clock: () => new Date("2026-10-15T18:00:00.000Z"),
  };
  return { deps, fake, stdout, stderr, files, credentials };
}

describe("the snapshot command", () => {
  it("builds, writes the record file and prints the record", async () => {
    const h = harness();
    const code = await runCli(ARGS, h.deps);
    expect(code).toBe(0);
    const written = JSON.parse(h.files.get("record.json") ?? "null") as Record<
      string,
      unknown
    >;
    expect(written).toMatchObject({
      version: 1,
      imageDigest: IMAGE_ID,
      builtAt: "2026-10-15T18:00:00.000Z",
      region: "fra1",
      target: "sandbox",
    });
    expect(JSON.parse(h.stdout.join(""))).toEqual(written);
    expect(h.fake.callsFor(STEPS.buildImage)).toHaveLength(1);
  });

  // #330-T02
  it("hands the Vercel token to the platform client and to nothing else", async () => {
    const h = harness();
    await runCli(ARGS, h.deps);
    expect(h.credentials).toEqual([
      { token: TOKEN, teamId: "team_dummy", projectId: "prj_dummy" },
    ]);
    expect(h.fake.requestText()).not.toContain(TOKEN);
    expect(h.stdout.join("\n")).not.toContain(TOKEN);
    expect(h.stderr.join("\n")).not.toContain(TOKEN);
    expect(h.files.get("record.json")).not.toContain(TOKEN);
  });

  // #330-T02
  it("masks the token when the platform puts it in an error", async () => {
    const fake = happyFake();
    fake.failNextCreate(new Error(`401 Unauthorized for token ${TOKEN}`));
    const h = harness({ fake });
    const code = await runCli(ARGS, h.deps);
    expect(code).toBe(1);
    expect(h.stderr.join("\n")).not.toContain(TOKEN);
    expect(h.stderr.join("\n")).toContain("builder_create_failed");
    expect(h.files.has("record.json")).toBe(false);
  });

  // #330-T02
  it("uses the platform's own credentials (OIDC) when no token is configured", async () => {
    const h = harness({ env: {} });
    expect(await runCli(ARGS, h.deps)).toBe(0);
    expect(h.credentials).toEqual([undefined]);
  });

  // #330-T02
  it.each([["VERCEL_TEAM_ID"], ["VERCEL_PROJECT_ID"]])(
    "refuses a token without %s, naming the variable and nothing else",
    async (missing) => {
      const env: Record<string, string> = { ...ENV };
      delete env[missing];
      const h = harness({ env });
      expect(await runCli(ARGS, h.deps)).toBe(2);
      expect(h.stderr.join("\n")).toContain(missing);
      expect(h.stderr.join("\n")).not.toContain(TOKEN);
      expect(h.fake.vms.size).toBe(0);
    },
  );

  it("fails with exit 1, a stable code and no record file when the pipeline fails", async () => {
    const fake = happyFake();
    fake.onExec(STEPS.probe, {
      stdout:
        '{"version":1,"engines":["pr-agent"],"reasons":["capabilities_not_dropped"]}\n',
    });
    const h = harness({ fake });
    expect(await runCli(ARGS, h.deps)).toBe(1);
    const log = h.stderr.join("\n");
    expect(log).toContain("engine_missing");
    expect(log).toContain("capabilities_not_dropped");
    expect(h.files.has("record.json")).toBe(false);
    expect(h.stdout).toEqual([]);
  });

  it("removes a record file of an earlier run before it starts, so a failure leaves no stale record", async () => {
    const fake = happyFake();
    fake.onExec(STEPS.probe, { exitCode: 1 });
    const h = harness({
      fake,
      files: { "record.json": '{"snapshotId":"old"}' },
    });
    expect(await runCli(ARGS, h.deps)).toBe(1);
    expect(h.files.has("record.json")).toBe(false);
  });

  it("passes the options on: target, dockerfile, versions, commit, snapshots to keep", async () => {
    const h = harness();
    const code = await runCli(
      [
        ...ARGS,
        "--target",
        "dynamic",
        "--dockerfile",
        "runner/Dockerfile",
        "--docker-version",
        "29.2.0",
        "--buildx-version",
        "0.31.0",
        "--commit",
        "abcdef0",
        "--keep",
        "3",
        "--pin-snapshot",
        "snap_in_use",
        "--pin-snapshot",
        "snap_other",
      ],
      h.deps,
    );
    expect(code).toBe(0);
    const build = h.fake.callsFor(STEPS.buildImage)[0];
    expect(build?.script).toContain("--target 'dynamic'");
    expect(h.fake.callsFor(STEPS.installDocker)[0]?.script).toContain(
      "docker.io=29.2.0*",
    );
    expect(JSON.parse(h.files.get("record.json") ?? "{}")).toMatchObject({
      target: "dynamic",
      commit: "abcdef0",
    });
  });

  it.each([
    [
      [
        "--context",
        "ctx.tgz",
        "--vm-prepare",
        "vm-prepare.sh",
        "--sysbox-prepare",
        "sysbox-prepare.sh",
      ],
      "--out",
    ],
    [
      [
        "--vm-prepare",
        "vm-prepare.sh",
        "--sysbox-prepare",
        "sysbox-prepare.sh",
        "--out",
        "record.json",
      ],
      "--context",
    ],
    [
      [
        "--context",
        "ctx.tgz",
        "--sysbox-prepare",
        "sysbox-prepare.sh",
        "--out",
        "record.json",
      ],
      "--vm-prepare",
    ],
    [
      [
        "--context",
        "ctx.tgz",
        "--vm-prepare",
        "vm-prepare.sh",
        "--out",
        "record.json",
      ],
      "--sysbox-prepare",
    ],
    [[...ARGS, "--keep", "zero"], "--keep"],
    [[...ARGS, "--keep"], "--keep"],
    [[...ARGS, "--commit", "not a sha"], "--commit"],
    [[...ARGS, "--target", "x;y"], "--target"],
    [[...ARGS, "--unknown", "1"], "--unknown"],
  ])(
    "exits with 2 and names the option on bad usage: %j",
    async (argv, option) => {
      const h = harness();
      expect(await runCli(argv, h.deps)).toBe(2);
      expect(h.stderr.join("\n")).toContain(option);
      expect(h.fake.vms.size).toBe(0);
      expect(h.files.has("record.json")).toBe(false);
    },
  );

  it("does not echo a refused value", async () => {
    const h = harness();
    await runCli([...ARGS, "--target", "super-secret-looking;value"], h.deps);
    expect(h.stderr.join("\n")).not.toContain("super-secret-looking");
  });

  it("exits with 2 when an input file cannot be read, before it creates anything", async () => {
    const h = harness();
    h.files.delete("ctx.tgz");
    expect(await runCli(ARGS, h.deps)).toBe(2);
    expect(h.stderr.join("\n")).toContain("--context");
    expect(h.fake.vms.size).toBe(0);
  });

  it("exits with 2 when the Sysbox boot script cannot be read, before it creates anything", async () => {
    const h = harness();
    h.files.delete("sysbox-prepare.sh");
    expect(await runCli(ARGS, h.deps)).toBe(2);
    expect(h.stderr.join("\n")).toContain("--sysbox-prepare");
    expect(h.fake.vms.size).toBe(0);
  });

  // #403-T17
  it("leaves the builders of earlier runs alone with --skip-retention: the deployment pipeline cleans up after it is live", async () => {
    const fake = happyFake();
    const old = fake.seedBuilder(
      "code-reviewer-golden-builder-20260101T000000Z",
      1,
    );
    const older = fake.seedBuilder(
      "code-reviewer-golden-builder-20260201T000000Z",
      2,
    );
    const h = harness({ fake });

    expect(await runCli([...ARGS, "--skip-retention"], h.deps)).toBe(0);

    const live = fake.liveSnapshotIds();
    expect(live).toContain(old);
    expect(live).toContain(older);
    expect(live).toHaveLength(3);
    expect(h.stderr.join("\n")).not.toContain("retention_removed");
  });

  // #403-T17
  it("still removes the check VM with --skip-retention", async () => {
    const fake = happyFake();
    const h = harness({ fake });

    await runCli([...ARGS, "--skip-retention"], h.deps);

    expect(
      [...fake.vms.values()].filter(
        (vm) =>
          vm.name.startsWith("code-reviewer-golden-check-") &&
          vm.state !== "deleted",
      ),
    ).toEqual([]);
  });

  it("prints retention warnings as log lines and still succeeds", async () => {
    const fake = happyFake();
    fake.seedBuilder("code-reviewer-golden-builder-20260101T000000Z", 1, false);
    const h = harness({ fake });
    expect(await runCli(ARGS, h.deps)).toBe(0);
    expect(h.stderr.join("\n")).toContain("builder_without_snapshot");
  });

  it("names what it could not clean up", async () => {
    const fake = happyFake();
    fake.onExec(STEPS.probe, { exitCode: 1 });
    fake.failDestroyOf("code-reviewer-golden-builder-20261015T180000Z");
    const h = harness({ fake });
    expect(await runCli(ARGS, h.deps)).toBe(1);
    expect(h.stderr.join("\n")).toContain(
      "code-reviewer-golden-builder-20261015T180000Z",
    );
  });
});
