// SPDX-License-Identifier: LicenseRef-Proprietary

import { createPublicKey } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseManifest } from "./verify.ts";

const REPO = join(import.meta.dirname, "..", "..", "..");
const channel = JSON.parse(
  readFileSync(join(REPO, "docker/vm/release-channel.json"), "utf8"),
) as Record<string, unknown>;

describe("the release channel of the VM artifacts", () => {
  // #976-T01, #982
  it("has the shape of the runner's channel, with the public key and nothing secret", () => {
    expect(Object.keys(channel).sort()).toEqual([
      "baseUrl",
      "manifestAsset",
      "publicKey",
      "repository",
      "signatureAsset",
      "version",
    ]);
    expect(channel.version).toBe(1);
  });

  // #976-T01
  it("holds either no key yet (nothing is published) or an ECDSA P-256 public key as base64 DER", () => {
    const key = channel.publicKey;
    expect(typeof key).toBe("string");
    if (key === "") return;
    const parsed = createPublicKey({
      key: Buffer.from(String(key), "base64"),
      format: "der",
      type: "spki",
    });
    expect(parsed.asymmetricKeyType).toBe("ec");
    expect(parsed.asymmetricKeyDetails?.namedCurve).toBe("prime256v1");
  });

  // #976-T01
  it("names the repository the release is made in when a key is set", () => {
    if (channel.publicKey === "") {
      expect(channel.repository).toBe("");
      return;
    }
    expect(channel.repository).toBe("Itegro-GmbH/code-reviewer");
  });
});

describe("the address the installer downloads from (#982)", () => {
  // #982: the owner decides where the files are (a GitHub release or protected storage); nothing is hard-coded.
  it("is either empty (nothing is published) together with the key, or an https directory", () => {
    const base = channel.baseUrl;
    expect(typeof base).toBe("string");
    if (base === "") {
      expect(channel.publicKey).toBe("");
      return;
    }
    expect(String(base)).toMatch(/^https:\/\//);
    expect(channel.publicKey).not.toBe("");
  });
});

describe("the manifest the installer reads (#982)", () => {
  // The shell installer reads the manifest with jq, and its tests build releases of this shape in Python
  // (runner/tests/unit/host_install_support.py, which compares its manifest to this file by shape). The same file
  // must parse here, so a change of the schema breaks one of the two sides loudly and is made in both.
  it("is parsed by the verifier's own schema", () => {
    const sample = readFileSync(
      join(import.meta.dirname, "fixtures", "sample-manifest.json"),
    );
    const manifest = parseManifest(sample);
    expect(manifest.release).toBeGreaterThanOrEqual(1);
    expect(manifest.files.rootfs.name).toBe("rootfs.ext4.zst");
    expect(manifest.files.dockerData.name).toBe("dockerdata.ext4.zst");
    expect(manifest.files.kernel.name).toBe("vmlinux");
    expect(manifest.images.worker.id).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});
