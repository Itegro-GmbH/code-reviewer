// SPDX-License-Identifier: LicenseRef-Proprietary

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  verifyDispatch,
  type DispatchKey,
} from "../../../fakes/dispatcher-app/signing.ts";
import type {
  DispatchSigningVectors,
  DispatchStop,
  DispatchWebhook,
} from "../contracts/dispatch-webhook.ts";
import {
  buildDispatchRequest,
  buildStopRequest,
  signDispatch,
} from "./request.ts";

const CONTRACTS = join(import.meta.dirname, "..", "..", "..", "contracts");
const vectors = JSON.parse(
  readFileSync(join(CONTRACTS, "dispatch-signing-vectors.json"), "utf8"),
) as DispatchSigningVectors;
const example = JSON.parse(
  readFileSync(
    join(CONTRACTS, "examples", "dispatch-webhook", "DispatchWebhook.json"),
    "utf8",
  ),
) as DispatchWebhook;

const current: DispatchKey = vectors.keys.current;
const previous: DispatchKey = vectors.keys.previous;
const NOW = new Date(example.sentAt);
const SECONDS = Math.floor(NOW.getTime() / 1000);

function request(key: DispatchKey = current, bypassToken?: string) {
  return buildDispatchRequest({
    key,
    ...(bypassToken === undefined ? {} : { bypassToken }),
    jobId: example.jobId,
    reviewKind: example.reviewKind,
    attempt: example.attempt,
    dispatchId: example.dispatchId,
    now: NOW,
  });
}

function receiverView(built: ReturnType<typeof request>) {
  return {
    headers: built.headers,
    rawBody: built.body,
    nowSeconds: SECONDS,
    toleranceSeconds: vectors.toleranceSeconds,
  };
}

describe("the dispatch request", () => {
  // #326-T01
  it("is the example of the contract, byte for byte, with the signature of the vectors", () => {
    const built = request();
    expect(built.body).toBe(JSON.stringify(example));
    const vector = vectors.vectors.find((v) => v.name === "valid, current key");
    expect(vector).toBeDefined();
    expect(built.body).toBe(vector?.body);
    expect(built.headers).toEqual({
      "content-type": "application/json",
      "x-dispatch-timestamp": String(SECONDS),
      "x-dispatch-id": example.dispatchId,
      "x-dispatch-key-id": current.kid,
      "x-dispatch-signature": vector?.headers["x-dispatch-signature"],
    });
  });

  // #326-T01
  it("is a closed body of at most 1 KiB with no secret and no repository data", () => {
    const built = request();
    expect(Buffer.byteLength(built.body, "utf8")).toBeLessThanOrEqual(1024);
    expect(Object.keys(JSON.parse(built.body) as object).sort()).toEqual(
      [
        "attempt",
        "dispatchId",
        "jobId",
        "reviewKind",
        "sentAt",
        "type",
        "version",
      ].sort(),
    );
    expect(built.body).not.toContain(current.secret);
    expect(JSON.stringify(built.headers)).not.toContain(current.secret);
  });

  // #326-T01
  it("is accepted by the reference receiver with the current key", () => {
    expect(
      verifyDispatch({ keys: [current, previous], ...receiverView(request()) }),
    ).toBe("ok");
  });

  // #326-T01
  it("adds the protection bypass header only when a token is configured", () => {
    expect(request().headers).not.toHaveProperty("x-vercel-protection-bypass");
    const built = request(current, "bypass-token-0123456789-0123456789");
    expect(built.headers["x-vercel-protection-bypass"]).toBe(
      "bypass-token-0123456789-0123456789",
    );
    expect(verifyDispatch({ keys: [current], ...receiverView(built) })).toBe(
      "ok",
    );
  });

  // #326-T02
  it("is refused by the receiver when the body is changed", () => {
    const built = request();
    const tampered = {
      ...receiverView(built),
      rawBody: built.body.replace('"attempt":1', '"attempt":2'),
    };
    expect(tampered.rawBody).not.toBe(built.body);
    expect(verifyDispatch({ keys: [current, previous], ...tampered })).toBe(
      "bad_signature",
    );
  });

  // #326-T02
  it("is refused by the receiver when the timestamp is old or ahead", () => {
    const built = request();
    for (const skew of [-301, 301])
      expect(
        verifyDispatch({
          keys: [current, previous],
          ...receiverView(built),
          nowSeconds: SECONDS + skew,
        }),
      ).toBe("expired");
  });

  // #326-T02
  it("is refused by the receiver when it does not know the key id, or the signature is by another key", () => {
    const built = request();
    expect(verifyDispatch({ keys: [previous], ...receiverView(built) })).toBe(
      "unknown_key",
    );
    expect(
      verifyDispatch({
        keys: [{ kid: current.kid, secret: previous.secret }],
        ...receiverView(built),
      }),
    ).toBe("bad_signature");
  });

  // #326-T11
  it("signs with the current key and with the previous key, and a receiver holding both accepts both", () => {
    const keys = [current, previous];
    expect(verifyDispatch({ keys, ...receiverView(request(current)) })).toBe(
      "ok",
    );
    expect(verifyDispatch({ keys, ...receiverView(request(previous)) })).toBe(
      "ok",
    );
    expect(request(previous).headers["x-dispatch-key-id"]).toBe(previous.kid);
    const vector = vectors.vectors.find(
      (v) => v.name === "valid, previous key (rotation)",
    );
    expect(request(previous).headers["x-dispatch-signature"]).toBe(
      vector?.headers["x-dispatch-signature"],
    );
  });

  // #326-T02
  it("reproduces the signature of every shared vector that verifies, and of none that has a bad signature", () => {
    let checked = 0;
    for (const vector of vectors.vectors) {
      if (vector.expected !== "ok" && vector.expected !== "bad_signature")
        continue;
      const key = [current, previous].find(
        (candidate) => candidate.kid === vector.headers["x-dispatch-key-id"],
      );
      const timestamp = vector.headers["x-dispatch-timestamp"];
      const dispatchId = vector.headers["x-dispatch-id"];
      if (
        key === undefined ||
        timestamp === undefined ||
        dispatchId === undefined
      )
        continue;
      const mine = signDispatch({
        secret: key.secret,
        timestamp,
        dispatchId,
        rawBody: vector.body,
      });
      expect(mine === vector.headers["x-dispatch-signature"], vector.name).toBe(
        vector.expected === "ok",
      );
      checked += 1;
    }
    expect(checked).toBeGreaterThanOrEqual(6);
  });

  // #326-T02
  it("is judged by the reference receiver exactly as the shared vectors say", () => {
    for (const vector of vectors.vectors)
      expect(
        verifyDispatch({
          keys: [current, previous],
          headers: vector.headers,
          rawBody: vector.body,
          nowSeconds: vector.now,
          toleranceSeconds: vectors.toleranceSeconds,
        }),
        vector.name,
      ).toBe(vector.expected);
  });
});

const stopExample = JSON.parse(
  readFileSync(
    join(CONTRACTS, "examples", "dispatch-webhook", "DispatchStop.json"),
    "utf8",
  ),
) as DispatchStop;

describe("the stop request", () => {
  const stopAt = new Date(stopExample.sentAt);

  function stop(key: DispatchKey = current, bypassToken?: string) {
    return buildStopRequest({
      key,
      ...(bypassToken === undefined ? {} : { bypassToken }),
      jobId: stopExample.jobId,
      stopId: stopExample.stopId,
      now: stopAt,
    });
  }

  // #487-T01
  it("is the example of the contract, byte for byte", () => {
    expect(stop().body).toBe(JSON.stringify(stopExample));
  });

  // #487-T01
  it("carries the stop id as the dispatch id and is signed over the stop body like a wake-up call", () => {
    const built = stop();

    expect(built.headers["x-dispatch-id"]).toBe(stopExample.stopId);
    expect(built.headers["x-dispatch-key-id"]).toBe(current.kid);
    expect(
      verifyDispatch({
        keys: [current, previous],
        headers: built.headers,
        rawBody: built.body,
        nowSeconds: Math.floor(stopAt.getTime() / 1000),
        toleranceSeconds: vectors.toleranceSeconds,
      }),
    ).toBe("ok");
  });

  // #487-T02
  it("is refused by the receiver when the body is changed, the clock is off or the key is unknown", () => {
    const built = stop();
    const view = (overrides: Partial<Parameters<typeof verifyDispatch>[0]>) =>
      verifyDispatch({
        keys: [current, previous],
        headers: built.headers,
        rawBody: built.body,
        nowSeconds: Math.floor(stopAt.getTime() / 1000),
        toleranceSeconds: vectors.toleranceSeconds,
        ...overrides,
      });

    expect(view({ rawBody: built.body.replace("job.stop", "job.ready") })).toBe(
      "bad_signature",
    );
    expect(
      view({ nowSeconds: Math.floor(stopAt.getTime() / 1000) + 3600 }),
    ).toBe("expired");
    expect(view({ keys: [previous] })).toBe("unknown_key");
  });

  // #487-T01
  it("is a closed body of at most 1 KiB with no secret and no repository data", () => {
    const built = stop(current, "example-bypass-token-0000000000000000");

    expect(Object.keys(JSON.parse(built.body) as object).sort()).toEqual(
      ["jobId", "sentAt", "stopId", "type", "version"].sort(),
    );
    expect(Buffer.byteLength(built.body)).toBeLessThanOrEqual(1024);
    expect(built.body).not.toContain(current.secret);
    expect(built.headers["x-vercel-protection-bypass"]).toBe(
      "example-bypass-token-0000000000000000",
    );
  });
});

describe("the dispatch request of an implementer turn", () => {
  // #752-T10
  it("carries reviewKind implementer, and the kinds of Diff and Dynamic jobs stay as they were", () => {
    const body = (reviewKind: DispatchWebhook["reviewKind"]) =>
      JSON.parse(
        buildDispatchRequest({
          key: current,
          jobId: example.jobId,
          reviewKind,
          attempt: 1,
          dispatchId: example.dispatchId,
          now: NOW,
        }).body,
      ) as DispatchWebhook;

    expect(body("implementer").reviewKind).toBe("implementer");
    expect(body("diff").reviewKind).toBe("diff");
    expect(body("dynamic").reviewKind).toBe("dynamic");
  });
});
