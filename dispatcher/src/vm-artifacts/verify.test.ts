// SPDX-License-Identifier: LicenseRef-Proprietary

import {
  createHash,
  generateKeyPairSync,
  sign,
  type KeyObject,
} from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ARTIFACT_ROLES, type Manifest } from "./manifest.ts";
import {
  VmArtifactsError,
  parseManifest,
  verifyArtifacts,
  verifySignature,
} from "./verify.ts";

const sha256 = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

/** The throwaway key of the test, in the form the release channel carries it: base64 of the DER SubjectPublicKeyInfo. */
function newKey(): { privateKey: KeyObject; publicKey: string } {
  const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return {
    privateKey: pair.privateKey,
    publicKey: pair.publicKey
      .export({ type: "spki", format: "der" })
      .toString("base64"),
  };
}

const signManifest = (bytes: Uint8Array, privateKey: KeyObject): Uint8Array =>
  sign("sha256", bytes, { key: privateKey, dsaEncoding: "der" });

const IMAGE_ID = `sha256:${"a".repeat(64)}`;

let dir: string;
let manifestBytes: Buffer;
let manifest: Manifest;

/** Writes a file with known content under `dir` and returns the manifest entry for it. */
function put(name: string, content: string): Manifest["files"]["kernel"] {
  const bytes = Buffer.from(content);
  writeFileSync(join(dir, name), bytes);
  return { name, size: bytes.length, sha256: sha256(bytes) };
}

function build(): void {
  const files = Object.fromEntries(
    ARTIFACT_ROLES.map((role) => [
      role,
      put(`${role}.bin`, `content of ${role}`),
    ]),
  ) as Manifest["files"];
  manifest = {
    version: 1,
    release: 7,
    arch: "x86_64",
    builtAt: "2026-11-10T12:00:00.000Z",
    commit: "1".repeat(40),
    files,
    kernel: {
      version: "6.18.62",
      sourceSha256: "2".repeat(64),
      baseConfigSha256: "3".repeat(64),
      fragmentSha256: "4".repeat(64),
      configSha256: "5".repeat(64),
      bootArgs: "reboot=k panic=1",
      initCommand: "/usr/bin/docker-init -- /usr/local/sbin/vm-init",
    },
    firecracker: { version: "1.17.0" },
    components: {
      ubuntuBase: "26.04.1",
      dockerd: "29.1.3-0ubuntu1",
      buildx: "0.30.1-0ubuntu1",
      sysbox: "0.7.1-0.linux",
      sysboxSha256: "6".repeat(64),
    },
    images: {
      worker: { tag: "code-reviewer-worker:golden", id: IMAGE_ID },
      agent: { tag: "code-reviewer-agent:golden", id: IMAGE_ID },
    },
  };
  manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vm-artifacts-"));
  build();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function codeOf(run: () => unknown): string | undefined {
  try {
    run();
  } catch (error) {
    if (error instanceof VmArtifactsError) return error.code;
    throw error;
  }
  return undefined;
}

describe("the signature of the manifest", () => {
  // #976-T01
  it("verifies a signature made with the key of the channel", () => {
    const { privateKey, publicKey } = newKey();
    const signature = signManifest(manifestBytes, privateKey);

    expect(() =>
      verifySignature(manifestBytes, signature, publicKey),
    ).not.toThrow();
  });

  // #976-T01
  it("verifies what `openssl dgst -sha256 -sign` writes, the way the release pipeline signs", () => {
    const keyFile = join(dir, "key.pem");
    const created = spawnSync("openssl", [
      "ecparam",
      "-genkey",
      "-name",
      "prime256v1",
      "-noout",
      "-out",
      keyFile,
    ]);
    expect(created.status).toBe(0);
    const pub = spawnSync(
      "openssl",
      ["pkey", "-in", keyFile, "-pubout", "-outform", "DER"],
      { encoding: "buffer" },
    );
    const manifestFile = join(dir, "manifest.json");
    writeFileSync(manifestFile, manifestBytes);
    const signed = spawnSync("openssl", [
      "dgst",
      "-sha256",
      "-sign",
      keyFile,
      "-out",
      join(dir, "manifest.sig"),
      manifestFile,
    ]);
    expect(signed.status).toBe(0);

    expect(() =>
      verifySignature(
        readFileSync(manifestFile),
        readFileSync(join(dir, "manifest.sig")),
        pub.stdout.toString("base64"),
      ),
    ).not.toThrow();
  });

  // #976-T01
  it("fails when one byte of the manifest changed", () => {
    const { privateKey, publicKey } = newKey();
    const signature = signManifest(manifestBytes, privateKey);
    const changed = Buffer.from(manifestBytes);
    changed[changed.indexOf("7")] = "8".charCodeAt(0); // the release number

    expect(codeOf(() => verifySignature(changed, signature, publicKey))).toBe(
      "signature_invalid",
    );
  });

  // #976-T01
  it("fails for a signature of another key", () => {
    const signature = signManifest(manifestBytes, newKey().privateKey);

    expect(
      codeOf(() =>
        verifySignature(manifestBytes, signature, newKey().publicKey),
      ),
    ).toBe("signature_invalid");
  });

  // #976-T01
  it("refuses a channel key that is empty, not base64 DER, or not ECDSA over P-256", () => {
    const signature = signManifest(manifestBytes, newKey().privateKey);
    const p384 = generateKeyPairSync("ec", { namedCurve: "secp384r1" })
      .publicKey.export({ type: "spki", format: "der" })
      .toString("base64");
    const ed25519 = generateKeyPairSync("ed25519")
      .publicKey.export({ type: "spki", format: "der" })
      .toString("base64");

    for (const key of ["", "not a key", p384, ed25519])
      expect(
        codeOf(() => verifySignature(manifestBytes, signature, key)),
        key,
      ).toBe("key_invalid");
  });

  // #976-T01
  it("fails for a signature that is not DER", () => {
    const { publicKey } = newKey();

    expect(
      codeOf(() => verifySignature(manifestBytes, Buffer.alloc(64), publicKey)),
    ).toBe("signature_invalid");
  });
});

describe("the manifest", () => {
  it("reads what the build writes", () => {
    expect(parseManifest(manifestBytes)).toEqual(manifest);
  });

  it("refuses a manifest of another version, a field it does not know, and one that is too large", () => {
    const withVersion = (version: number): Buffer =>
      Buffer.from(JSON.stringify({ ...manifest, version }));
    const withExtra = Buffer.from(JSON.stringify({ ...manifest, extra: 1 }));

    expect(codeOf(() => parseManifest(withVersion(2)))).toBe(
      "manifest_invalid",
    );
    expect(codeOf(() => parseManifest(withExtra))).toBe("manifest_invalid");
    expect(codeOf(() => parseManifest(Buffer.from("{")))).toBe(
      "manifest_invalid",
    );
    expect(codeOf(() => parseManifest(Buffer.alloc(300 * 1024, 32)))).toBe(
      "manifest_too_large",
    );
  });

  it("refuses a file name that leaves the directory", () => {
    const evil = structuredClone(manifest);
    evil.files.kernel.name = "../vmlinux";

    expect(codeOf(() => parseManifest(Buffer.from(JSON.stringify(evil))))).toBe(
      "manifest_invalid",
    );
  });

  it("wants the size and digest of the unpacked file next to a compressed one", () => {
    const entry = structuredClone(manifest);
    entry.files.rootfs = { ...entry.files.rootfs, name: "rootfs.ext4.zst" };

    expect(
      codeOf(() => parseManifest(Buffer.from(JSON.stringify(entry)))),
    ).toBe("manifest_invalid");
  });
});

describe("the files of a release", () => {
  const verify = (minRelease?: number) => {
    const { privateKey, publicKey } = newKey();
    return verifyArtifacts({
      dir,
      manifest: manifestBytes,
      signature: signManifest(manifestBytes, privateKey),
      publicKey,
      ...(minRelease === undefined ? {} : { minRelease }),
    });
  };

  // #976-T01
  it("accepts every file when size and digest are the manifest's", async () => {
    await expect(verify()).resolves.toEqual(manifest);
  });

  // #976-T01
  it("fails when one byte of a file changed", async () => {
    const path = join(dir, manifest.files.rootfs.name);
    const bytes = readFileSync(path);
    bytes[3] = (bytes[3] ?? 0) ^ 1;
    writeFileSync(path, bytes);

    await expect(verify()).rejects.toMatchObject({
      code: "digest_mismatch",
      detail: ["rootfs"],
    });
  });

  // #976-T01
  it("fails when a file is longer or shorter, before it reads it all", async () => {
    writeFileSync(join(dir, manifest.files.kernel.name), "short");

    await expect(verify()).rejects.toMatchObject({
      code: "size_mismatch",
      detail: ["kernel"],
    });
  });

  // #976-T01
  it("fails when a file is missing", async () => {
    rmSync(join(dir, manifest.files.dockerData.name));

    await expect(verify()).rejects.toMatchObject({
      code: "file_missing",
      detail: ["dockerData"],
    });
  });

  // #976-T01
  it("does not read a file before the signature of the manifest has verified", async () => {
    const other = newKey();
    const { privateKey } = newKey();
    rmSync(join(dir, manifest.files.kernel.name));

    await expect(
      verifyArtifacts({
        dir,
        manifest: manifestBytes,
        signature: signManifest(manifestBytes, privateKey),
        publicKey: other.publicKey,
      }),
    ).rejects.toMatchObject({ code: "signature_invalid" });
  });

  // #976-T01
  it("takes no release that is not newer than the one in use", async () => {
    await expect(verify(7)).rejects.toMatchObject({
      code: "release_not_newer",
    });
    await expect(verify(6)).resolves.toEqual(manifest);
  });

  it("can verify a subset of the roles, for a host that does not need the source", async () => {
    const { privateKey, publicKey } = newKey();
    rmSync(join(dir, manifest.files.kernelSource.name));

    await expect(
      verifyArtifacts({
        dir,
        manifest: manifestBytes,
        signature: signManifest(manifestBytes, privateKey),
        publicKey,
        roles: ["kernel", "rootfs", "dockerData"],
      }),
    ).resolves.toEqual(manifest);
  });
});
