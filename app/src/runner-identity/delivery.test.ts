// SPDX-License-Identifier: LicenseRef-Proprietary

import { describe, expect, it } from "vitest";
import { SecretBoxError } from "../crypto/secret-box.ts";
import {
  checkDelivery,
  DELIVERY_KEY_ID_PATTERN,
  DELIVERY_SECRET_PATTERN,
  deliveryUrlIsUsable,
  mintDeliverySecret,
  openDeliverySecret,
  sealDeliverySecret,
} from "./delivery.ts";

describe("the delivery a dispatcher announces", () => {
  // #972-T04
  it("is polling when none is announced, and for mode poll", () => {
    expect(checkDelivery(undefined)).toEqual({
      ok: true,
      value: { mode: "poll" },
    });
    expect(checkDelivery({ mode: "poll", url: "ftp://ignored" })).toEqual({
      ok: true,
      value: { mode: "poll" },
    });
  });

  it("reads a webhook with its address and whether a new secret is wanted", () => {
    expect(
      checkDelivery({ mode: "webhook", url: "https://example.com/dispatch" }),
    ).toEqual({
      ok: true,
      value: {
        mode: "webhook",
        url: "https://example.com/dispatch",
        rotateSecret: false,
      },
    });
    expect(
      checkDelivery({
        mode: "webhook",
        url: "https://example.com/dispatch",
        rotateSecret: true,
        unknown: 1,
      }),
    ).toMatchObject({ ok: true, value: { rotateSecret: true } });
  });

  it("names the field that is wrong, never its value", () => {
    expect(checkDelivery("webhook")).toEqual({
      ok: false,
      fields: [{ field: "delivery", code: "invalid" }],
    });
    expect(checkDelivery({})).toEqual({
      ok: false,
      fields: [{ field: "delivery.mode", code: "required" }],
    });
    expect(checkDelivery({ mode: "push" })).toEqual({
      ok: false,
      fields: [{ field: "delivery.mode", code: "invalid" }],
    });
    expect(checkDelivery({ mode: "webhook" })).toEqual({
      ok: false,
      fields: [{ field: "delivery.url", code: "required" }],
    });
    expect(
      checkDelivery({
        mode: "webhook",
        url: "http://169.254.169.254/dispatch",
        rotateSecret: "yes",
      }),
    ).toEqual({
      ok: false,
      fields: [
        { field: "delivery.url", code: "invalid" },
        { field: "delivery.rotateSecret", code: "invalid" },
      ],
    });
  });
});

describe("the address the app is willing to ring", () => {
  it("is https to a public host, or http to this machine", () => {
    for (const url of [
      "https://dispatcher.example.com/dispatch",
      "https://dispatcher.example.com:8443/api/dispatch",
      "https://203.0.113.9/dispatch",
      "https://[2001:db8::1]/dispatch",
      "http://localhost:4000/dispatch",
      "http://127.0.0.1:4000/dispatch",
      "http://[::1]:4000/dispatch",
    ])
      expect({ url, usable: deliveryUrlIsUsable(url) }).toEqual({
        url,
        usable: true,
      });
  });

  it("refuses credentials, plain http to another host, and anything that is no address", () => {
    for (const url of [
      "https://user:pass@example.com/dispatch",
      "http://example.com/dispatch",
      "ftp://example.com/dispatch",
      "example.com/dispatch",
      "",
      `https://example.com/${"a".repeat(2100)}`,
    ])
      expect({ url, usable: deliveryUrlIsUsable(url) }).toEqual({
        url,
        usable: false,
      });
  });

  it("refuses the app's own network: private, link-local and reserved addresses and names that only mean something inside a network", () => {
    for (const url of [
      "https://10.0.0.5/dispatch",
      "https://172.16.3.4/dispatch",
      "https://192.168.1.10/dispatch",
      "https://169.254.169.254/latest/meta-data",
      "https://100.64.0.1/dispatch",
      "https://0.0.0.0/dispatch",
      "https://224.0.0.1/dispatch",
      "https://[fe80::1]/dispatch",
      "https://[fd00::1]/dispatch",
      "https://[::ffff:10.0.0.1]/dispatch",
      "https://metadata/dispatch",
      "https://printer.local/dispatch",
      "https://vault.internal/dispatch",
      "https://167772161/dispatch",
    ])
      expect({ url, usable: deliveryUrlIsUsable(url) }).toEqual({
        url,
        usable: false,
      });
  });
});

describe("the signing secret of a dispatcher", () => {
  // #972-T06
  it("is made by the app, one for each dispatcher, in the form of the contract", () => {
    const a = mintDeliverySecret();
    const b = mintDeliverySecret();
    expect(a.secret).toMatch(DELIVERY_SECRET_PATTERN);
    expect(a.keyId).toMatch(DELIVERY_KEY_ID_PATTERN);
    expect(a.secret).not.toBe(b.secret);
    expect(a.secret.length).toBeGreaterThanOrEqual(32);
  });

  it("is kept encrypted, readable only for the runner it was made for and only with the app's secret", () => {
    const { secret } = mintDeliverySecret();
    const stored = sealDeliverySecret(
      "app-secret-for-tests",
      "runner-1",
      secret,
    );

    expect(stored).not.toContain(secret);
    expect(openDeliverySecret("app-secret-for-tests", "runner-1", stored)).toBe(
      secret,
    );
    expect(() =>
      openDeliverySecret("app-secret-for-tests", "runner-2", stored),
    ).toThrow(SecretBoxError);
    expect(() =>
      openDeliverySecret("another-app-secret", "runner-1", stored),
    ).toThrow(SecretBoxError);
  });
});
