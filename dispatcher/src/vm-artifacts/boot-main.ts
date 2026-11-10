// SPDX-License-Identifier: LicenseRef-Proprietary

// Starts one Firecracker microVM from the release's artifacts and reads its events from the console (#976). The two uses in CI:
//   --mode seed   boots with the image archive as a third drive; vm-init loads it into Docker on the data disk and reports the image ids
//                 (written to --images-out)
//   --mode smoke  boots from the finished data disk and decides with `evaluateSmoke` (dockerd ready within the budget, Sysbox ready, the
//                 images of the data disk, the checks of vm-init)
// Needs /dev/kvm. Exit status: 0 the expectation held, 1 it did not (the problems are on stderr), 2 wrong use.
import { spawn } from "node:child_process";
import {
  createWriteStream,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { firecrackerConfig } from "./boot.ts";
import type { BootMode } from "./boot.ts";
import { evaluateSmoke, parseConsoleLine } from "./console.ts";
import type { ConsoleEvent } from "./console.ts";

const { values } = parseArgs({
  options: {
    firecracker: { type: "string", default: "firecracker" },
    kernel: { type: "string" },
    rootfs: { type: "string" },
    data: { type: "string" },
    seed: { type: "string" },
    mode: { type: "string" },
    work: { type: "string" },
    vcpus: { type: "string", default: "2" },
    mem: { type: "string", default: "4096" },
    "timeout-s": { type: "string", default: "600" },
    "images-in": { type: "string" },
    "images-out": { type: "string" },
    "events-out": { type: "string" },
    "docker-ready-budget-ms": { type: "string", default: "10000" },
  },
});

function usage(message: string): never {
  console.error(`boot-main: ${message}`);
  process.exit(2);
}
const need = (name: keyof typeof values): string =>
  (values[name] as string | undefined) ?? usage(`--${name} is required`);

const mode = need("mode");
if (mode !== "seed" && mode !== "smoke" && mode !== "run")
  usage("--mode is seed, smoke or run");
const work = need("work");
mkdirSync(work, { recursive: true });

const config = firecrackerConfig({
  kernelPath: need("kernel"),
  rootfsPath: need("rootfs"),
  dataDiskPath: need("data"),
  ...(values.seed === undefined ? {} : { seedDiskPath: values.seed }),
  mode: mode as BootMode,
  vcpus: Number(values.vcpus),
  memMib: Number(values.mem),
  console: true,
});
const configPath = join(work, "firecracker.json");
writeFileSync(configPath, JSON.stringify(config, null, 2));

const events: ConsoleEvent[] = [];
const consoleLog = createWriteStream(join(work, "console.log"));
const started = Date.now();
const child = spawn(
  values.firecracker as string,
  ["--no-api", "--config-file", configPath],
  {
    stdio: ["ignore", "pipe", "pipe"],
  },
);
const timeoutMs = Number(values["timeout-s"]) * 1000;
const timer = setTimeout(() => {
  console.error(
    `boot-main: no end within ${timeoutMs / 1000} s, killing the VM`,
  );
  child.kill("SIGKILL");
}, timeoutMs);

createInterface({ input: child.stdout }).on("line", (line) => {
  consoleLog.write(`${line}\n`);
  const event = parseConsoleLine(line);
  if (!event) return;
  events.push({ ...event, hostMs: Date.now() - started });
  console.error(
    `[${((Date.now() - started) / 1000).toFixed(2)}s] ${event.name} ${JSON.stringify(event.fields)}`,
  );
});
child.stderr.on("data", (chunk: Buffer) => consoleLog.write(chunk));

const code = await new Promise<number | null>((resolve) =>
  child.on("close", resolve),
);
clearTimeout(timer);
consoleLog.end();
if (values["events-out"])
  writeFileSync(values["events-out"], `${JSON.stringify(events, null, 2)}\n`);
console.error(
  `boot-main: Firecracker ended with ${code} after ${((Date.now() - started) / 1000).toFixed(1)} s`,
);

const problems: string[] = [];
if (mode === "seed") {
  if (!events.some((event) => event.name === "seed_done"))
    problems.push("seed_done: missing");
  const image = (role: string): { tag: string; id: string } | undefined => {
    const event = events.find(
      (e) => e.name === "image" && e.fields.role === role,
    );
    const { tag, id } = event?.fields ?? {};
    return tag && id ? { tag, id } : undefined;
  };
  const worker = image("worker");
  const agent = image("agent");
  if (!worker || !/^sha256:[0-9a-f]{64}$/.test(worker.id))
    problems.push("image worker: no id");
  if (!agent || !/^sha256:[0-9a-f]{64}$/.test(agent.id))
    problems.push("image agent: no id");
  const store = events.find((event) => event.name === "store");
  console.error(
    `boot-main: image store ${JSON.stringify(store?.fields ?? {})}`,
  );
  if (problems.length === 0 && values["images-out"])
    writeFileSync(
      values["images-out"],
      `${JSON.stringify({ worker, agent, store: store?.fields }, null, 2)}\n`,
    );
}
if (mode === "smoke") {
  const expected = JSON.parse(readFileSync(need("images-in"), "utf8")) as {
    worker: { id: string };
    agent: { id: string };
  };
  const verdict = evaluateSmoke(events, {
    dockerReadyBudgetMs: Number(values["docker-ready-budget-ms"]),
    expectedImages: { worker: expected.worker.id, agent: expected.agent.id },
  });
  problems.push(...verdict.problems);
}
if (problems.length > 0) {
  for (const problem of problems) console.error(`boot-main: ${problem}`);
  console.error("--- console tail ---");
  console.error(
    readFileSync(join(work, "console.log"), "utf8")
      .split("\n")
      .slice(-80)
      .join("\n"),
  );
  process.exit(1);
}
const dockerReady = events.find((event) => event.name === "docker_ready");
console.error(
  `boot-main: ok (docker_ready ${dockerReady?.hostMs ?? "?"} ms after the start of Firecracker)`,
);
