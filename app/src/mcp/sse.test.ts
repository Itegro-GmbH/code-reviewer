// SPDX-License-Identifier: LicenseRef-Proprietary

import { describe, expect, it } from "vitest";
import { createSseEventReader, SseTooLargeError } from "./sse.ts";

function streamOf(...chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

async function all(reader: ReturnType<typeof createSseEventReader>) {
  const events = [];
  for (
    let event = await reader.next();
    event !== null;
    event = await reader.next()
  )
    events.push(event);
  return events;
}

describe("the reader of an event stream", () => {
  it("reads events with their names, joins data lines and skips comments", async () => {
    const reader = createSseEventReader(
      streamOf(
        ": keep-alive\n\nevent: endpoint\ndata: /messages?x=1\n\ndata: a\ndata: b\n\n",
      ),
      1024,
    );

    expect(await all(reader)).toEqual([
      { event: "endpoint", data: "/messages?x=1" },
      { event: "message", data: "a\nb" },
    ]);
  });

  it("reads CRLF and an event that is split over chunks, even between CR and LF", async () => {
    const reader = createSseEventReader(
      streamOf("event: message\r", '\ndata: {"a":', "1}\r\n\r", "\n"),
      1024,
    );

    expect(await all(reader)).toEqual([{ event: "message", data: '{"a":1}' }]);
  });

  it("counts an event that ends with the stream", async () => {
    const reader = createSseEventReader(streamOf("data: last"), 1024);

    expect(await all(reader)).toEqual([{ event: "message", data: "last" }]);
  });

  it("stops with an error when the stream is larger than the limit", async () => {
    const reader = createSseEventReader(
      streamOf("data: ".padEnd(200, "x")),
      100,
    );

    await expect(reader.next()).rejects.toBeInstanceOf(SseTooLargeError);
  });

  it("stops at one event that is larger than the limit of an event, even when the stream as a whole may be large", async () => {
    const reader = createSseEventReader(
      streamOf("data: ".padEnd(5000, "x")),
      1_000_000,
      1000,
    );

    await expect(reader.next()).rejects.toBeInstanceOf(SseTooLargeError);
  });

  it("keeps reading many small events that each stay under the limit of an event", async () => {
    const reader = createSseEventReader(
      streamOf(...Array.from({ length: 50 }, () => "data: 0123456789\n\n")),
      1_000_000,
      100,
    );

    expect(await all(reader)).toHaveLength(50);
  });

  it("reads a large event that arrives in one-byte chunks in linear time", async () => {
    const encoder = new TextEncoder();
    const payload = encoder.encode(`data: ${"x".repeat(100_000)}\r\n\r\n`);
    let position = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        // Many small chunks: a reader that scans the whole buffer again for each of them takes minutes here.
        for (let count = 0; count < 5000 && position < payload.length; count++)
          controller.enqueue(payload.slice(position, ++position));
        if (position >= payload.length) controller.close();
      },
    });
    const reader = createSseEventReader(body, 1_000_000, 200_000);

    const started = Date.now();
    const event = await reader.next();

    expect(event?.data).toHaveLength(100_000);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("keeps the order of events when one chunk holds several, and when an empty line is split over chunks", async () => {
    const reader = createSseEventReader(
      streamOf("data: a\n", "\ndata: b\n\ndata: c\n", "\n"),
      1000,
    );

    expect((await all(reader)).map((event) => event.data)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });
});
