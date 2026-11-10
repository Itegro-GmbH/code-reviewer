// SPDX-License-Identifier: LicenseRef-Proprietary

// `node manifest-main.ts --dir <release dir> --out <manifest.json> --release N --commit <sha> ...`: writes the manifest of a build (#976). The files are in
// <release dir> under the names below; the manifest is NOT signed here (the signing key is only in the release job, docs/runner.md, "VM artifacts").
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { buildManifest, describeFile } from "./manifest-build.ts";
import type { Unpacker } from "./manifest-build.ts";
import { ManifestSchema } from "./manifest.ts";
import type { Manifest } from "./manifest.ts";

const { values } = parseArgs({
  options: {
    dir: { type: "string" },
    out: { type: "string" },
    release: { type: "string" },
    commit: { type: "string" },
    "kernel-version": { type: "string" },
    "firecracker-version": { type: "string" },
    "rootfs-info": { type: "string" },
    images: { type: "string" },
  },
});
const need = (name: keyof typeof values): string => {
  const value = values[name] as string | undefined;
  if (!value) {
    console.error(`manifest-main: --${name} is required`);
    process.exit(2);
  }
  return value;
};

/** `zstd -dc` into a hash: the unpacked file is gigabytes and is never written. */
const unpack: Unpacker = (path) =>
  new Promise((resolve, reject) => {
    const child = spawn("zstd", ["-dc", path], {
      stdio: ["ignore", "pipe", "inherit"],
    });
    const hash = createHash("sha256");
    let size = 0;
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      hash.update(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0
        ? resolve({ size, sha256: hash.digest("hex") })
        : reject(new Error(`zstd -dc ended with ${code}`)),
    );
  });

const dir = need("dir");
const kernelVersion = need("kernel-version");
const files: Manifest["files"] = {
  kernel: await describeFile(dir, "vmlinux"),
  rootfs: await describeFile(dir, "rootfs.ext4.zst", { unpack }),
  dockerData: await describeFile(dir, "dockerdata.ext4.zst", { unpack }),
  kernelSource: await describeFile(dir, `linux-${kernelVersion}.tar.xz`),
  kernelConfig: await describeFile(dir, "kernel.config"),
  kernelBaseConfig: await describeFile(dir, "fc-base.config"),
  kernelFragment: await describeFile(dir, "config.fragment"),
  packages: await describeFile(dir, "packages.txt"),
};
const rootfs = JSON.parse(
  readFileSync(need("rootfs-info"), "utf8"),
) as Manifest["components"];
const imagesFile = JSON.parse(
  readFileSync(need("images"), "utf8"),
) as Manifest["images"];
const manifest = buildManifest({
  release: Number(need("release")),
  commit: need("commit"),
  builtAt: new Date(),
  files,
  kernel: {
    version: kernelVersion,
    sourceSha256: files.kernelSource.sha256,
    baseConfigSha256: files.kernelBaseConfig.sha256,
    fragmentSha256: files.kernelFragment.sha256,
    configSha256: files.kernelConfig.sha256,
  },
  firecrackerVersion: need("firecracker-version"),
  rootfs,
  images: { worker: imagesFile.worker, agent: imagesFile.agent },
});
// The files of a release must leave room for GitHub's limit of 2 GiB per release asset.
for (const [role, entry] of Object.entries(manifest.files))
  if (entry.size > 2000 * 1024 * 1024) {
    console.error(
      `manifest-main: ${role} is ${entry.size} bytes, over what a release asset can hold (2 GiB)`,
    );
    process.exit(1);
  }
writeFileSync(
  need("out"),
  `${JSON.stringify(ManifestSchema.parse(manifest), null, 2)}\n`,
);
console.error(
  `manifest-main: wrote ${values.out} (release ${manifest.release})`,
);
