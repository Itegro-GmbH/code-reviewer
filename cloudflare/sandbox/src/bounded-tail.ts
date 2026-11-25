// SPDX-License-Identifier: LicenseRef-Proprietary

/** The most of a command's stdout or stderr the API answers: the last bytes (the end of a log says why a step failed). */
export const OUTPUT_CAP_BYTES = 262_144;

/** Keeps the last `max` bytes that were pushed, in memory of at most about twice that. */
export class TailBuffer {
  readonly #max: number;
  #chunks: Uint8Array[] = [];
  #size = 0;
  #truncated = false;

  constructor(max: number = OUTPUT_CAP_BYTES) {
    this.#max = max;
  }

  push(chunk: Uint8Array): void {
    if (chunk.length === 0) return;
    this.#chunks.push(chunk);
    this.#size += chunk.length;
    while (this.#size - (this.#chunks[0]?.length ?? 0) >= this.#max) {
      const dropped = this.#chunks.shift();
      this.#size -= dropped?.length ?? 0;
      this.#truncated = true;
    }
    if (this.#size > this.#max * 2) this.#compact();
  }

  #compact(): void {
    const all = this.#joined();
    this.#chunks = [all.subarray(all.length - this.#max)];
    this.#size = this.#chunks[0]?.length ?? 0;
    this.#truncated = true;
  }

  #joined(): Uint8Array {
    const out = new Uint8Array(this.#size);
    let at = 0;
    for (const chunk of this.#chunks) {
      out.set(chunk, at);
      at += chunk.length;
    }
    return out;
  }

  get truncated(): boolean {
    return this.#truncated || this.#size > this.#max;
  }

  /** The kept bytes as text (invalid UTF-8, also a character cut at the start, becomes U+FFFD). */
  text(): string {
    const all = this.#joined();
    const kept =
      all.length > this.#max ? all.subarray(all.length - this.#max) : all;
    return new TextDecoder("utf-8").decode(kept);
  }
}

/** Reads a stream to its end into a tail buffer; a stream that is `null` or breaks ends the read quietly. */
export async function drain(
  stream: ReadableStream<Uint8Array> | null,
  into: TailBuffer,
): Promise<void> {
  if (stream === null) return;
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      into.push(value);
    }
  } catch {
    // A killed process or a destroyed Container breaks its streams: what was read stays.
  } finally {
    reader.releaseLock();
  }
}
