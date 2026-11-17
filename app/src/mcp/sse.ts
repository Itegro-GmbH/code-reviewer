// SPDX-License-Identifier: LicenseRef-Proprietary

// A reader of a `text/event-stream` body (#1050): the events of an MCP server's answer, one at a time, with a hard limit on what is read.
// Server-sent events (WHATWG HTML, "Server-sent events"): lines end with LF, CR or CRLF; an empty line ends an event; `:` starts a comment;
// `event:` names the event (default `message`), `data:` lines are joined with LF. `retry:` and `id:` are not needed here and are ignored.
// Pure but for the stream it is given; a limit that is passed ends the read with `SseTooLargeError`.
export type SseEvent = { event: string; data: string };

export class SseTooLargeError extends Error {
  constructor() {
    super("The event stream is larger than the limit.");
    this.name = "SseTooLargeError";
  }
}

export type SseEventReader = {
  /** The next event, or null when the stream ended. */
  next(): Promise<SseEvent | null>;
  /** Stops reading and lets the connection go. */
  close(): Promise<void>;
};

function parseBlock(block: string): SseEvent | null {
  let event = "message";
  const data: string[] = [];
  for (const line of block.split("\n")) {
    if (line === "" || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
  }
  return data.length === 0 ? null : { event, data: data.join("\n") };
}

export function createSseEventReader(
  body: ReadableStream<Uint8Array>,
  maxBytes: number,
): SseEventReader {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let total = 0;
  let ended = false;

  /** The next complete block of the buffer, or undefined. A CR at the very end waits for the byte that may follow it. */
  function takeBlock(): string | undefined {
    const waiting = buffer.endsWith("\r");
    const settled = (waiting ? buffer.slice(0, -1) : buffer).replace(
      /\r\n|\r/g,
      "\n",
    );
    const end = settled.indexOf("\n\n");
    if (end === -1) return undefined;
    const block = settled.slice(0, end);
    buffer = settled.slice(end + 2) + (waiting ? "\r" : "");
    return block;
  }

  return {
    async next() {
      for (;;) {
        const block = takeBlock();
        if (block !== undefined) {
          const event = parseBlock(block);
          if (event !== null) return event;
          continue;
        }
        if (ended) return null;
        const { done, value } = await reader.read();
        if (done) {
          ended = true;
          buffer += decoder.decode();
          // An event that ends with the stream and no empty line counts.
          if (buffer.trim() !== "") buffer += "\n\n";
          continue;
        }
        total += value.length;
        if (total > maxBytes) throw new SseTooLargeError();
        buffer += decoder.decode(value, { stream: true });
      }
    },
    async close() {
      try {
        await reader.cancel();
      } catch {
        // The connection is gone already.
      }
    },
  };
}
