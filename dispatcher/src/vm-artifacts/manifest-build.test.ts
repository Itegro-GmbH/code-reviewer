// SPDX-License-Identifier: LicenseRef-Proprietary

import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildManifest, describeFile } from "./manifest-build.ts";
import { ARTIFACT_ROLES } from "./manifest.ts";
import { parseManifest } from "./verify.ts";

const sha = (text: string): string =>
  createHash("sha256").update(text).digest("hex");

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

describe("describing a file for the manifest", () => {
  // #976-T01
  it("takes the size and the sha256 of the bytes as they are", async () => {
    dir = mkdtempSync(join(tmpdir(), "describe-"));
    writeFileSync(join(dir, "vmlinux"), "kernel bytes");

    await expect(describeFile(dir, "vmlinux")).resolves.toEqual({
      name: "vmlinux",
      size: 12,
      sha256: sha("kernel bytes"),
    });
  });

  // #976-T01
  it("adds what a compressed file unpacks to, read through the unpacker it is given", async () => {
    dir = mkdtempSync(join(tmpdir(), "describe-"));
    writeFileSync(join(dir, "rootfs.ext4.zst"), "compressed");
    const unpack = async (): Promise<{ size: number; sha256: string }> => ({
      size: 99,
      sha256: sha("raw"),
    });

    await expect(
      describeFile(dir, "rootfs.ext4.zst", { unpack }),
    ).resolves.toEqual({
      name: "rootfs.ext4.zst",
      size: 10,
      sha256: sha("compressed"),
      uncompressed: { size: 99, sha256: sha("raw") },
    });
  });
});

describe("the manifest of a build", () => {
  // #976-T01
  it("is one that the verifier reads, with every role present", async () => {
    dir = mkdtempSync(join(tmpdir(), "describe-"));
    const files = {} as Record<
      string,
      Awaited<ReturnType<typeof describeFile>>
    >;
    for (const role of ARTIFACT_ROLES) {
      writeFileSync(join(dir, `${role}.bin`), `content ${role}`);
      files[role] = await describeFile(dir, `${role}.bin`);
    }

    const manifest = buildManifest({
      release: 3,
      commit: "a".repeat(40),
      builtAt: new Date("2026-11-10T12:00:00Z"),
      files: files as never,
      kernel: {
        version: "6.18.62",
        sourceSha256: "1".repeat(64),
        baseConfigSha256: "2".repeat(64),
        fragmentSha256: "3".repeat(64),
        configSha256: "4".repeat(64),
      },
      firecrackerVersion: "1.17.0",
      rootfs: {
        ubuntuBase: "26.04.1",
        dockerd: "29.1.3-0ubuntu1",
        buildx: "0.30.1-0ubuntu1",
        sysbox: "0.7.1-0.linux",
        sysboxSha256: "5".repeat(64),
      },
      images: {
        worker: { tag: "w:golden", id: `sha256:${"a".repeat(64)}` },
        agent: { tag: "a:golden", id: `sha256:${"b".repeat(64)}` },
      },
    });

    const text = `${JSON.stringify(manifest, null, 2)}\n`;
    expect(parseManifest(Buffer.from(text))).toEqual(manifest);
    expect(manifest.kernel.initCommand).toBe(
      "/usr/bin/docker-init -- /usr/local/sbin/vm-init",
    );
    expect(manifest.kernel.bootArgs).toContain("8250.nr_uarts=0");
  });
});
