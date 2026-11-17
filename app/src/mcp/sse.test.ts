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
});
