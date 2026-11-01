// SPDX-License-Identifier: LicenseRef-Proprietary

// The Git part of the fake GitHub: the smart HTTP upload-pack of a repository the test registered, so that
// the runner's own Git transport (`dynamic_review/transport.py`: `GET <repo>.git/info/refs?service=git-upload-pack`
// and `POST <repo>.git/git-upload-pack`, Basic authentication with the user `x-access-token` and an
// installation token) checks a pull request out of a fake, with the unchanged production code. The
// repository is real Git (`git-fixture.ts`) and the protocol is served by the real `git upload-pack`
// (stateless, protocol version 0 like the runner speaks it); only the HTTP framing is done here. The
// authorization of the token is the GitHub App part's (`app-api.ts`).
//
// The push (#766) is the real `git receive-pack` the same way, for the Implementer's branch. A new branch and a
// branch that moves forward are accepted. The fake is stricter than GitHub on purpose: it refuses a history that is
// not a fast-forward of the branch (which also stops `--force`) and the deletion of a branch, while GitHub accepts
// both on a branch without protection. A test therefore cannot learn from the fake that a client never forces: it
// asserts the client's command. Nothing else is refused: tags, `refs/notes/*` and a fast-forward of the default
// branch are accepted (a test asserts which refs were pushed). The repository is a fixture the test made, so a push
// to its checked out branch is accepted as well and leaves its working tree alone. No hook runs. No other service.
import { spawn } from "node:child_process";
import type { IncomingMessage, ServerResponse } from "node:http";
import { gunzipSync } from "node:zlib";

/** The installation token of a `Basic x-access-token:<token>` header, or undefined. */
export function basicToken(header: string | undefined): string | undefined {
  if (header === undefined || !header.startsWith("Basic ")) return undefined;
  const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
  const colon = decoded.indexOf(":");
  if (colon < 0 || decoded.slice(0, colon) !== "x-access-token")
    return undefined;
  return decoded.slice(colon + 1);
}

async function readRaw(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  const body = Buffer.concat(chunks);
  // A real Git client compresses a large request.
  return request.headers["content-encoding"] === "gzip"
    ? gunzipSync(body)
    : body;
}

const GIT_ENVIRONMENT = {
  HOME: "/nonexistent",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
};

/** Runs a Git service of the repository over the bytes of the request; resolves with what it printed. */
function serve(
  config: string[],
  args: string[],
  input: Buffer,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const environment: Record<string, string> = {
      PATH: process.env.PATH ?? "",
      ...GIT_ENVIRONMENT,
    };
    const child = spawn(
      "git",
      [...config.flatMap((setting) => ["-c", setting]), ...args],
      {
        // Next's types make NODE_ENV a required variable; Git does not read it.
        env: environment as NodeJS.ProcessEnv,
        stdio: ["pipe", "pipe", "ignore"],
      },
    );
    const out: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0
        ? resolve(Buffer.concat(out))
        : reject(new Error(`git ${args[0] ?? ""} exited with ${String(code)}`)),
    );
    child.stdin.on("error", () => {
      // The service may close its input early; the exit status tells.
    });
    child.stdin.end(input);
  });
}

function uploadPack(
  repositoryPath: string,
  input: Buffer,
  advertise: boolean,
): Promise<Buffer> {
  return serve(
    [
      "core.hooksPath=/dev/null",
      "uploadpack.allowAnySHA1InWant=true",
      "uploadpack.allowFilter=true",
    ],
    [
      "upload-pack",
      "--stateless-rpc",
      ...(advertise ? ["--advertise-refs"] : []),
      repositoryPath,
    ],
    input,
  );
}

function receivePack(
  repositoryPath: string,
  input: Buffer,
  advertise: boolean,
): Promise<Buffer> {
  return serve(
    [
      "core.hooksPath=/dev/null",
      // Stricter than GitHub on purpose (see the top of the file): GitHub accepts a forced push and a deletion on a
      // branch without protection.
      "receive.denyNonFastForwards=true",
      "receive.denyDeletes=true",
      "receive.denyCurrentBranch=ignore",
      "receive.autogc=false",
    ],
    [
      "receive-pack",
      "--stateless-rpc",
      ...(advertise ? ["--advertise-refs"] : []),
      repositoryPath,
    ],
    input,
  );
}

/**
 * Answers `info/refs` (advertise) or `git-upload-pack` (the request body) for a repository directory. The caller
 * has judged the token and found the repository.
 */
export async function serveUploadPack(
  request: IncomingMessage,
  response: ServerResponse,
  repositoryPath: string,
  advertise: boolean,
): Promise<void> {
  let payload: Buffer;
  try {
    payload = await uploadPack(
      repositoryPath,
      advertise ? Buffer.alloc(0) : await readRaw(request),
      advertise,
    );
  } catch {
    response.writeHead(500, { "content-type": "text/plain" });
    response.end("git upload-pack failed");
    return;
  }
  if (advertise) {
    payload = Buffer.concat([
      Buffer.from("001e# service=git-upload-pack\n0000"),
      payload,
    ]);
  }
  response.writeHead(200, {
    "content-type": advertise
      ? "application/x-git-upload-pack-advertisement"
      : "application/x-git-upload-pack-result",
    "cache-control": "no-cache",
    "content-length": String(payload.length),
  });
  response.end(payload);
}

const OBJECT_NAME = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

/**
 * The names of the refs a push asks to update: the commands (`<old> <new> <ref>`, the first with the capabilities
 * after a NUL) in the pkt-lines at the start of the request, up to the flush before the pack. Names only.
 */
export function pushedRefs(body: Buffer): string[] {
  const refs: string[] = [];
  let offset = 0;
  while (offset + 4 <= body.length) {
    const length = Number.parseInt(
      body.toString("latin1", offset, offset + 4),
      16,
    );
    if (!Number.isInteger(length) || length === 0) break;
    if (length < 4 || offset + length > body.length) break;
    const line = body
      .toString("latin1", offset + 4, offset + length)
      .split("\0")[0]
      ?.trimEnd();
    offset += length;
    const [oldName, newName, ref, ...rest] = (line ?? "").split(" ");
    if (
      ref !== undefined &&
      rest.length === 0 &&
      OBJECT_NAME.test(oldName ?? "") &&
      OBJECT_NAME.test(newName ?? "")
    )
      refs.push(ref);
  }
  return refs;
}

/**
 * Answers `info/refs` (advertise) or `git-receive-pack` (the push) for a repository directory, like
 * `serveUploadPack`; the caller has judged the token (`contents: write`) and found the repository. Returns the ref
 * names the push asked to update (none for the advertisement), whether or not Git accepted them.
 */
export async function serveReceivePack(
  request: IncomingMessage,
  response: ServerResponse,
  repositoryPath: string,
  advertise: boolean,
): Promise<string[]> {
  let payload: Buffer;
  let refs: string[] = [];
  try {
    const body = advertise ? Buffer.alloc(0) : await readRaw(request);
    refs = advertise ? [] : pushedRefs(body);
    payload = await receivePack(repositoryPath, body, advertise);
  } catch {
    response.writeHead(500, { "content-type": "text/plain" });
    response.end("git receive-pack failed");
    return refs;
  }
  if (advertise) {
    payload = Buffer.concat([
      Buffer.from("001f# service=git-receive-pack\n0000"),
      payload,
    ]);
  }
  response.writeHead(200, {
    "content-type": advertise
      ? "application/x-git-receive-pack-advertisement"
      : "application/x-git-receive-pack-result",
    "cache-control": "no-cache",
    "content-length": String(payload.length),
  });
  response.end(payload);
  return refs;
}
