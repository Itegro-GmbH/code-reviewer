// SPDX-License-Identifier: LicenseRef-Proprietary

// The per-VM token of the local Dispatcher (Runner v2, #977 fix round, epic #969, ADR 0005): what lets the host tell a genuine
// message from the VM from a forged one. The host makes one for each VM (`generateControlToken`), sends it in the start
// (`controlToken` of contracts/vm-init.v1.json), and refuses every message that does not carry it: the exit report of vm-init
// (`token` of `ExitReport`) once it has an `ack` for the start, and every `narrow` and `end` of the environment control
// (`token` of contracts/environment-control.v1.json). Denying the agent's container an AF_VSOCK socket (seccomp, the kernel's
// configuration, #976) is defence in depth; this token is what the host trusts.
//
// The helpers are pure (no socket, no state): #978's host calls them on every message it reads, and the tests here pin the
// rules it will refuse by.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** 256 bits: 43 characters of base64url, the shortest `ControlToken` of the contracts. */
export const CONTROL_TOKEN_BYTES = 32;

const CONTROL_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43,128}$/;

/** A fresh token for one VM. */
export function generateControlToken(): string {
  return randomBytes(CONTROL_TOKEN_BYTES).toString("base64url");
}

/** Whether `value` is a token of the contracts' shape (`ControlToken`); the host makes only such ones. */
export function isControlToken(value: unknown): value is string {
  return typeof value === "string" && CONTROL_TOKEN_PATTERN.test(value);
}

const digest = (value: string): Buffer =>
  createHash("sha256").update(value, "utf8").digest();

/**
 * Whether `received` is `expected`. Both go through SHA-256 first, so the two buffers have the same length whatever the
 * texts' lengths are, and `timingSafeEqual` compares them in constant time.
 */
export function controlTokenMatches(
  received: unknown,
  expected: string,
): boolean {
  if (typeof received !== "string") return false;
  return timingSafeEqual(digest(received), digest(expected));
}

/** What the host does with a message: `ok`, or why it refuses it (a code, never the token). */
export type ControlTokenVerdict = "ok" | "missing" | "wrong";

/** A message that may carry a token: the `narrow`, `end` and exit report documents, read as JSON. */
export interface MaybeTokenMessage {
  readonly token?: unknown;
  readonly [field: string]: unknown;
}

/**
 * The host's check of one message of the environment control (`narrow`, `end`): the token of this VM, or a refusal. A message
 * without a token is `missing`, one with another is `wrong`; the host answers both the same (`refused`, `invalid_request`, or
 * closes the connection) and never says which.
 */
export function verifyControlMessage(
  message: MaybeTokenMessage,
  expected: string,
): ControlTokenVerdict {
  if (message.token === undefined) return "missing";
  return controlTokenMatches(message.token, expected) ? "ok" : "wrong";
}

export interface ExitReportCheck {
  /** The token this VM's start carried. */
  expected: string;
  /** Whether the host has an `ack` for the start of this VM. Before it, no job and no agent exists. */
  startAcked: boolean;
}

/**
 * The host's check of an exit report of vm-init. A VM that never took a start cannot know the token (`start_timeout`,
 * `start_invalid`, a daemon that did not start), so a report without one counts only while the host has no `ack` for the start;
 * once it has, the token is required (`ExitReport`, "THE HOST TAKES THE FIRST REPORT").
 */
export function verifyExitReport(
  report: MaybeTokenMessage,
  check: ExitReportCheck,
): ControlTokenVerdict {
  if (report.token === undefined && !check.startAcked) return "ok";
  return verifyControlMessage(report, check.expected);
}
