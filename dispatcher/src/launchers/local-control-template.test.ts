// SPDX-License-Identifier: LicenseRef-Proprietary

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CONTROL_TEMPLATE_PATH,
  controlTemplateDocument,
  fillControlTemplate,
} from "./local-control-template.ts";
import { renderLocalControl } from "./local-control.ts";
import { planForKind } from "./sandbox.ts";

const IMAGE_ID = `sha256:${"ab".repeat(32)}`;
// The image operand of the golden file of #977.
const GOLDEN_IMAGE = `registry.invalid/code-reviewer-worker@sha256:${"0".repeat(64)}`;

function golden(name: string): string[] {
  return JSON.parse(
    readFileSync(new URL(`./testdata/${name}`, import.meta.url), "utf8"),
  ) as string[];
}

describe("the Control template the local Dispatcher's launcher fills (#978)", () => {
  // #978-T02
  it("is the file the Python launcher reads: regenerate it with local-control-template-main.ts when this fails", async () => {
    const onDisk = readFileSync(CONTROL_TEMPLATE_PATH, "utf8");

    expect(onDisk).toBe(await controlTemplateDocument());
  });

  // #978-T02
  it("fills to exactly the arguments the TypeScript renderer renders for a job (the golden file of #977)", async () => {
    const template = JSON.parse(await controlTemplateDocument()) as {
      arguments: string[];
      agentMemoryMb: Record<string, number>;
    };
    const filled = fillControlTemplate(template, {
      jobId: "job-1",
      image: GOLDEN_IMAGE,
      timeoutSeconds: 3600,
      vcpus: 2,
    });

    expect(filled).toEqual(golden("docker-run.local-control.golden.json"));
  });

  // #978-T02
  it("fills to what the renderer renders for another job, timeout and size", async () => {
    const template = JSON.parse(await controlTemplateDocument()) as {
      arguments: string[];
      agentMemoryMb: Record<string, number>;
    };
    const plan = planForKind("implementer", { launcher: { vcpus: 4 } });
    const { args } = await renderLocalControl({
      spec: {
        appId: "app-2",
        appUrl: "https://app.example",
        jobId: "0f3c8a52-0000-4000-8000-000000000002",
        credential: "crj_dummy-credential-0123456789",
        kind: "implementer",
        timeoutSeconds: 1800,
        config: {},
      },
      image: IMAGE_ID,
      plan,
      sysboxProof: "proven",
    });

    expect(
      fillControlTemplate(template, {
        jobId: "0f3c8a52-0000-4000-8000-000000000002",
        image: IMAGE_ID,
        timeoutSeconds: 1800,
        vcpus: 4,
      }),
    ).toEqual(args);
  });

  // #978-T02
  it("leaves no marker unfilled and holds no credential", async () => {
    const template = JSON.parse(await controlTemplateDocument()) as {
      arguments: string[];
      agentMemoryMb: Record<string, number>;
    };
    const filled = fillControlTemplate(template, {
      jobId: "job-1",
      image: IMAGE_ID,
      timeoutSeconds: 3600,
      vcpus: 2,
    });

    expect(filled.join("\n")).not.toMatch(/[{}]/);
    expect(filled.join("\n")).not.toContain("crj_");
  });
});
