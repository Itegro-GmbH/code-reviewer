// SPDX-License-Identifier: LicenseRef-Proprietary

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  REGENERATE_COMMAND,
  TYPE_TARGETS,
  checkGenerated,
  generateTypes,
  writeGenerated,
} from "./generate.ts";

const REPOSITORY = join(import.meta.dirname, "..", "..", "..", "..");
const temporary: string[] = [];

function scratch(): string {
  const directory = mkdtempSync(join(tmpdir(), "contract-types-"));
  temporary.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporary.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("the generated contract types", () => {
  // #318-T02
  it("are the ones committed in app/src/contracts and dispatcher/src/contracts", async () => {
    const result = await checkGenerated(REPOSITORY);

    expect(result.stale).toStrictEqual([]);
    expect(result.message).toBe("");
  });

  // #318-T02
  it("fail the check with the command to regenerate when a committed file differs", async () => {
    const root = scratch();
    await writeGenerated(root);
    const victim = join(
      root,
      TYPE_TARGETS[0]?.directory ?? "",
      "worker-api.ts",
    );
    writeFileSync(
      victim,
      `${readFileSync(victim, "utf8")}\nexport type Drift = 1;\n`,
    );

    const result = await checkGenerated(root);

    expect(result.stale).toStrictEqual([
      join(TYPE_TARGETS[0]?.directory ?? "", "worker-api.ts"),
    ]);
    expect(result.message).toContain(REGENERATE_COMMAND);
    expect(REGENERATE_COMMAND).toBe("make generate-contracts");
  });

  // #318-T02
  it("fail the check when a committed file is missing", async () => {
    const root = scratch();
    await writeGenerated(root);
    rmSync(join(root, TYPE_TARGETS[1]?.directory ?? "", "dispatch-webhook.ts"));

    const result = await checkGenerated(root);

    expect(result.stale).toStrictEqual([
      join(TYPE_TARGETS[1]?.directory ?? "", "dispatch-webhook.ts"),
    ]);
  });

  // #318-T02
  it("fail the check when a generated file is left over from a removed schema", async () => {
    const root = scratch();
    await writeGenerated(root);
    const leftover = join(root, TYPE_TARGETS[0]?.directory ?? "", "removed.ts");
    mkdirSync(dirname(leftover), { recursive: true });
    writeFileSync(leftover, "export type Old = 1;\n");

    const result = await checkGenerated(root);

    expect(result.stale).toStrictEqual([
      join(TYPE_TARGETS[0]?.directory ?? "", "removed.ts"),
    ]);
  });

  // #318-T02
  it("are identical for both projects apart from nothing: one source, two copies", async () => {
    const files = await generateTypes();
    const byTarget = TYPE_TARGETS.map((target) =>
      files
        .filter((file) => file.path.startsWith(`${target.directory}/`))
        .map((file) => file.content),
    );

    expect(TYPE_TARGETS.map((t) => t.directory)).toStrictEqual([
      "app/src/contracts",
      "dispatcher/src/contracts",
    ]);
    expect(byTarget[0]?.length).toBeGreaterThan(0);
    expect(byTarget[0]).toStrictEqual(byTarget[1]);
  });

  // #318-T02
  it("carry the SPDX header, name their source and the command, and never reach the network", async () => {
    const files = await generateTypes();

    for (const file of files) {
      expect(
        file.content.startsWith(
          "// SPDX-License-Identifier: LicenseRef-Proprietary\n",
        ),
      ).toBe(true);
      expect(file.content).toContain(REGENERATE_COMMAND);
      expect(file.content).toMatch(/contracts\/[a-z-]+\.v1\.json/);
    }
    expect(files.map((f) => f.path).sort()).toStrictEqual(
      TYPE_TARGETS.flatMap((t) =>
        [
          "dispatch-webhook",
          "environment-control",
          "runner-api",
          "worker-api",
          "worker-container",
        ].map((name) => `${t.directory}/${name}.ts`),
      ).sort(),
    );
  });

  // #318-T02
  it("type the definitions by the names of the schema", async () => {
    const files = await generateTypes();
    const text = (name: string) =>
      files.find((f) => f.path === `app/src/contracts/${name}.ts`)?.content ??
      "";

    expect(text("dispatch-webhook")).toContain(
      "export interface DispatchWebhook",
    );
    expect(text("worker-api")).toContain(
      "export interface WorkerJobDetailsResponse",
    );
    expect(text("runner-api")).toContain("export interface SplitClaimResponse");
    expect(text("worker-container")).toContain(
      "export interface WorkerContainerSpec",
    );
    // #975
    expect(text("environment-control")).toContain(
      "export interface NarrowRequest",
    );
  });
});
