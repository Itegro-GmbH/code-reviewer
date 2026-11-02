// SPDX-License-Identifier: LicenseRef-Proprietary

// `pnpm snapshot:build -- --context <tgz> --vm-prepare <sh> --sysbox-prepare <sh> --out <json> [...]` (see cli.ts, docs/golden-snapshot.md).
// The one place that touches the file system, the process and the real platform SDK. Node strips the types.
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { runCli } from "./cli.ts";
import { createVercelService } from "./vercel-service.ts";
import type { SandboxSdk } from "./vercel-service.ts";

const abort = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => abort.abort());

const code = await runCli(process.argv.slice(2), {
  env: process.env,
  stdout: (text) => process.stdout.write(text),
  stderr: (line) => process.stderr.write(`${line}\n`),
  readFile: (path) => readFileSync(path),
  writeFile: (path, text) => writeFileSync(path, text, { mode: 0o600 }),
  removeFile: (path) => rmSync(path, { force: true }),
  createService: async (credentials) => {
    // Loaded here so that nothing else in the Dispatcher, and no test, imports the platform SDK.
    const { Sandbox } = await import("@vercel/sandbox");
    return createVercelService({ Sandbox } satisfies SandboxSdk, credentials);
  },
  signal: abort.signal,
});
// Not process.exit: a record on a piped stdout must drain first. The timer is a backstop for a socket the SDK keeps open.
process.exitCode = code;
setTimeout(() => process.exit(code), 10_000).unref();
