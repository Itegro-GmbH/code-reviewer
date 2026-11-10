// SPDX-License-Identifier: LicenseRef-Proprietary

// The verifier of the VM artifacts (#976): a signature over the manifest's exact bytes, then every file against its size and digest.
// Small on purpose, and shared: the install and update of the local Dispatcher (#982) call it. Nothing but node:crypto is used, so the
// host needs no extra program. The signing key is the one of the release channel (`docker/vm/release-channel.json`), the same
// way as the runner's: ECDSA over P-256 with SHA-256, a DER signature, the public key as base64 of its SubjectPublicKeyInfo.
import { createHash, createPublicKey, verify } from "node:crypto";
import type { KeyObject } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import {
  ARTIFACT_ROLES,
  MAX_MANIFEST_BYTES,
  ManifestSchema,
} from "./manifest.ts";
import type { ArtifactRole, FileEntry, Manifest } from "./manifest.ts";

/** Stable codes: a caller branches on them, the text never carries a path of the host or the content of a file. */
export const VM_ARTIFACTS_ERROR_CODES = [
  "manifest_too_large",
  "manifest_invalid",
  "key_invalid",
  "signature_invalid",
  "release_not_newer",
  "file_missing",
  "size_mismatch",
  "digest_mismatch",
] as const;
export type VmArtifactsErrorCode = (typeof VM_ARTIFACTS_ERROR_CODES)[number];

export class VmArtifactsError extends Error {
  readonly code: VmArtifactsErrorCode;
  /** Short context: the role of the file, never a value of the host. */
  readonly detail: readonly string[];

  constructor(code: VmArtifactsErrorCode, detail: readonly string[] = []) {
    super(detail.length > 0 ? `${code}: ${detail.join(" ")}` : code);
    this.name = "VmArtifactsError";
    this.code = code;
    this.detail = detail;
  }
}

/** The channel's key. Refused unless it is an ECDSA key over P-256: another algorithm is a mistake or a downgrade, never a fallback. */
function channelKey(publicKey: string): KeyObject {
  let key: KeyObject;
  try {
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(publicKey))
      throw new Error("not base64");
    key = createPublicKey({
      key: Buffer.from(publicKey, "base64"),
      format: "der",
      type: "spki",
    });
  } catch {
    throw new VmArtifactsError("key_invalid");
  }
  if (
    key.asymmetricKeyType !== "ec" ||
    key.asymmetricKeyDetails?.namedCurve !== "prime256v1"
  )
    throw new VmArtifactsError("key_invalid");
  return key;
}

/** Throws unless `signature` is the signature of exactly the bytes of `manifest` by the key of the channel. */
export function verifySignature(
  manifest: Uint8Array,
  signature: Uint8Array,
  publicKey: string,
): void {
  const key = channelKey(publicKey);
  let valid = false;
  try {
    valid = verify("sha256", manifest, { key, dsaEncoding: "der" }, signature);
  } catch {
    valid = false;
  }
  if (!valid) throw new VmArtifactsError("signature_invalid");
}

/** Reads the manifest. It does not trust it: callers verify the signature first (`verifyArtifacts` does). */
export function parseManifest(bytes: Uint8Array): Manifest {
  if (bytes.length > MAX_MANIFEST_BYTES)
    throw new VmArtifactsError("manifest_too_large");
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new VmArtifactsError("manifest_invalid");
  }
  const parsed = ManifestSchema.safeParse(json);
  if (!parsed.success) throw new VmArtifactsError("manifest_invalid");
  return parsed.data;
}

/** The sha256 of a file, read as a stream: the files are gigabytes. */
export async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path))
    hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/** Checks one file against its entry: present, the size first (cheap), then the digest. */
export async function verifyFile(
  dir: string,
  role: ArtifactRole,
  entry: FileEntry,
): Promise<void> {
  const path = join(dir, entry.name);
  let size: number;
  try {
    size = (await stat(path)).size;
  } catch {
    throw new VmArtifactsError("file_missing", [role]);
  }
  if (size !== entry.size) throw new VmArtifactsError("size_mismatch", [role]);
  if ((await sha256File(path)) !== entry.sha256)
    throw new VmArtifactsError("digest_mismatch", [role]);
}

/** Checks the unpacked form of a compressed file (the host unpacks, then asks): the size and the digest the manifest gives for it. */
export async function verifyUnpacked(
  path: string,
  role: ArtifactRole,
  entry: FileEntry,
): Promise<void> {
  const unpacked = entry.uncompressed;
  if (!unpacked) throw new VmArtifactsError("manifest_invalid", [role]);
  let size: number;
  try {
    size = (await stat(path)).size;
  } catch {
    throw new VmArtifactsError("file_missing", [role]);
  }
  if (size !== unpacked.size)
    throw new VmArtifactsError("size_mismatch", [role]);
  if ((await sha256File(path)) !== unpacked.sha256)
    throw new VmArtifactsError("digest_mismatch", [role]);
}

export type VerifyInput = {
  /** The directory the release's files are in. */
  dir: string;
  /** The manifest and its signature, as downloaded. */
  manifest: Uint8Array;
  signature: Uint8Array;
  /** The key of the release channel. */
  publicKey: string;
  /** The release in use, or the one a rollback left: a manifest that is not higher is no way forward. */
  minRelease?: number;
  /** The files to check; all of them when omitted. A host that does not need the source offer asks for the three it boots. */
  roles?: readonly ArtifactRole[];
};

/**
 * The whole check: the signature, then the manifest, then the release number, then each file. Nothing of the manifest is used, and no
 * file is read, before the signature has verified.
 */
export async function verifyArtifacts(input: VerifyInput): Promise<Manifest> {
  verifySignature(input.manifest, input.signature, input.publicKey);
  const manifest = parseManifest(input.manifest);
  if (input.minRelease !== undefined && manifest.release <= input.minRelease)
    throw new VmArtifactsError("release_not_newer");
  for (const role of input.roles ?? ARTIFACT_ROLES)
    await verifyFile(input.dir, role, manifest.files[role]);
  return manifest;
}
