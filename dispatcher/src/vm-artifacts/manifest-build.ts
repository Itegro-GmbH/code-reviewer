// SPDX-License-Identifier: LicenseRef-Proprietary

// Assembles the manifest of a build (#976) from what the build measured: the files with their size and sha256, the kernel's inputs, what the
// root file system reports as installed and the image ids of the data disk. The CLI (manifest-main.ts) does the reading; this is the shape.
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { RELEASE_BOOT_ARGS, RELEASE_INIT_COMMAND } from "./boot.ts";
import { MANIFEST_VERSION, ManifestSchema } from "./manifest.ts";
import type { FileEntry, Manifest } from "./manifest.ts";
import { sha256File } from "./verify.ts";

export type Unpacker = (
  path: string,
) => Promise<{ size: number; sha256: string }>;

/** The entry of one file of the release's directory. A compressed file is also unpacked through `unpack`, to record what it holds. */
export async function describeFile(
  dir: string,
  name: string,
  options: { unpack?: Unpacker } = {},
): Promise<FileEntry> {
  const path = join(dir, name);
  const entry: FileEntry = {
    name,
    size: (await stat(path)).size,
    sha256: await sha256File(path),
  };
  if (options.unpack) entry.uncompressed = await options.unpack(path);
  return entry;
}

export type BuildInput = {
  release: number;
  commit: string;
  builtAt: Date;
  files: Manifest["files"];
  kernel: Omit<Manifest["kernel"], "bootArgs" | "initCommand">;
  firecrackerVersion: string;
  /** What the root file system's build reported (rootfs-info.json). */
  rootfs: Manifest["components"];
  images: Manifest["images"];
};

export function buildManifest(input: BuildInput): Manifest {
  return ManifestSchema.parse({
    version: MANIFEST_VERSION,
    release: input.release,
    arch: "x86_64",
    builtAt: input.builtAt.toISOString(),
    commit: input.commit,
    files: input.files,
    kernel: {
      ...input.kernel,
      bootArgs: RELEASE_BOOT_ARGS,
      initCommand: RELEASE_INIT_COMMAND,
    },
    firecracker: { version: input.firecrackerVersion },
    components: input.rootfs,
    images: input.images,
  });
}
