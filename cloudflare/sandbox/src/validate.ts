// SPDX-License-Identifier: LicenseRef-Proprietary

// The request bodies of contracts/cf-sandbox.v1.json, checked by hand (no schema library in a Worker). Fields the contract does not
// name are ignored (a reader ignores fields it does not know); a field it does name must have its shape or the request is refused.
import { parsePolicy, type NetworkPolicy } from "./policy.ts";

export const VM_NAME = /^[a-z0-9-]{1,63}$/;
export const LABEL = /^[a-z][a-z0-9_-]{0,63}$/;
export const INSTANCE_TYPE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const TAG_KEY = /^[A-Za-z0-9_.-]{1,64}$/;
const PROCESS_ID = /^[a-z0-9-]{1,64}$/;

export const MIN_VM_TIMEOUT_MS = 60_000;
export const MAX_VM_TIMEOUT_MS = 21_600_000;
export const DEFAULT_EXEC_TIMEOUT_MS = 120_000;
export const MIN_EXEC_TIMEOUT_MS = 1_000;
export const MAX_EXEC_TIMEOUT_MS = 600_000;
export const MAX_WAIT_MS = 25_000;
export const MAX_STDIN_CHARS = 1_048_576;
export const MAX_BODY_BYTES = 2_097_152;

export type Checked<T> = { ok: true; value: T } | { ok: false };
const no = { ok: false } as const;
const yes = <T>(value: T): Checked<T> => ({ ok: true, value });

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function validName(value: unknown): value is string {
  return typeof value === "string" && VM_NAME.test(value);
}
export function validProcessId(value: unknown): value is string {
  return typeof value === "string" && PROCESS_ID.test(value);
}

export type Tags = Record<string, string>;

function tagsOf(value: unknown): Tags | null {
  const found = record(value);
  if (found === null) return null;
  const entries = Object.entries(found);
  if (entries.length > 16) return null;
  const tags: Tags = {};
  for (const [key, each] of entries) {
    if (!TAG_KEY.test(key) || typeof each !== "string" || each.length > 256)
      return null;
    tags[key] = each;
  }
  return tags;
}

export type CreateRequest = {
  name: string;
  instanceType: string;
  timeoutMs: number;
  tags: Tags;
};

export function checkCreate(
  body: unknown,
  instanceTypes: readonly string[],
): Checked<CreateRequest> {
  const b = record(body);
  if (b === null || !validName(b.name)) return no;
  if (
    typeof b.instanceType !== "string" ||
    !INSTANCE_TYPE.test(b.instanceType) ||
    !instanceTypes.includes(b.instanceType)
  )
    return no;
  const timeoutMs = b.timeoutMs;
  if (
    typeof timeoutMs !== "number" ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < MIN_VM_TIMEOUT_MS ||
    timeoutMs > MAX_VM_TIMEOUT_MS
  )
    return no;
  const tags = tagsOf(b.tags);
  if (tags === null) return no;
  return yes({ name: b.name, instanceType: b.instanceType, timeoutMs, tags });
}

export type CommandRequest = { label: string; cmd: string; args: string[] };

function commandOf(b: Record<string, unknown>): CommandRequest | null {
  if (typeof b.label !== "string" || !LABEL.test(b.label)) return null;
  if (typeof b.cmd !== "string" || b.cmd.length < 1 || b.cmd.length > 4096)
    return null;
  if (!Array.isArray(b.args) || b.args.length > 256) return null;
  for (const arg of b.args)
    if (typeof arg !== "string" || arg.length > 65_536) return null;
  if (b.sudo !== undefined && typeof b.sudo !== "boolean") return null;
  return { label: b.label, cmd: b.cmd, args: b.args as string[] };
}

export type ExecRequest = CommandRequest & { timeoutMs: number };

export function checkExec(body: unknown): Checked<ExecRequest> {
  const b = record(body);
  const command = b === null ? null : commandOf(b);
  if (b === null || command === null) return no;
  let timeoutMs = DEFAULT_EXEC_TIMEOUT_MS;
  if (b.timeoutMs !== undefined) {
    if (
      typeof b.timeoutMs !== "number" ||
      !Number.isInteger(b.timeoutMs) ||
      b.timeoutMs < MIN_EXEC_TIMEOUT_MS ||
      b.timeoutMs > MAX_EXEC_TIMEOUT_MS
    )
      return no;
    timeoutMs = b.timeoutMs;
  }
  return yes({ ...command, timeoutMs });
}

export function checkStartProcess(body: unknown): Checked<CommandRequest> {
  const b = record(body);
  const command = b === null ? null : commandOf(b);
  return command === null ? no : yes(command);
}

export function checkStdin(body: unknown): Checked<string> {
  const b = record(body);
  if (
    b === null ||
    typeof b.data !== "string" ||
    b.data.length > MAX_STDIN_CHARS
  )
    return no;
  return yes(b.data);
}

export function checkNetwork(body: unknown): Checked<NetworkPolicy> {
  const b = record(body);
  const policy = b === null ? null : parsePolicy(b.policy);
  return policy === null ? no : yes(policy);
}

/** `waitMs` of the process status call: absent is 0, otherwise an integer from 0 to 25000. */
export function checkWaitMs(raw: string | null): Checked<number> {
  if (raw === null || raw === "") return yes(0);
  if (!/^\d{1,6}$/.test(raw)) return no;
  const n = Number(raw);
  return n > MAX_WAIT_MS ? no : yes(n);
}

export type ListFilter = {
  namePrefix: string;
  tag: { key: string; value: string } | null;
};

/** `namePrefix` (a prefix of a name) and `tag=k:v` of the listing. Both are optional. */
export function checkListFilter(params: URLSearchParams): Checked<ListFilter> {
  const namePrefix = params.get("namePrefix") ?? "";
  if (namePrefix !== "" && !/^[a-z0-9-]{1,63}$/.test(namePrefix)) return no;
  const rawTag = params.get("tag");
  if (rawTag === null || rawTag === "") return yes({ namePrefix, tag: null });
  const at = rawTag.indexOf(":");
  const key = at < 0 ? rawTag : rawTag.slice(0, at);
  const value = at < 0 ? "" : rawTag.slice(at + 1);
  if (!TAG_KEY.test(key) || value.length > 256) return no;
  return yes({ namePrefix, tag: { key, value } });
}
