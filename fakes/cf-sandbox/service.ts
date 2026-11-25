// SPDX-License-Identifier: LicenseRef-Proprietary

// The double of the cf-sandbox API (contracts/cf-sandbox.v1.json, #1158, #1159): a `fetch` function, no socket, that answers like the Worker `cr-sandbox`
// does. Nothing here imports the Dispatcher, because `fakes/` is shared by every project. No command runs: `onExec(label, answer)` scripts one, a process
// is held until `exitProcess` ends it. Every request is kept (`requests`) so a test can check the bearer, the bodies and that no secret travelled
// where it must not. Dummy values only.
import { mountinfoAfter } from "../sandbox/mountinfo.ts";

export type FakeCfRequest = {
  method: string;
  path: string;
  query: Record<string, string>;
  authorization: string | null;
  body: unknown;
};

type Vm = {
  name: string;
  instanceType: string;
  timeoutMs: number;
  tags: Record<string, string>;
  createdAtMs: number;
  status: "pending" | "running";
  policy: unknown;
  /** The commands run in it, for the mountinfo a read of it would show. */
  commands: { cmd: string; args: readonly string[] }[];
  processes: Map<
    string,
    { stdin: string; stdinClosed: boolean; exit: number | undefined }
  >;
};

type ExecAnswer = { exitCode: number; stdout?: string; stderr?: string };

export type FakeCfSandboxOptions = {
  token: string;
  instanceTypes?: string[];
  workerFeatures?: string[];
  imageVersion?: string;
  workerImageId?: string | null;
  now?: () => number;
  /** How long a poll of a running process holds before it answers `running: true`, in real milliseconds (the real Worker holds `waitMs`). Default 20. */
  pollDelayMs?: number;
};

const NAME = /^[a-z0-9-]{1,63}$/;
const JSON_HEADERS = { "content-type": "application/json" };

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: JSON_HEADERS,
  });
}

function failure(status: number, error: string): Response {
  return json(status, { error });
}

export class FakeCfSandbox {
  readonly requests: FakeCfRequest[] = [];
  readonly vms = new Map<string, Vm>();
  readonly #options: Required<Omit<FakeCfSandboxOptions, "workerImageId">> & {
    workerImageId: string | null;
  };
  readonly #exec: { label: string | RegExp; answer: ExecAnswer }[] = [];
  #failNext: { status: number; body?: unknown } | undefined;
  #holdNextCreate: Promise<void> | undefined;
  #nextProcess = 0;
  #healthDown = false;

  constructor(options: FakeCfSandboxOptions) {
    this.#options = {
      instanceTypes: ["standard-4"],
      workerFeatures: [],
      imageVersion: "0123456789ab",
      now: () => Date.now(),
      pollDelayMs: 20,
      ...options,
      workerImageId:
        options.workerImageId === undefined
          ? `sha256:${"a".repeat(64)}`
          : options.workerImageId,
    };
  }

  /** The `fetch` the Dispatcher's client is given. */
  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
    );
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    const text = typeof init?.body === "string" ? init.body : undefined;
    const request: FakeCfRequest = {
      method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      authorization: headers.get("authorization"),
      body: text === undefined ? undefined : (JSON.parse(text) as unknown),
    };
    this.requests.push(request);
    if (init?.signal?.aborted) throw new DOMException("aborted", "AbortError");
    return this.#answer(request, init?.signal ?? undefined);
  };

  /** Scripts a command (by `label` or a regular expression of it) to end with `answer`; the default is exit 0 and no output. */
  onExec(label: string | RegExp, answer: ExecAnswer): void {
    this.#exec.push({ label, answer });
  }

  /** The next call (any) is answered with this status and body instead. */
  failNext(status: number, body?: unknown): void {
    this.#failNext = { status, body };
  }

  /** `GET /health` does not answer (503). */
  healthDown(down = true): void {
    this.#healthDown = down;
  }

  /** Keeps the next create pending until the returned function is called. */
  holdNextCreate(): () => void {
    let release!: () => void;
    this.#holdNextCreate = new Promise<void>((resolve) => {
      release = resolve;
    });
    return release;
  }

  /** Puts a VM on the platform that no launch made, with a status. */
  seedVm(vm: {
    name: string;
    tags?: Record<string, string>;
    createdAtMs?: number;
    timeoutMs?: number;
    status?: "pending" | "running";
  }): void {
    this.vms.set(vm.name, {
      name: vm.name,
      instanceType: "standard-4",
      timeoutMs: vm.timeoutMs ?? 3_600_000,
      tags: vm.tags ?? {},
      createdAtMs: vm.createdAtMs ?? this.#options.now(),
      status: vm.status ?? "running",
      policy: "allow-all",
      commands: [],
      processes: new Map(),
    });
  }

  /** Ends a process the Worker started with an exit code. */
  exitProcess(vmName: string, code: number): void {
    for (const process of this.vms.get(vmName)?.processes.values() ?? [])
      process.exit ??= code;
  }

  stdinOf(vmName: string): string {
    return [...(this.vms.get(vmName)?.processes.values() ?? [])]
      .map((process) => process.stdin)
      .join("");
  }

  /** Every request as text, for the scan that the credential travels in the stdin of the process and nowhere else. */
  requestText(): string {
    return this.requests
      .filter((request) => !request.path.endsWith("/stdin"))
      .map((request) => JSON.stringify(request))
      .join("\n");
  }

  async #answer(
    request: FakeCfRequest,
    signal: AbortSignal | undefined,
  ): Promise<Response> {
    const { method, path } = request;
    if (path === "/health" && method === "GET") {
      if (this.#healthDown) return failure(503, "unavailable");
      return json(200, {
        ok: true,
        imageVersion: this.#options.imageVersion,
        workerFeatures: this.#options.workerFeatures,
        instanceTypes: this.#options.instanceTypes,
        ...(this.#options.workerImageId === null
          ? {}
          : { workerImageId: this.#options.workerImageId }),
      });
    }
    if (request.authorization !== `Bearer ${this.#options.token}`)
      return failure(401, "auth_failed");
    if (this.#failNext !== undefined) {
      const next = this.#failNext;
      this.#failNext = undefined;
      return json(next.status, next.body ?? {});
    }
    if (path === "/v1/vms" && method === "POST")
      return this.#create(request, signal);
    if (path === "/v1/vms" && method === "GET") return this.#list(request);
    const match = /^\/v1\/vms\/([^/]+)(?:\/(.*))?$/.exec(path);
    if (match === null) return failure(404, "not_ready");
    const name = decodeURIComponent(match[1] ?? "");
    const rest = match[2] ?? "";
    if (rest === "" && method === "DELETE") {
      this.vms.delete(name);
      return new Response(null, { status: 204 });
    }
    const vm = this.vms.get(name);
    if (vm === undefined || vm.status !== "running")
      return failure(404, "not_ready");
    if (rest === "exec" && method === "POST") return this.#run(request, vm);
    if (rest === "network" && method === "PUT") {
      vm.policy = (request.body as { policy: unknown }).policy;
      return new Response(null, { status: 204 });
    }
    if (rest === "processes" && method === "POST") {
      this.#nextProcess += 1;
      const id = `p${String(this.#nextProcess)}`;
      vm.processes.set(id, { stdin: "", stdinClosed: false, exit: undefined });
      return json(201, { processId: id });
    }
    const process = /^processes\/([a-z0-9-]+)(?:\/(stdin|stdin\/close))?$/.exec(
      rest,
    );
    if (process !== null) {
      const state = vm.processes.get(process[1] ?? "");
      if (state === undefined) return failure(404, "not_ready");
      if (process[2] === "stdin" && method === "POST") {
        state.stdin += (request.body as { data: string }).data;
        return new Response(null, { status: 204 });
      }
      if (process[2] === "stdin/close" && method === "POST") {
        state.stdinClosed = true;
        return new Response(null, { status: 204 });
      }
      if (process[2] === undefined && method === "GET") {
        // A poll holds like the real one does, so a client that loops does not spin: until the process ends, the caller gives up, or the delay is over.
        if (state.exit === undefined)
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(resolve, this.#options.pollDelayMs);
            signal?.addEventListener(
              "abort",
              () => {
                clearTimeout(timer);
                reject(new DOMException("aborted", "AbortError"));
              },
              { once: true },
            );
          });
        return json(
          200,
          state.exit === undefined
            ? { running: true }
            : { running: false, exitCode: state.exit },
        );
      }
    }
    return failure(404, "not_ready");
  }

  async #create(
    request: FakeCfRequest,
    signal: AbortSignal | undefined,
  ): Promise<Response> {
    const body = request.body as {
      name?: unknown;
      instanceType?: unknown;
      timeoutMs?: unknown;
      tags?: Record<string, string>;
    };
    if (
      typeof body.name !== "string" ||
      !NAME.test(body.name) ||
      typeof body.instanceType !== "string" ||
      !this.#options.instanceTypes.includes(body.instanceType) ||
      typeof body.timeoutMs !== "number" ||
      body.timeoutMs < 60_000 ||
      this.vms.has(body.name)
    )
      return failure(400, "rejected");
    if (this.#holdNextCreate !== undefined) {
      const held = this.#holdNextCreate;
      this.#holdNextCreate = undefined;
      await Promise.race([
        held,
        new Promise<never>((_resolve, reject) =>
          signal?.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true },
          ),
        ),
      ]);
    }
    this.vms.set(body.name, {
      name: body.name,
      instanceType: body.instanceType,
      timeoutMs: body.timeoutMs,
      tags: body.tags ?? {},
      createdAtMs: this.#options.now(),
      status: "running",
      policy: "allow-all",
      commands: [],
      processes: new Map(),
    });
    return json(201, { name: body.name, instanceType: body.instanceType });
  }

  #list(request: FakeCfRequest): Response {
    const prefix = request.query.namePrefix ?? "";
    const tag = request.query.tag;
    const [key, value] =
      tag === undefined
        ? [undefined, undefined]
        : [tag.slice(0, tag.indexOf(":")), tag.slice(tag.indexOf(":") + 1)];
    const vms = [...this.vms.values()]
      .filter((vm) => vm.name.startsWith(prefix))
      .filter((vm) => key === undefined || vm.tags[key] === value)
      .map((vm) => ({
        name: vm.name,
        createdAtMs: vm.createdAtMs,
        status: vm.status,
        timeoutMs: vm.timeoutMs,
        tags: vm.tags,
      }));
    return json(200, { vms });
  }

  #run(request: FakeCfRequest, vm: Vm): Response {
    const body = request.body as { label: string; cmd: string; args: string[] };
    vm.commands.push({ cmd: body.cmd, args: body.args });
    const scripted = this.#exec.find((entry) =>
      typeof entry.label === "string"
        ? entry.label === body.label
        : entry.label.test(body.label),
    );
    // The mounts of the VM as the commands made them, unless scripted (the work volume's check reads them back).
    const mountinfo =
      scripted === undefined &&
      body.cmd === "cat" &&
      body.args[0] === "/proc/self/mountinfo"
        ? mountinfoAfter(vm.commands)
        : undefined;
    return json(200, {
      exitCode: scripted?.answer.exitCode ?? 0,
      stdout: mountinfo ?? scripted?.answer.stdout ?? "",
      stderr: scripted?.answer.stderr ?? "",
    });
  }
}
