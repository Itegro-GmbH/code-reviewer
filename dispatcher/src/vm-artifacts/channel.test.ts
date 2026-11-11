// SPDX-License-Identifier: LicenseRef-Proprietary

import { createPublicKey } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

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
