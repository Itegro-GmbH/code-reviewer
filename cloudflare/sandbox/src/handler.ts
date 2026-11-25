// SPDX-License-Identifier: LicenseRef-Proprietary

// The HTTP side of contracts/cf-sandbox.v1.json: authenticates, routes, validates and calls the VM's Durable Object and the registry
// through two small clients (the Durable Object stubs satisfy them; the tests pass fakes). Every body is JSON, every failure is
// `{ "error": kind }` and nothing else.
import { bearerAllowed } from "./auth.ts";
import { instanceOption, type Config } from "./config.ts";
import { errorResponse, type FailureKind, type Result } from "./errors.ts";
import type { VmEntry } from "./lifecycle.ts";
import type { NetworkPolicy } from "./policy.ts";
import type { InstanceOption } from "./ports.ts";
import { routeOf } from "./router.ts";
import type { ReserveAnswer } from "./registry-controller.ts";
import {
  checkCreate,
  checkExec,
  checkListFilter,
  checkNetwork,
  checkStartProcess,
  checkStdin,
  checkWaitMs,
  MAX_BODY_BYTES,
  validName,
  validProcessId,
  type ListFilter,
} from "./validate.ts";
import type {
  ExecAnswer,
  ExecCommand,
  ProcessAnswer,
  StartRequest,
} from "./vm-controller.ts";

export interface RegistryClient {
  reserve(
    entry: Omit<VmEntry, "status">,
    maxVms: number,
  ): Promise<ReserveAnswer>;
  setRunning(name: string): Promise<void>;
  remove(name: string): Promise<void>;
  list(filter: ListFilter): Promise<VmEntry[]>;
}

export interface VmClient {
  start(request: StartRequest): Promise<Result<null>>;
  exec(command: ExecCommand): Promise<Result<ExecAnswer>>;
  startProcess(command: {
    label: string;
    cmd: string;
    args: string[];
  }): Promise<Result<{ processId: string }>>;
  writeStdin(processId: string, data: string): Promise<Result<null>>;
  closeStdin(processId: string): Promise<Result<null>>;
  waitProcess(
    processId: string,
    waitMs: number,
  ): Promise<Result<ProcessAnswer>>;
  setPolicy(policy: NetworkPolicy): Promise<Result<null>>;
  destroy(): Promise<void>;
}

export type HandlerDeps = {
  config: Config;
  /** The secret `CF_SANDBOX_TOKEN`. */
  token: string | undefined;
  registry: RegistryClient;
  vm(name: string): VmClient;
  now(): number;
};

const noContent = () => new Response(null, { status: 204 });

function failure(result: { ok: false; kind: FailureKind }): Response {
  return errorResponse(result.kind);
}

async function readBody(request: Request): Promise<unknown | undefined> {
  const length = Number(request.headers.get("content-length") ?? "0");
  if (length > MAX_BODY_BYTES) return undefined;
  try {
    const text = await request.text();
    if (text.length > MAX_BODY_BYTES) return undefined;
    return text === "" ? undefined : (JSON.parse(text) as unknown);
  } catch {
    return undefined;
  }
}

export async function handle(
  request: Request,
  deps: HandlerDeps,
): Promise<Response> {
  const url = new URL(request.url);
  const route = routeOf(request.method, url.pathname);

  if (route?.kind === "health") {
    const { config } = deps;
    return Response.json({
      ok: true,
      imageVersion: config.imageVersion,
      workerFeatures: config.workerFeatures,
      instanceTypes: config.instanceTypes,
      ...(config.workerImageId ? { workerImageId: config.workerImageId } : {}),
      ...(config.agentImageId ? { agentImageId: config.agentImageId } : {}),
    });
  }

  if (!(await bearerAllowed(request.headers.get("authorization"), deps.token)))
    return errorResponse("auth_failed");
  if (route === null) return errorResponse("not_ready");

  try {
    switch (route.kind) {
      case "create":
        return await create(request, deps);
      case "list": {
        const filter = checkListFilter(url.searchParams);
        if (!filter.ok) return errorResponse("rejected");
        const vms = await deps.registry.list(filter.value);
        return Response.json({
          vms: vms.map((v) => ({
            name: v.name,
            createdAtMs: v.createdAtMs,
            status: v.status,
            timeoutMs: v.timeoutMs,
            tags: v.tags,
          })),
        });
      }
      case "delete": {
        if (!validName(route.name)) return errorResponse("rejected");
        await deps.vm(route.name).destroy();
        await deps.registry.remove(route.name);
        return noContent();
      }
      default:
        break;
    }

    if (!validName(route.name)) return errorResponse("rejected");
    const vm = deps.vm(route.name);
    switch (route.kind) {
      case "exec": {
        const body = checkExec(await readBody(request));
        if (!body.ok) return errorResponse("rejected");
        const result = await vm.exec(body.value);
        return result.ok ? Response.json(result.value) : failure(result);
      }
      case "network": {
        const body = checkNetwork(await readBody(request));
        if (!body.ok) return errorResponse("rejected");
        const result = await vm.setPolicy(body.value);
        return result.ok ? noContent() : failure(result);
      }
      case "startProcess": {
        const body = checkStartProcess(await readBody(request));
        if (!body.ok) return errorResponse("rejected");
        const result = await vm.startProcess(body.value);
        return result.ok
          ? Response.json(result.value, { status: 201 })
          : failure(result);
      }
      case "processStatus": {
        if (!validProcessId(route.id)) return errorResponse("rejected");
        const wait = checkWaitMs(url.searchParams.get("waitMs"));
        if (!wait.ok) return errorResponse("rejected");
        const result = await vm.waitProcess(route.id, wait.value);
        return result.ok ? Response.json(result.value) : failure(result);
      }
      case "stdin": {
        if (!validProcessId(route.id)) return errorResponse("rejected");
        const body = checkStdin(await readBody(request));
        if (!body.ok) return errorResponse("rejected");
        const result = await vm.writeStdin(route.id, body.value);
        return result.ok ? noContent() : failure(result);
      }
      case "stdinClose": {
        if (!validProcessId(route.id)) return errorResponse("rejected");
        const result = await vm.closeStdin(route.id);
        return result.ok ? noContent() : failure(result);
      }
      default:
        return errorResponse("not_ready");
    }
  } catch {
    // An exception of the platform: its text is not ours to show or log.
    return errorResponse("unavailable");
  }
}

async function create(request: Request, deps: HandlerDeps): Promise<Response> {
  const body = checkCreate(await readBody(request), deps.config.instanceTypes);
  if (!body.ok) return errorResponse("rejected");
  const { name, instanceType, timeoutMs, tags } = body.value;
  const createdAtMs = deps.now();
  const reserved = await deps.registry.reserve(
    { name, instanceType, createdAtMs, timeoutMs, tags },
    deps.config.maxVms,
  );
  if (reserved === "exists") return errorResponse("rejected");
  if (reserved === "full") return errorResponse("rate_limited");
  const vm = deps.vm(name);
  const instance: InstanceOption = instanceOption(deps.config, instanceType);
  let started: Result<null>;
  try {
    started = await vm.start({
      name,
      instanceType,
      instance,
      timeoutMs,
      createdAtMs,
    });
  } catch {
    started = { ok: false, kind: "unavailable" };
  }
  if (!started.ok) {
    await vm.destroy().catch(() => undefined);
    await deps.registry.remove(name).catch(() => undefined);
    return errorResponse(started.kind);
  }
  await deps.registry.setRunning(name);
  return Response.json({ name, instanceType }, { status: 201 });
}
