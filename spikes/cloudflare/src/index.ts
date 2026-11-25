// SPDX-License-Identifier: LicenseRef-Proprietary
//
// Spike #1149: a Worker plus one Durable Object class that owns one Cloudflare Container (scheduling policy `durable_object`).
// It exists to MEASURE (docs/runner.md, "Spike: Cloudflare Containers (#1149)"), it is not the Cloudflare dispatcher.
//
// Safety rails of the spike (the issue's hard limits):
//   * every resource is named cr-spike-* (the Worker, this class, the image repository);
//   * every request needs the header `x-spike-secret` (a Worker secret, kept in a 0600 file outside the repo);
//   * only the two box names `a` and `b` exist, so at most two container instances can run at once;
//   * the inactivity timeout is short and set on every start.
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";

interface Env {
  BOX: DurableObjectNamespace<CrSpikeBox>;
  SPIKE_SECRET: string;
  MODEL_KEY: string; // a fake "model key": it lives in the Worker only; the test is whether the container can ever see it
}

type Policy = { mode: "allow" | "deny"; hosts: string[]; ports?: number[] };
type EgressEntry = { t: number; proto: string; host: string; port: string; method: string; path: string; verdict: string };

const BOXES = new Set(["a", "b"]);
const DEFAULT_POLICY: Policy = { mode: "deny", hosts: [] };

/** The outbound handler: HTTP and HTTPS of the container go through it (enableInternet=false). The rule lives in the DO and can change while the container runs. */
export class Door extends WorkerEntrypoint<Env, { box: string }> {
  async fetch(request: Request): Promise<Response> {
    const box = this.env.BOX.getByName(this.ctx.props.box);
    const url = new URL(request.url);
    const policy = await box.getPolicy();
    const allowed =
      policy.mode === "allow" && policy.hosts.some((h) => (h.startsWith("*.") ? url.hostname.endsWith(h.slice(1)) : url.hostname === h));
    await box.logEgress({
      t: Date.now(),
      proto: url.protocol,
      host: url.hostname,
      port: url.port || (url.protocol === "https:" ? "443" : "80"),
      method: request.method,
      path: url.pathname.slice(0, 80),
      verdict: allowed ? "allow" : "deny",
    });
    if (allowed && url.pathname.startsWith("/hb")) await box.heartbeat(url.pathname + url.search);
    if (!allowed) return new Response(`door: ${url.hostname} not allowed`, { status: 403, headers: { "x-door": "not_listed" } });
    return fetch(request, { redirect: "manual" });
  }
}

/** A fake model door inside the Worker: the key is added HERE, after the request left the sandbox. Echoes only a digest of what it holds. */
export class ModelDoor extends WorkerEntrypoint<Env, { box: string }> {
  async fetch(request: Request): Promise<Response> {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(this.env.MODEL_KEY));
    const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 12);
    const body = await request.text();
    return Response.json({
      door: "model",
      saw_authorization_header_from_container: request.headers.has("authorization"),
      key_digest_added_by_door: hex,
      method: request.method,
      path: new URL(request.url).pathname,
      body_bytes: body.length,
    });
  }
}

export class CrSpikeBox extends DurableObject<Env> {
  private egress: EgressEntry[] = [];

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // The inactivity timeout does not survive a restart of the Durable Object (docs: "Sandbox lifetime"): set it again here.
    const c = ctx.container;
    if (c?.running) {
      void ctx.blockConcurrencyWhile(async () => {
        const last = await ctx.storage.get<{ inactivityMs: number }>("lastBegin");
        await c.setInactivityTimeout(last?.inactivityMs ?? 5 * 60_000);
      });
    }
  }

  async getPolicy(): Promise<Policy> {
    return (await this.ctx.storage.get<Policy>("policy")) ?? DEFAULT_POLICY;
  }
  async setPolicy(policy: Policy): Promise<void> {
    await this.ctx.storage.put("policy", policy);
  }
  logEgress(entry: EgressEntry): void {
    this.egress.push(entry);
    if (this.egress.length > 500) this.egress.shift();
  }
  async heartbeat(what: string): Promise<void> {
    const n = ((await this.ctx.storage.get<number>("hbCount")) ?? 0) + 1;
    await this.ctx.storage.put({ hbCount: n, hbLast: { at: Date.now(), what } });
    if (!(await this.ctx.storage.get("hbFirst"))) await this.ctx.storage.put("hbFirst", Date.now());
  }
  takeEgress(): EgressEntry[] {
    const out = this.egress;
    this.egress = [];
    return out;
  }

  async begin(opts: {
    instance?: string | { vcpu: number; memoryMib: number; diskMb: number };
    internet?: boolean;
    inactivityMs?: number;
    https?: boolean;
    image?: string;
    snapshot?: { id: string };
    entrypoint?: string[];
    env?: Record<string, string>;
  }): Promise<{ started_ms: number; ready_ms: number; exec_ms: number }> {
    const c = this.ctx.container;
    if (!c) throw new Error("no container configured");
    if (c.running) throw new Error("already running");
    const door = this.ctx.exports.Door({ props: { box: this.ctx.id.name ?? "?" } });
    // Order matters (docs, "Handler precedence"): a hostname intercept registered AFTER a `*` rule on the same protocol receives
    // nothing. The "model door" is a hostname that exists only in the Worker; it is registered first, for HTTP and HTTPS.
    const model = this.ctx.exports.ModelDoor({ props: { box: this.ctx.id.name ?? "?" } });
    await c.interceptOutboundHttp("model.door", model);
    if (opts.https !== false) {
      // HTTPS intercepts must exist before start(): the CA file /etc/cloudflare/certs/cloudflare-containers-ca.crt is made then.
      await c.interceptOutboundHttps("model.door", model);
      await c.interceptOutboundHttps("*", door);
    }
    await c.interceptAllOutboundHttp(door);
    const t0 = Date.now();
    const startOpts: Record<string, unknown> = {
      enableInternet: opts.internet ?? false,
      instance: opts.instance ?? "standard-2",
      entrypoint: opts.entrypoint ?? ["sleep", "infinity"],
      env: opts.env,
    };
    if (opts.snapshot) startOpts.containerSnapshot = opts.snapshot;
    else startOpts.image = opts.image ?? c.images.base;
    // `start` options are typed by workers-types of the day; the documented shape is used as is.
    (c as unknown as { start(o: Record<string, unknown>): void }).start(startOpts);
    const started = Date.now() - t0;
    const p = await c.exec(["true"]);
    await p.output();
    const exec_ms = Date.now() - t0;
    await c.setInactivityTimeout(opts.inactivityMs ?? 5 * 60_000);
    await this.ctx.storage.put("lastBegin", { at: Date.now(), inactivityMs: opts.inactivityMs ?? 5 * 60_000 });
    return { started_ms: started, ready_ms: exec_ms, exec_ms };
  }

  async run(script: string, opts: { user?: string; timeoutMs?: number; cwd?: string } = {}): Promise<{ exit: number; out: string; err: string; ms: number }> {
    const c = this.ctx.container;
    if (!c?.running) throw new Error("not running");
    const t0 = Date.now();
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), opts.timeoutMs ?? 120_000);
    try {
      const p = await c.exec(["bash", "-c", script], { user: opts.user, cwd: opts.cwd, signal: ac.signal });
      const [o, exit] = await Promise.all([p.output(), p.exitCode]);
      const dec = new TextDecoder();
      return { exit, out: dec.decode(o.stdout).slice(-60_000), err: dec.decode(o.stderr).slice(-20_000), ms: Date.now() - t0 };
    } catch (e) {
      return { exit: -1, out: "", err: `exec failed: ${String(e)}`, ms: Date.now() - t0 };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Two-Containers relay, side one: run a command and hand its stdout to the caller as a stream (the Worker is the only path between boxes). */
  async streamOut(script: string): Promise<ReadableStream<Uint8Array>> {
    const c = this.ctx.container;
    if (!c?.running) throw new Error("not running");
    const p = await c.exec(["bash", "-c", script], { stderr: "ignore" });
    return p.stdout as ReadableStream<Uint8Array>;
  }
  /** Side two: run a command whose stdin is the stream from the other box. */
  async streamIn(script: string, input: ReadableStream<Uint8Array>): Promise<{ exit: number; out: string; err: string; ms: number }> {
    const c = this.ctx.container;
    if (!c?.running) throw new Error("not running");
    const t0 = Date.now();
    const p = await c.exec(["bash", "-c", script], { stdin: input });
    const [o, exit] = await Promise.all([p.output(), p.exitCode]);
    const dec = new TextDecoder();
    return { exit, out: dec.decode(o.stdout).slice(-8000), err: dec.decode(o.stderr).slice(-4000), ms: Date.now() - t0 };
  }

  async setTimeoutMs(ms: number): Promise<void> {
    await this.ctx.container?.setInactivityTimeout(ms);
  }
  async snapshot(name: string): Promise<{ id: string; size: number; ms: number }> {
    const t0 = Date.now();
    const s = await (this.ctx.container as unknown as { snapshotContainer(o: { name: string }): Promise<{ id: string; size: number }> }).snapshotContainer({ name });
    await this.ctx.storage.put("snapshot", s);
    return { id: s.id, size: s.size, ms: Date.now() - t0 };
  }
  async lastSnapshot(): Promise<{ id: string; size: number } | undefined> {
    return this.ctx.storage.get("snapshot");
  }

  /** Keepalive for a long job: code inside the container is not activity; an alarm that runs more often than the timeout is. */
  async keepAlive(on: boolean, everyMs = 60_000): Promise<void> {
    await this.ctx.storage.put("keep", on ? everyMs : 0);
    if (on) await this.ctx.storage.setAlarm(Date.now() + everyMs);
  }
  async alarm(): Promise<void> {
    const every = (await this.ctx.storage.get<number>("keep")) ?? 0;
    if (!every) return;
    const c = this.ctx.container;
    const n = ((await this.ctx.storage.get<number>("alarms")) ?? 0) + 1;
    await this.ctx.storage.put("alarms", n);
    await this.ctx.storage.put("lastAlarm", { at: Date.now(), running: c?.running ?? false });
    if (c?.running) await this.ctx.storage.setAlarm(Date.now() + every);
  }
  async status(): Promise<unknown> {
    const c = this.ctx.container;
    return {
      running: c?.running ?? false,
      inspect: c ? await c.inspect().catch((e: unknown) => String(e)) : null,
      alarms: await this.ctx.storage.get("alarms"),
      lastAlarm: await this.ctx.storage.get("lastAlarm"),
      lastBegin: await this.ctx.storage.get("lastBegin"),
      hb: { count: await this.ctx.storage.get("hbCount"), first: await this.ctx.storage.get("hbFirst"), last: await this.ctx.storage.get("hbLast") },
      now: Date.now(),
    };
  }
  async resetCounters(): Promise<void> {
    await this.ctx.storage.delete(["hbCount", "hbLast", "hbFirst", "alarms", "lastAlarm"]);
  }
  async kill(): Promise<void> {
    await this.ctx.storage.put("keep", 0);
    if (this.ctx.container?.running) await this.ctx.container.destroy("spike done");
  }
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (!env.SPIKE_SECRET || !timingSafeEqual(request.headers.get("x-spike-secret") ?? "", env.SPIKE_SECRET)) {
      return new Response("not found", { status: 404 });
    }
    const url = new URL(request.url);
    const [, name, action] = url.pathname.split("/");
    if (!name || !BOXES.has(name)) return new Response("box must be a or b", { status: 400 });
    const box = env.BOX.getByName(name);
    const json = (v: unknown) => Response.json(v ?? null);
    try {
      switch (action) {
        case "begin":
          return json(await box.begin((await request.json().catch(() => ({}))) as Parameters<CrSpikeBox["begin"]>[0]));
        case "run":
          return json(await box.run(await request.text(), { user: url.searchParams.get("user") ?? undefined, timeoutMs: Number(url.searchParams.get("timeout") ?? 120_000) }));
        case "pipe": {
          // POST /<from>/pipe?to=<box>  body {"from":"<cmd in box <from>>","to":"<cmd in box to, stdin = stdout of the first>"}
          const to = url.searchParams.get("to") ?? "";
          if (!BOXES.has(to) || to === name) return new Response("to must be the other box", { status: 400 });
          const spec = (await request.json()) as { from: string; to: string };
          const t0 = Date.now();
          const stream = await box.streamOut(spec.from);
          const res = await env.BOX.getByName(to).streamIn(spec.to, stream);
          return json({ ...res, relay_ms: Date.now() - t0 });
        }
        case "policy":
          await box.setPolicy((await request.json()) as Policy);
          return json({ ok: true });
        case "egress":
          return json(await box.takeEgress());
        case "timeout":
          await box.setTimeoutMs(Number(url.searchParams.get("ms")));
          return json({ ok: true });
        case "snapshot":
          return json(await box.snapshot(url.searchParams.get("name") ?? "spike"));
        case "keepalive":
          await box.keepAlive(url.searchParams.get("on") !== "0", Number(url.searchParams.get("every") ?? 60_000));
          return json({ ok: true });
        case "reset":
          await box.resetCounters();
          return json({ ok: true });
        case "status":
          return json(await box.status());
        case "kill":
          await box.kill();
          return json({ ok: true });
        default:
          return new Response("unknown action", { status: 400 });
      }
    } catch (e) {
      return Response.json({ error: String(e) }, { status: 500 });
    }
  },
};
