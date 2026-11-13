// SPDX-License-Identifier: LicenseRef-Proprietary

// The manifest of a release of the Linux VM artifacts (#976): what the local Dispatcher boots a job in. It names every file with its size
// and sha256, the versions the recipe installed, and the image ids of the data disk. It is signed as a whole (verify.ts); the files are
// checked against it. The shape follows the runner's release manifest (docs/runner.md, "Updates (R2)"): a release number that only
// grows, ECDSA over P-256, a detached signature.
import { z } from "zod";

export const MANIFEST_VERSION = 1;
/** A manifest is read whole before its signature is checked: a cap keeps a hostile address from filling memory. */
export const MAX_MANIFEST_BYTES = 256 * 1024;

/**
 * What a release holds. `kernel`, `rootfs` and `dockerData` are what a job boots; the rest is the source offer of the GPL parts
 * (the kernel's source, its configuration and the fragment that makes it ours) and the list of the packages in the root file system.
 */
export const ARTIFACT_ROLES = [
  "kernel",
  "rootfs",
  "dockerData",
  "kernelSource",
  "kernelConfig",
  "kernelBaseConfig",
  "kernelFragment",
  "packages",
] as const;
export type ArtifactRole = (typeof ARTIFACT_ROLES)[number];

const SHA256 = z.string().regex(/^[0-9a-f]{64}$/);
const IMAGE_ID = z.string().regex(/^sha256:[0-9a-f]{64}$/);
/** A file name in the release's directory: no separator, no leading dot. */
const FILE_NAME = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/);
const SIZE = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const VERSION_TEXT = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9.+~:_-]{0,63}$/);

const FileEntrySchema = z
  .strictObject({
    name: FILE_NAME,
    size: SIZE,
    sha256: SHA256,
    /** Present for a compressed file: the size and digest of what it unpacks to (the host checks the unpacked file too). */
    uncompressed: z.strictObject({ size: SIZE, sha256: SHA256 }).optional(),
  })
  .refine((entry) => !entry.name.endsWith(".zst") || entry.uncompressed, {
    message: "a .zst file needs the size and digest of what it unpacks to",
  });
export type FileEntry = z.infer<typeof FileEntrySchema>;

const ImageSchema = z.strictObject({
  tag: z.string().min(3).max(128),
  id: IMAGE_ID,
});

export const ManifestSchema = z.strictObject({
  version: z.literal(MANIFEST_VERSION),
  /** Grows with every release. A host takes only a release higher than the one it runs and higher than one it rolled back from. */
  release: z.number().int().min(1),
  arch: z.literal("x86_64"),
  builtAt: z.iso.datetime(),
  commit: z.string().regex(/^[0-9a-f]{40}$/),
  files: z.strictObject({
    kernel: FileEntrySchema,
    rootfs: FileEntrySchema,
    dockerData: FileEntrySchema,
    kernelSource: FileEntrySchema,
    kernelConfig: FileEntrySchema,
    kernelBaseConfig: FileEntrySchema,
    kernelFragment: FileEntrySchema,
    packages: FileEntrySchema,
  }),
  kernel: z.strictObject({
    version: VERSION_TEXT,
    sourceSha256: SHA256,
    baseConfigSha256: SHA256,
    fragmentSha256: SHA256,
    configSha256: SHA256,
    /** The kernel's command line without a console, the way a release runs (the serial console costs 0.3 to 0.4 s of every boot). */
    bootArgs: z.string().min(1).max(1024),
    /** What follows `init=` and `--`: PID 1 and its arguments. The launcher puts the job's own parameters before `--`. */
    initCommand: z.string().min(1).max(256),
  }),
  /** The Firecracker release the smoke boot ran on. */
  firecracker: z.strictObject({ version: VERSION_TEXT }),
  /** What the recipe installed, as the root file system reports it (dpkg), next to what the hosted snapshot pins. */
  components: z.strictObject({
    ubuntuBase: VERSION_TEXT,
    dockerd: VERSION_TEXT,
    buildx: VERSION_TEXT,
    sysbox: VERSION_TEXT,
    sysboxSha256: SHA256,
  }),
  /** The ids the guest's Docker reports for the images on the data disk (`docker image inspect --format '{{.Id}}'`). */
  images: z.strictObject({ worker: ImageSchema, agent: ImageSchema }),
});
export type Manifest = z.infer<typeof ManifestSchema>;
