// SPDX-License-Identifier: LicenseRef-Proprietary

// The golden snapshot pipeline (#330): a builder VM installs Docker, builds the Worker image from the commit's
// tarball (the spike's registry-free path), stops the daemon cleanly and snapshots; a second VM, created from
// that snapshot, proves what was snapshotted (a scan for secrets and job data, the image id, the hardened
// container's own self-check) before the record is returned. Fail closed: any failure after the snapshot was
// taken deletes it, and a record exists only for a snapshot that passed every check.
//
// The pipeline never runs job code and never receives a job credential or a registry credential. Its only
// credential, the platform token, belongs to the `SnapshotService` it is given; no command, file or log line
// of the pipeline carries it.
import { z } from "zod";
import type { Logger } from "../core/types.ts";
import type { PipelineConfig } from "./config.ts";
import { SnapshotPipelineError } from "./errors.ts";
import type { SnapshotErrorCode } from "./errors.ts";
import { GoldenRecordSchema } from "./record.ts";
import type { GoldenRecord } from "./record.ts";
import { BUILDER_PREFIX } from "./names.ts";
import { planRetention } from "./retention.ts";
import {
  EXIT_VERSION_MISMATCH,
  PATHS,
  SCAN_DONE,
  STEPS,
  SYSBOX_PROBE_DONE,
} from "./scripts.ts";
import {
  buildImageScript,
  checkNoContainersScript,
  cleanBuilderScript,
  daemonConfigJson,
  inspectAgentImageScript,
  inspectImageScript,
  installDockerScript,
  installHostScriptsScript,
  installSysboxScript,
  probeScript,
  recordBaseManifestScript,
  scanScript,
  startDaemonScript,
  stopDaemonScript,
  sysboxProbeScript,
  writeDaemonConfigScript,
} from "./scripts.ts";
import type { ExecResult, SandboxVm, SnapshotService } from "./service.ts";

export type PipelineInput = {
  config: PipelineConfig;
  /** A gzipped tar of the commit (`git archive`): the build context. */
  context: Uint8Array;
  /** The text of docker/sandbox/vm-prepare.sh. */
  vmPrepareScript: string;
  /** The text of docker/sandbox/sysbox-prepare.sh: installed beside it, run on the Implementer's VM only. */
  sysboxPrepareScript: string;
  /** The commit the context was made from, for the record. */
  commit?: string;
};

export type PipelineDeps = {
  service: SnapshotService;
  logger: Logger;
  clock?: () => Date;
  signal?: AbortSignal;
};

export type PipelineResult = {
  record: GoldenRecord;
  /** Stable codes of things that did not fail the run but need a look. */
  warnings: string[];
};

export { BUILDER_PREFIX };
const CHECK_PREFIX = "code-reviewer-golden-check-";
const TAG_APP = "code-reviewer";
const MANIFEST_HASH_LINE = /^MANIFEST_SHA256 ([0-9a-f]{64})$/m;
const IMAGE_ID = /^sha256:[0-9a-f]{64}$/;
const SAFE_WORD = /^[a-z0-9_]{1,64}$/;
const ENGINE_NAME = /^[a-z][a-z0-9_-]{0,31}$/;
const SAFE_PATH = /^[\x21-\x7e]{1,300}$/;
const SYSBOX_FAILURE = /^SYSBOX_PROBE fail ([a-z][a-z0-9_]{0,63})$/;
const MAX_ERROR_LINES = 20;
const MAX_ERROR_LINE = 200;

const VerdictSchema = z.strictObject({
  version: z.literal(1),
  engines: z.array(z.string().regex(ENGINE_NAME)).max(8),
  // Only reasons of the stable shape reach an error; anything else in the list is dropped, not echoed.
  reasons: z.array(z.string().max(200)).max(16),
});

function compactTime(date: Date): string {
  return date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
}

// Escape sequences of a terminal and the other control characters (a newline is kept for the split).
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/g;

/** The last lines of a command's error output, without control characters, each line cut: for a failure's detail. */
function tail(text: string): string[] {
  return text
    .replace(ANSI, "")
    .replace(CONTROL, "")
    .split("\n")
    .map((line) => line.trimEnd().slice(0, MAX_ERROR_LINE))
    .filter((line) => line.length > 0)
    .slice(-MAX_ERROR_LINES);
}

class Run {
  private builder: SandboxVm | undefined;
  private check: SandboxVm | undefined;
  private snapshotId: string | undefined;
  /** Whether Sysbox was installed in the builder, and whether the check VM proved it. Neither ever fails the run. */
  private sysboxInstalled = false;
  private sysboxProven = false;
  private readonly warnings: string[] = [];
  private readonly deps: PipelineDeps;
  private readonly input: PipelineInput;

  constructor(deps: PipelineDeps, input: PipelineInput) {
    this.deps = deps;
    this.input = input;
  }

  private get config(): PipelineConfig {
    return this.input.config;
  }

  async execute(): Promise<PipelineResult> {
    try {
      const record = await this.steps();
      return { record, warnings: this.warnings };
    } catch (error) {
      throw await this.fail(error);
    }
  }

  private async steps(): Promise<GoldenRecord> {
    const { config, deps } = this;
    const builtAt = (deps.clock ?? (() => new Date()))();
    const stamp = compactTime(builtAt);

    const builder = await this.createVm(
      "create_builder",
      "builder_create_failed",
      {
        name: `${BUILDER_PREFIX}${stamp}`,
        region: config.region,
        vcpus: config.builderVcpus,
        timeoutMs: config.builderTimeoutMs,
        tags: { app: TAG_APP, role: "golden-builder" },
        // A persistent sandbox is the one that can be snapshotted and keeps the snapshot it owns; it never runs a job.
        persistent: true,
      },
    );
    this.builder = builder;

    // Before anything is installed: what the scan later treats as the platform's own files. Its hash is kept
    // here, outside the VM, and the scan refuses a manifest that does not have it.
    const recorded = await this.exec(
      builder,
      STEPS.recordBaseManifest,
      recordBaseManifestScript(),
      "base_manifest_failed",
      { sudo: true, timeoutMs: 5 * 60_000 },
    );
    const manifestSha256 = MANIFEST_HASH_LINE.exec(recorded.stdout)?.[1];
    if (manifestSha256 === undefined)
      throw new SnapshotPipelineError(
        "base_manifest_failed",
        STEPS.recordBaseManifest,
        ["manifest_hash_unreadable"],
      );
    await this.exec(
      builder,
      STEPS.installDocker,
      installDockerScript(config),
      "docker_install_failed",
      {
        sudo: true,
        timeoutMs: 10 * 60_000,
        codes: { [EXIT_VERSION_MISMATCH]: "docker_version_mismatch" },
      },
    );
    // Before the daemon configuration is written: the package edits daemon.json and the pipeline's file replaces that.
    this.sysboxInstalled = await this.softStep(
      STEPS.installSysbox,
      "sysbox_install_failed",
      () =>
        this.exec(
          builder,
          STEPS.installSysbox,
          installSysboxScript(config),
          "sysbox_install_failed",
          { sudo: true, timeoutMs: 5 * 60_000 },
        ),
    );
    await this.write(
      builder,
      PATHS.daemonJson,
      daemonConfigJson(),
      "daemon_config_failed",
      STEPS.writeDaemonConfig,
    );
    await this.exec(
      builder,
      STEPS.writeDaemonConfig,
      writeDaemonConfigScript(),
      "daemon_config_failed",
      { sudo: true },
    );
    await this.write(
      builder,
      PATHS.vmPrepare,
      this.input.vmPrepareScript,
      "host_prepare_failed",
      STEPS.installHostScripts,
    );
    await this.write(
      builder,
      PATHS.sysboxPrepare,
      this.input.sysboxPrepareScript,
      "host_prepare_failed",
      STEPS.installHostScripts,
    );
    await this.exec(
      builder,
      STEPS.installHostScripts,
      installHostScriptsScript(),
      "host_prepare_failed",
      { sudo: true },
    );
    await this.exec(
      builder,
      STEPS.startDaemon,
      startDaemonScript(),
      "host_prepare_failed",
      {
        sudo: true,
        timeoutMs: 120_000,
      },
    );
    await this.write(
      builder,
      PATHS.context,
      this.input.context,
      "context_upload_failed",
      "upload_context",
    );
    await this.exec(
      builder,
      STEPS.buildImage,
      buildImageScript(config),
      "image_build_failed",
      {
        sudo: true,
        timeoutMs: 20 * 60_000,
      },
    );

    const imageDigest = await this.imageId(
      builder,
      STEPS.inspectImage,
      "image_build_failed",
    );
    const agentImageDigest = await this.imageId(
      builder,
      STEPS.inspectAgentImage,
      "image_build_failed",
      inspectAgentImageScript,
    );
    await this.exec(
      builder,
      STEPS.cleanBuilder,
      cleanBuilderScript(),
      "image_build_failed",
      {
        sudo: true,
        timeoutMs: 5 * 60_000,
      },
    );

    const containers = await this.exec(
      builder,
      STEPS.checkNoContainers,
      checkNoContainersScript(),
      "daemon_query_failed",
      {
        sudo: true,
      },
    );
    const ids = containers.stdout
      .split("\n")
      .filter((line) => line.trim() !== "");
    if (ids.length > 0) {
      // The ids are not logged: they say nothing a count does not.
      throw new SnapshotPipelineError(
        "containers_present",
        STEPS.checkNoContainers,
        [String(ids.length)],
      );
    }
    await this.exec(
      builder,
      STEPS.stopDaemon,
      stopDaemonScript(),
      "daemon_not_stopped",
      {
        sudo: true,
        timeoutMs: 120_000,
      },
    );

    const snapshotId = await this.takeSnapshot(builder);
    await this.verifySnapshot(
      snapshotId,
      stamp,
      imageDigest,
      agentImageDigest,
      manifestSha256,
    );

    const record = GoldenRecordSchema.safeParse({
      version: 1,
      snapshotId,
      imageDigest,
      agentImageDigest,
      builtAt: builtAt.toISOString(),
      region: config.region,
      target: config.target,
      ...(this.input.commit ? { commit: this.input.commit } : {}),
      sysbox: this.sysboxProven ? "proven" : "unproven",
    });
    if (!record.success)
      throw new SnapshotPipelineError("record_invalid", "record");
    await this.retire();
    this.deps.logger.info("golden_snapshot_ready", {
      snapshotId,
      target: config.target,
    });
    return record.data;
  }

  // ---- the snapshot ------------------------------------------------------------------------------

  private async takeSnapshot(builder: SandboxVm): Promise<string> {
    this.checkSignal("snapshot");
    this.deps.logger.info("step", { step: "snapshot" });
    let info;
    try {
      info = await builder.snapshot({ expirationMs: 0 }, this.deps.signal);
    } catch {
      throw this.stepError("snapshot_failed", "snapshot");
    }
    // From here on a failure deletes the snapshot: it exists, and nothing may publish it.
    this.snapshotId = info.snapshotId;
    if (info.status !== "created")
      throw new SnapshotPipelineError("snapshot_failed", "snapshot");
    if (!info.regions.includes(this.config.region))
      throw new SnapshotPipelineError("snapshot_region_mismatch", "snapshot", [
        this.config.region,
      ]);
    return info.snapshotId;
  }

  /** Proves the snapshot in a VM created from it, the way a job VM is: scan, daemon, image id, self-check. */
  private async verifySnapshot(
    snapshotId: string,
    stamp: string,
    imageDigest: string,
    agentImageDigest: string,
    manifestSha256: string,
  ): Promise<void> {
    const { config } = this;
    const check = await this.createVm("create_check_vm", "check_vm_failed", {
      name: `${CHECK_PREFIX}${stamp}`,
      region: config.region,
      vcpus: config.checkVcpus,
      timeoutMs: config.checkTimeoutMs,
      tags: { app: TAG_APP, role: "golden-check" },
      persistent: false,
      source: { type: "snapshot", snapshotId },
    });
    this.check = check;

    const scan = await this.exec(
      check,
      STEPS.scanFilesystem,
      scanScript({ manifestSha256 }),
      "scan_unreadable",
      {
        sudo: true,
        timeoutMs: 5 * 60_000,
      },
    );
    this.checkScan(scan.stdout);

    await this.exec(
      check,
      STEPS.startDaemonCheck,
      startDaemonScript(),
      "host_prepare_failed",
      {
        sudo: true,
        timeoutMs: 120_000,
      },
    );
    const restored = await this.imageId(
      check,
      STEPS.inspectRestoredImage,
      "image_digest_invalid",
    );
    if (restored !== imageDigest)
      throw new SnapshotPipelineError(
        "image_digest_mismatch",
        STEPS.inspectRestoredImage,
      );
    // The Implementer's agent image travels in the snapshot too, and must be the one that was built.
    const restoredAgent = await this.imageId(
      check,
      STEPS.inspectRestoredAgentImage,
      "image_digest_invalid",
      inspectAgentImageScript,
    );
    if (restoredAgent !== agentImageDigest)
      throw new SnapshotPipelineError(
        "image_digest_mismatch",
        STEPS.inspectRestoredAgentImage,
      );

    const probe = await this.exec(
      check,
      STEPS.probe,
      probeScript(config),
      "probe_failed",
      {
        sudo: true,
        timeoutMs: 4 * 60_000,
      },
    );
    this.checkVerdict(probe.stdout);
    await this.proveSysbox(check);
  }

  /**
   * The Sysbox proof (`sysboxProbeScript`) in the check VM. Soft: the snapshot is shared by every kind of job and reviews
   * do not use Sysbox, so a Sysbox that is broken on the platform (a new kernel, a new base image) must not hold back
   * a release of code-review.com (#797 is the same rule for the Implementer's proof of the Dispatcher). It becomes a warning
   * with the reasons in the log and `sysbox: "unproven"` in the record; the Implementer's boot step names the problem.
   */
  private async proveSysbox(check: SandboxVm): Promise<void> {
    if (!this.sysboxInstalled) return;
    this.sysboxProven = await this.softStep(
      STEPS.sysboxProbe,
      "sysbox_probe_failed",
      async () => {
        const result = await this.exec(
          check,
          STEPS.sysboxProbe,
          sysboxProbeScript(this.config),
          "sysbox_probe_failed",
          { sudo: true, timeoutMs: 5 * 60_000 },
        );
        const lines = result.stdout
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line !== "");
        const reasons = lines
          .map((line) => SYSBOX_FAILURE.exec(line)?.[1])
          .filter((reason): reason is string => reason !== undefined);
        if (lines.at(-1) !== SYSBOX_PROBE_DONE)
          throw new SnapshotPipelineError(
            "sysbox_probe_failed",
            STEPS.sysboxProbe,
            ["unreadable"],
          );
        if (reasons.length > 0)
          throw new SnapshotPipelineError(
            "sysbox_probe_failed",
            STEPS.sysboxProbe,
            reasons.slice(0, 8),
          );
      },
    );
  }

  /**
   * A step that may fail without failing the run: a failure is logged with its detail and kept as the warning of its code.
   * A cancelled run still ends the run.
   */
  private async softStep(
    step: string,
    code: SnapshotErrorCode,
    action: () => Promise<unknown>,
  ): Promise<boolean> {
    try {
      await action();
      return true;
    } catch (error) {
      if (this.deps.signal?.aborted)
        throw new SnapshotPipelineError("cancelled", step);
      this.warnings.push(code);
      this.deps.logger.warn(code, {
        step,
        detail:
          error instanceof SnapshotPipelineError
            ? error.detail
            : ["unexpected_error"],
      });
      return false;
    }
  }

  private checkScan(stdout: string): void {
    const lines = stdout
      .trimEnd()
      .split("\n")
      .map((line) => line.trimEnd());
    if (lines[lines.length - 1] !== SCAN_DONE)
      throw new SnapshotPipelineError("scan_unreadable", STEPS.scanFilesystem);
    const findings: string[] = [];
    for (const line of lines) {
      if (!line.startsWith("FINDING ")) continue;
      const [, kind, ...rest] = line.split(" ");
      const path = rest.join(" ");
      findings.push(
        kind !== undefined && SAFE_WORD.test(kind) && SAFE_PATH.test(path)
          ? `${kind} ${path}`
          : "unreadable_finding",
      );
    }
    if (findings.length > 0)
      throw new SnapshotPipelineError(
        "scan_findings",
        STEPS.scanFilesystem,
        findings,
      );
  }

  private checkVerdict(stdout: string): void {
    const last = stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "")
      .at(-1);
    let parsed: unknown;
    try {
      parsed = JSON.parse(last ?? "");
    } catch {
      throw new SnapshotPipelineError("probe_unreadable", STEPS.probe);
    }
    const verdict = VerdictSchema.safeParse(parsed);
    if (!verdict.success)
      throw new SnapshotPipelineError("probe_unreadable", STEPS.probe);
    const missing = this.config.requiredEngines.filter(
      (engine) => !verdict.data.engines.includes(engine),
    );
    if (missing.length > 0)
      throw new SnapshotPipelineError("engine_missing", STEPS.probe, [
        ...missing,
        ...verdict.data.reasons
          .filter((reason) => SAFE_WORD.test(reason))
          .slice(0, 8),
      ]);
  }

  // ---- retention ---------------------------------------------------------------------------------

  /** After the new snapshot passed: remove the builders (with their snapshots) beyond the current and previous ones. */
  private async retire(): Promise<void> {
    const { service, logger } = this.deps;
    if (!this.config.retention) {
      await this.deleteCheck();
      return;
    }
    try {
      const plan = planRetention(await service.listBuilders(BUILDER_PREFIX), {
        keep: this.config.keep,
        pinned: this.config.pinnedSnapshotIds,
      });
      if (plan.unmanaged.length > 0)
        this.warnings.push("builder_without_snapshot");
      let failed = false;
      for (const old of plan.remove) {
        try {
          await service.deleteBuilder(old.name);
          logger.info("retention_removed", { builder: old.name });
        } catch {
          failed = true;
          logger.warn("retention_failed", { builder: old.name });
        }
      }
      if (failed) this.warnings.push("retention_failed");
    } catch {
      logger.warn("retention_failed");
      this.warnings.push("retention_failed");
    }
    // The check VM is not persistent; its deletion is a courtesy that frees the name and the quota at once.
    await this.deleteCheck();
  }

  // ---- building blocks ---------------------------------------------------------------------------

  /** The error of a step whose call failed: `cancelled` when the run was aborted, else the step's own code. */
  private stepError(
    code: SnapshotErrorCode,
    step: string,
  ): SnapshotPipelineError {
    return new SnapshotPipelineError(
      this.deps.signal?.aborted ? "cancelled" : code,
      step,
    );
  }

  private checkSignal(step: string): void {
    if (this.deps.signal?.aborted)
      throw new SnapshotPipelineError("cancelled", step);
  }

  private async createVm(
    step: string,
    code: SnapshotErrorCode,
    options: Parameters<SnapshotService["createVm"]>[0],
  ): Promise<SandboxVm> {
    this.checkSignal(step);
    this.deps.logger.info("step", { step });
    try {
      return await this.deps.service.createVm(options, this.deps.signal);
    } catch {
      throw this.stepError(code, step);
    }
  }

  private async write(
    vm: SandboxVm,
    path: string,
    content: Uint8Array | string,
    code: SnapshotErrorCode,
    step: string,
  ): Promise<void> {
    this.checkSignal(step);
    try {
      await vm.writeFile(path, content, this.deps.signal);
    } catch {
      throw this.stepError(code, step);
    }
  }

  private async exec(
    vm: SandboxVm,
    label: string,
    script: string,
    code: SnapshotErrorCode,
    options: {
      sudo?: boolean;
      timeoutMs?: number;
      codes?: Record<number, SnapshotErrorCode>;
    } = {},
  ): Promise<ExecResult> {
    this.checkSignal(label);
    const started = Date.now();
    let result: ExecResult;
    try {
      result = await vm.run(
        { label, script, sudo: options.sudo, timeoutMs: options.timeoutMs },
        this.deps.signal,
      );
    } catch {
      throw this.stepError(code, label);
    }
    this.deps.logger.info("step", {
      step: label,
      exitCode: result.exitCode,
      seconds: Math.round((Date.now() - started) / 100) / 10,
    });
    if (result.exitCode !== 0)
      throw new SnapshotPipelineError(
        options.codes?.[result.exitCode] ?? code,
        label,
        [`exit ${result.exitCode}`, ...tail(result.stderr)],
      );
    return result;
  }

  private async imageId(
    vm: SandboxVm,
    label: string,
    code: SnapshotErrorCode,
    script: (config: PipelineConfig) => string = inspectImageScript,
  ): Promise<string> {
    const result = await this.exec(vm, label, script(this.config), code, {
      sudo: true,
    });
    const id = result.stdout.trim();
    if (!IMAGE_ID.test(id))
      throw new SnapshotPipelineError("image_digest_invalid", label);
    return id;
  }

  // ---- failure -----------------------------------------------------------------------------------

  private async deleteCheck(): Promise<void> {
    const check = this.check;
    this.check = undefined;
    if (!check) return;
    try {
      await check.destroy({ deleteSnapshots: false });
    } catch {
      // It stops by itself at its timeout and, not persistent, leaves nothing; only the name is reported.
      this.warnings.push("check_vm_not_deleted");
    }
  }

  /** Turns anything thrown into a pipeline error and removes what the run left, snapshot included. */
  private async fail(error: unknown): Promise<SnapshotPipelineError> {
    const failure =
      error instanceof SnapshotPipelineError
        ? error
        : this.deps.signal?.aborted
          ? new SnapshotPipelineError("cancelled", "unknown")
          : new SnapshotPipelineError("unexpected_error", "unknown");
    const leftovers: string[] = [];
    if (this.check) {
      try {
        await this.check.destroy({ deleteSnapshots: false });
      } catch {
        leftovers.push(this.check.name);
      }
    }
    if (this.builder) {
      try {
        // The builder owns the snapshot: deleting it with its snapshots is how a bad snapshot is withdrawn.
        await this.builder.destroy({ deleteSnapshots: true });
      } catch {
        leftovers.push(this.builder.name);
      }
    }
    failure.cleanupFailures = leftovers;
    this.deps.logger.error("golden_snapshot_failed", {
      code: failure.code,
      step: failure.step,
      detail: failure.detail,
      cleanupFailures: leftovers,
      snapshotWithdrawn:
        this.snapshotId !== undefined && leftovers.length === 0,
    });
    return failure;
  }
}

export async function runPipeline(
  deps: PipelineDeps,
  input: PipelineInput,
): Promise<PipelineResult> {
  if (deps.signal?.aborted)
    throw new SnapshotPipelineError("cancelled", "start");
  return new Run(deps, input).execute();
}
