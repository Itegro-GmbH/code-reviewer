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
  // #976-T01
  it("has the shape of the runner's channel, with the public key and nothing secret", () => {
    expect(Object.keys(channel).sort()).toEqual([
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
