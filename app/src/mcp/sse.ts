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

/** What one event may hold, unless the caller says otherwise: an event is held in memory until its empty line arrives. */
export const SSE_EVENT_MAX_LENGTH = 128 * 1024;

/**
 * `maxBytes` bounds the whole stream, `maxEventLength` (characters) one event that has not ended yet. Both end the read with `SseTooLargeError`.
 * The work is linear in what arrives: a chunk is searched for the empty line once (plus the one character before it that may have started it),
 * never the whole buffer again, so a server that sends one byte at a time cannot make the reader quadratic.
 */
export function createSseEventReader(
  body: ReadableStream<Uint8Array>,
  maxBytes: number,
  maxEventLength: number = SSE_EVENT_MAX_LENGTH,
): SseEventReader {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  /** The text of the event that has not ended yet, in pieces (joined only when it ends). */
  let parts: string[] = [];
  let size = 0;
  let lastChar = "";
  /** The last text ended with a CR: an LF that follows it belongs to it. */
  let afterCr = false;
  const ready: SseEvent[] = [];
  let total = 0;
  let ended = false;

  /** Line ends as LF: CRLF and CR alone become one LF; a CR at the end of a chunk is remembered for the LF that may follow. */
  function normalize(text: string): string {
    if (text === "") return "";
    const lead = afterCr && text.startsWith("\n") ? text.slice(1) : text;
    afterCr = text.endsWith("\r");
    return lead.replace(/\r\n|\r/g, "\n");
  }

  function finish(block: string): void {
    parts = [];
    size = 0;
    lastChar = "";
    const event = parseBlock(block);
    if (event !== null) ready.push(event);
  }

  function feed(text: string): void {
    let start = 0;
    while (start < text.length) {
      // The empty line may begin at the end of what came before: its first LF is the last character of the event so far.
      if (start === 0 && lastChar === "\n" && text.startsWith("\n")) {
        finish(parts.join("").slice(0, -1));
        start = 1;
        continue;
      }
      const end = text.indexOf("\n\n", start);
      const stop = end === -1 ? text.length : end;
      if (size + (stop - start) > maxEventLength) throw new SseTooLargeError();
      if (end === -1) {
        parts.push(start === 0 ? text : text.slice(start));
        size += text.length - start;
        lastChar = text.charAt(text.length - 1);
        return;
      }
      finish(parts.join("") + text.slice(start, end));
      start = end + 2;
    }
  }

  return {
    async next() {
      for (;;) {
        const event = ready.shift();
        if (event !== undefined) return event;
        if (ended) return null;
        const { done, value } = await reader.read();
        if (done) {
          ended = true;
          feed(normalize(decoder.decode()));
          // An event that ends with the stream and no empty line counts.
          const rest = parts.join("");
          if (rest.trim() !== "") finish(rest);
          continue;
        }
        total += value.length;
        if (total > maxBytes) throw new SseTooLargeError();
        feed(normalize(decoder.decode(value, { stream: true })));
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
