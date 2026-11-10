// SPDX-License-Identifier: LicenseRef-Proprietary

import { describe, expect, it } from "vitest";
import { SecretBoxError } from "../crypto/secret-box.ts";
import {
  checkDelivery,
  DELIVERY_KEY_ID_PATTERN,
  DELIVERY_SECRET_PATTERN,
  deliveryUrlIsUsable,
  isInternalAddress,
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

  it("takes an address of this machine only when loopback is allowed", () => {
    const body = { mode: "webhook", url: "http://localhost:4000/dispatch" };
    expect(checkDelivery(body)).toEqual({
      ok: false,
      fields: [{ field: "delivery.url", code: "invalid" }],
    });
    expect(checkDelivery(body, { allowLoopback: true })).toMatchObject({
      ok: true,
    });
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
  it("is https to a public host", () => {
    for (const url of [
      "https://dispatcher.example.com/dispatch",
      "https://dispatcher.example.com:8443/api/dispatch",
      "https://dispatcher.example.com./dispatch",
      "https://203.0.113.9/dispatch",
      "https://[2606:4700:4700::1111]/dispatch",
    ])
      expect({ url, usable: deliveryUrlIsUsable(url) }).toEqual({
        url,
        usable: true,
      });
  });

  it("refuses credentials, plain http to a public host, and anything that is no address", () => {
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

  // #972: the address of this machine is no delivery of a production instance, with any scheme and port.
  it("refuses this machine, with and without a trailing dot, unless loopback is allowed explicitly", () => {
    const loopback = [
      "http://localhost:4000/dispatch",
      "http://127.0.0.1:4000/dispatch",
      "http://[::1]:4000/dispatch",
      "https://127.0.0.1/dispatch",
      "https://localhost/dispatch",
      "https://localhost./dispatch",
      "http://localhost.:4000/dispatch",
      "https://[::1]/dispatch",
    ];
    for (const url of loopback) {
      expect({ url, usable: deliveryUrlIsUsable(url) }).toEqual({
        url,
        usable: false,
      });
      expect({
        url,
        usable: deliveryUrlIsUsable(url, { allowLoopback: true }),
      }).toEqual({
        url,
        usable: true,
      });
    }
  });

  it("allows plain http only to this machine, and only when loopback is allowed", () => {
    expect(
      deliveryUrlIsUsable("http://example.com/dispatch", {
        allowLoopback: true,
      }),
    ).toBe(false);
    expect(
      deliveryUrlIsUsable("http://169.254.169.254/dispatch", {
        allowLoopback: true,
      }),
    ).toBe(false);
    expect(
      deliveryUrlIsUsable("https://10.0.0.5/dispatch", { allowLoopback: true }),
    ).toBe(false);
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

  it("refuses names of the cloud's metadata service and of the network with a trailing dot", () => {
    for (const url of [
      "https://metadata.google.internal./computeMetadata/v1/",
      "https://metadata.google.internal/computeMetadata/v1/",
      "https://printer.local./dispatch",
      "https://metadata./dispatch",
      "https://vault.internal../dispatch",
    ])
      expect({ url, usable: deliveryUrlIsUsable(url) }).toEqual({
        url,
        usable: false,
      });
  });

  it("refuses an address however its number is spelled: decimal, octal, hexadecimal, short", () => {
    for (const url of [
      "https://2130706433/dispatch",
      "https://017700000001/dispatch",
      "https://0177.0.0.1/dispatch",
      "https://0x7f.0.0.1/dispatch",
      "https://0x7f000001/dispatch",
      "https://127.1/dispatch",
      "https://2852039166/dispatch",
      "https://0251.0376.0251.0376/dispatch",
      "https://0xa9.0xfe.0xa9.0xfe/dispatch",
      "https://012.0.0.5/dispatch",
    ])
      expect({ url, usable: deliveryUrlIsUsable(url) }).toEqual({
        url,
        usable: false,
      });
  });

  it("refuses the IPv6 ranges that are no public destination: 6to4, Teredo, documentation, mapped and compatible forms", () => {
    for (const url of [
      "https://[2002::1]/dispatch",
      "https://[2002:a00:1::1]/dispatch",
      "https://[2001:0::1]/dispatch",
      "https://[2001::1]/dispatch",
      "https://[2001:db8::1]/dispatch",
      "https://[2001:db8:ffff::1]/dispatch",
      "https://[::ffff:7f00:1]/dispatch",
      "https://[::ffff:127.0.0.1]/dispatch",
      "https://[::ffff:808:808]/dispatch",
      "https://[::127.0.0.1]/dispatch",
      "https://[::7f00:1]/dispatch",
      "https://[64:ff9b::a00:1]/dispatch",
      "https://[::]/dispatch",
      "https://[fc00::1]/dispatch",
      "https://[ff02::1]/dispatch",
    ])
      expect({ url, usable: deliveryUrlIsUsable(url) }).toEqual({
        url,
        usable: false,
      });
  });
});

describe("the address a name resolved to", () => {
  it("is internal for a private, loopback, link-local, reserved or non-global address, mapped forms included", () => {
    for (const address of [
      "10.1.2.3",
      "127.0.0.1",
      "169.254.169.254",
      "192.168.0.1",
      "100.64.0.1",
      "::1",
      "::",
      "fe80::1",
      "fd12::1",
      "::ffff:7f00:1",
      "::ffff:8.8.8.8",
      "2002::1",
      "2001::1",
      "2001:db8::1",
      "not an address",
    ])
      expect({ address, internal: isInternalAddress(address) }).toEqual({
        address,
        internal: true,
      });
  });

  it("is public for a global unicast address", () => {
    for (const address of ["8.8.8.8", "203.0.113.9", "2606:4700:4700::1111"])
      expect({ address, internal: isInternalAddress(address) }).toEqual({
        address,
        internal: false,
      });
  });

  it("lets loopback through only when it is allowed", () => {
    for (const address of ["127.0.0.1", "::1"]) {
      expect(isInternalAddress(address)).toBe(true);
      expect(isInternalAddress(address, { allowLoopback: true })).toBe(false);
    }
    expect(isInternalAddress("10.0.0.1", { allowLoopback: true })).toBe(true);
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
