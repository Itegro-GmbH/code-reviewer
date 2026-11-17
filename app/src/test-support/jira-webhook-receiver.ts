// SPDX-License-Identifier: LicenseRef-Proprietary

// A loopback HTTP server in front of a webhook handler, for the tests of the Jira webhook (#1039): the fake Atlassian CALLS the address a
// webhook was registered with, so the address has to be a real one. It turns the request into a `Request`, hands it to the handler and writes
// the `Response` back. The handler is looked up on every request, so a test can make the server before the handler it serves.
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";

export type WebhookReceiver = {
  /** `http://127.0.0.1:<port>`: what the app would call its public address. */
  url: string;
  close(): Promise<void>;
};

function readBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

export async function startWebhookReceiver(
  handler: () => (request: Request) => Promise<Response>,
): Promise<WebhookReceiver> {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const body = await readBody(req);
      const headers = new Headers();
      for (const [name, value] of Object.entries(req.headers))
        if (typeof value === "string") headers.set(name, value);
      const response = await handler()(
        new Request(`http://127.0.0.1${req.url ?? "/"}`, {
          method: req.method ?? "POST",
          headers,
          body: req.method === "GET" ? null : new Uint8Array(body),
        }),
      );
      res.writeHead(response.status, { "content-type": "application/json" });
      res.end(await response.text());
    })().catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${String(port)}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
