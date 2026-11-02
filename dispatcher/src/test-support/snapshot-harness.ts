// SPDX-License-Identifier: LicenseRef-Proprietary

// What the golden snapshot tests share: a Sandbox double scripted for a successful run, and the standard
// input of a run. Dummy values only.
import { FakeSandboxService } from "../../../fakes/vercel-sandbox/service.ts";
import { resolveConfig } from "../snapshot/config.ts";
import type { PipelineConfig } from "../snapshot/config.ts";
import type { PipelineInput } from "../snapshot/pipeline.ts";
import { STEPS } from "../snapshot/scripts.ts";

export const IMAGE_ID = `sha256:${"a".repeat(64)}`;
export const OTHER_IMAGE_ID = `sha256:${"b".repeat(64)}`;
export const AGENT_IMAGE_ID = `sha256:${"d".repeat(64)}`;
export const PROBE_OK =
  '{"version":1,"engines":["pr-agent","opencode"],"reasons":[]}\n';
export const MANIFEST_HASH = "c".repeat(64);
export const MANIFEST_OK = `MANIFEST_SHA256 ${MANIFEST_HASH}\n`;
export const VM_PREPARE_TEXT = "#!/usr/bin/env bash\n# stand-in vm-prepare\n";
export const SYSBOX_PREPARE_TEXT =
  "#!/usr/bin/env bash\n# stand-in sysbox-prepare\n";
export const SYSBOX_PROBE_OK =
  "SYSBOX_PROBE ok boot\nSYSBOX_PROBE ok inner_docker\nSYSBOX_PROBE ok inner_container\nSYSBOX_PROBE ok network_control\nSYSBOX_PROBE ok network_isolated\nSYSBOX_PROBE_DONE\n";

/** A Sandbox double that answers every step of a successful run. */
export function happyFake(): FakeSandboxService {
  const fake = new FakeSandboxService();
  fake.onExec(STEPS.recordBaseManifest, { stdout: MANIFEST_OK });
  fake.onExec(STEPS.inspectImage, { stdout: `${IMAGE_ID}\n` });
  fake.onExec(STEPS.inspectAgentImage, { stdout: `${AGENT_IMAGE_ID}\n` });
  fake.onExec(STEPS.checkNoContainers, { stdout: "" });
  fake.onExec(STEPS.scanFilesystem, { stdout: "SCAN_DONE\n" });
  fake.onExec(STEPS.inspectRestoredImage, { stdout: `${IMAGE_ID}\n` });
  fake.onExec(STEPS.inspectRestoredAgentImage, { stdout: `${AGENT_IMAGE_ID}\n` });
  fake.onExec(STEPS.probe, { stdout: PROBE_OK });
  fake.onExec(STEPS.sysboxProbe, { stdout: SYSBOX_PROBE_OK });
  return fake;
}

export function testConfig(
  overrides: Partial<PipelineConfig> = {},
): PipelineConfig {
  return resolveConfig(overrides);
}

export function testInput(
  overrides: Partial<PipelineInput> = {},
): PipelineInput {
  return {
    config: testConfig(),
    context: new Uint8Array([0x1f, 0x8b, 8, 0, 1, 2, 3]),
    vmPrepareScript: VM_PREPARE_TEXT,
    sysboxPrepareScript: SYSBOX_PREPARE_TEXT,
    commit: "0123456789abcdef0123456789abcdef01234567",
    ...overrides,
  };
}
