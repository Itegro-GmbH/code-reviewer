// SPDX-License-Identifier: LicenseRef-Proprietary

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createGuardedFetch, createGuardedLookup } from "./guarded-fetch.ts";

type Answer = { address: string; family: 4 | 6 };
const answering =
  (...answers: Answer[]) =>
  (
    _host: string,
    _options: unknown,
    done: (error: Error | null, addresses: Answer[]) => void,
  ) =>
    done(null, answers);

describe("the lookup of a customer's delivery", () => {
  // #972: a name that looks public must not lead to the app's own network (DNS rebinding, a record that points inside).
  it("refuses a public-looking name that resolves to a private, link-local or loopback address", () => {
    for (const address of [
      "10.0.0.5",
      "169.254.169.254",
      "127.0.0.1",
      "192.168.1.1",
    ]) {
      const lookup = createGuardedLookup({
        allowLoopback: false,
        resolve: answering({ address, family: 4 }),
      });
      let seen: unknown = "not called";
      lookup("dispatcher.example.com", { all: true }, (error) => {
        seen = error;
      });
      expect({ address, error: (seen as Error).name }).toEqual({
        address,
        error: "Error",
      });
      expect((seen as NodeJS.ErrnoException).code).toBe(
        "DELIVERY_ADDRESS_INTERNAL",
      );
    }
  });

  it("refuses a name when any one of its addresses is internal", () => {
    const lookup = createGuardedLookup({
      allowLoopback: false,
      resolve: answering(
        { address: "8.8.8.8", family: 4 },
        { address: "10.0.0.5", family: 4 },
      ),
    });
    let seen: unknown = "not called";
    lookup("dispatcher.example.com", { all: true }, (error) => {
      seen = error;
    });
    expect((seen as NodeJS.ErrnoException).code).toBe(
      "DELIVERY_ADDRESS_INTERNAL",
    );
  });

  it("refuses an IPv6 address that is no global unicast one", () => {
    for (const address of ["::1", "fe80::1", "2002:a00:1::1", "::ffff:a00:1"]) {
      const lookup = createGuardedLookup({
        allowLoopback: false,
        resolve: answering({ address, family: 6 }),
      });
      let seen: unknown = "not called";
      lookup("dispatcher.example.com", { all: true }, (error) => {
        seen = error;
      });
      expect({ address, code: (seen as NodeJS.ErrnoException).code }).toEqual({
        address,
        code: "DELIVERY_ADDRESS_INTERNAL",
      });
    }
  });

  it("hands the public addresses on, in the shape that was asked for", () => {
    const resolve = answering(
      { address: "8.8.8.8", family: 4 },
      { address: "2606:4700:4700::1111", family: 6 },
    );
    const lookup = createGuardedLookup({ allowLoopback: false, resolve });

    let all: unknown;
    lookup("dispatcher.example.com", { all: true }, (error, addresses) => {
      all = { error, addresses };
    });
    expect(all).toEqual({
      error: null,
      addresses: [
        { address: "8.8.8.8", family: 4 },
        { address: "2606:4700:4700::1111", family: 6 },
      ],
    });

    let one: unknown;
    lookup("dispatcher.example.com", {}, (error, address, family) => {
      one = { error, address, family };
    });
    expect(one).toEqual({ error: null, address: "8.8.8.8", family: 4 });
  });

  it("lets loopback through only when it is allowed, and nothing else that is internal", () => {
    const loopback = createGuardedLookup({
      allowLoopback: true,
      resolve: answering({ address: "127.0.0.1", family: 4 }),
    });
    let seen: unknown;
    loopback("localhost", { all: true }, (error) => {
      seen = error;
    });
    expect(seen).toBeNull();

    const metadata = createGuardedLookup({
      allowLoopback: true,
      resolve: answering({ address: "169.254.169.254", family: 4 }),
    });
    metadata("dispatcher.example.com", { all: true }, (error) => {
      seen = error;
    });
    expect((seen as NodeJS.ErrnoException).code).toBe(
      "DELIVERY_ADDRESS_INTERNAL",
    );
  });

  it("passes a failed resolution on", () => {
    const failure = Object.assign(new Error("not found"), {
      code: "ENOTFOUND",
    });
    const lookup = createGuardedLookup({
      allowLoopback: false,
      resolve: (_host, _options, done) => done(failure, []),
    });
    let seen: unknown;
    lookup("nowhere.example.com", { all: true }, (error) => {
      seen = error;
    });
    expect(seen).toBe(failure);
  });
});

describe("the connection of a customer's delivery", () => {
  const servers: Server[] = [];
  afterEach(async () => {
    await Promise.all(
      servers
        .splice(0)
        .map((server) => new Promise((done) => server.close(done))),
    );
  });

  /** A server on this machine and the number of requests it got. */
  async function listen(): Promise<{ port: number; hits: () => number }> {
    let hits = 0;
    const server = createServer((_request, response) => {
      hits += 1;
      response.statusCode = 202;
      response.end();
    });
    servers.push(server);
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    return { port: (server.address() as AddressInfo).port, hits: () => hits };
  }

  it("is refused before a connection is made when the name resolves to this machine, and made when loopback is allowed", async () => {
    const target = await listen();
    // `.localhost` is what the unit tests' network guard lets through; what the name means to the lookup is only its answer.
    const url = `http://dispatcher.localhost:${String(target.port)}/dispatch`;
    const resolve = answering({ address: "127.0.0.1", family: 4 });

    const refusing = createGuardedFetch({ allowLoopback: false, resolve });
    await expect(refusing(url, { method: "POST" })).rejects.toThrow();
    expect(target.hits()).toBe(0);

    const allowing = createGuardedFetch({ allowLoopback: true, resolve });
    const response = await allowing(url, { method: "POST" });
    expect(response.status).toBe(202);
    expect(target.hits()).toBe(1);
  });

  it("checks an address literal like a resolved one", async () => {
    const target = await listen();
    const refusing = createGuardedFetch({ allowLoopback: false });
    await expect(
      refusing(`http://127.0.0.1:${String(target.port)}/dispatch`, {
        method: "POST",
      }),
    ).rejects.toThrow();
    expect(target.hits()).toBe(0);
  });
});
