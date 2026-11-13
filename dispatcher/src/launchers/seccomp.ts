// SPDX-License-Identifier: LicenseRef-Proprietary

// An optional rule for the Worker container (#325): deny the `socket` call for chosen address
// families through a seccomp profile derived from Docker's default one. It is off unless a launcher
// is given the derived profile (`RenderOptions.seccompProfile`); the spike (#317) found AF_VSOCK
// already denied by a platform filter and by Docker's default profile, so this is defence in depth
// that a deployment can switch on, not a requirement.
//
// The rule does not add a deny entry beside the default allow of `socket`: two rules for one call
// would leave the outcome to the order the daemon applies them in. It takes `socket` out of the
// default allow list and allows it again only for every family but the denied ones, which is one
// rule with a single meaning. Not yet exercised against a real daemon (follow-up in the PR).

/** AF_VSOCK, the socket family of the host channel of a VM. */
export const AF_VSOCK = 40;

export class SeccompProfileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SeccompProfileError";
  }
}

interface SyscallRule {
  names: string[];
  action: string;
  args?: unknown[];
  [key: string]: unknown;
}

interface Profile {
  syscalls: SyscallRule[];
  [key: string]: unknown;
}

// The default actions that refuse a call no rule names. The derivation relies on that fall-through: with
// an allowing default the family stays open, so such a profile is refused instead of passed through.
const DENYING_DEFAULT_ACTIONS: ReadonlySet<string> = new Set([
  "SCMP_ACT_ERRNO",
  "SCMP_ACT_KILL",
  "SCMP_ACT_KILL_PROCESS",
  "SCMP_ACT_KILL_THREAD",
  "SCMP_ACT_TRAP",
]);

function isSyscallRule(value: unknown): value is SyscallRule {
  if (value === null || typeof value !== "object") return false;
  const { names, action } = value as Record<string, unknown>;
  return (
    Array.isArray(names) &&
    names.every((name) => typeof name === "string") &&
    typeof action === "string"
  );
}

function isProfile(value: unknown): value is Profile {
  if (value === null || typeof value !== "object") return false;
  const { syscalls } = value as Record<string, unknown>;
  return Array.isArray(syscalls) && syscalls.every(isSyscallRule);
}

/**
 * A copy of `defaultProfile` in which `socket` is refused for each of `families` and allowed for
 * all others. Throws `SeccompProfileError` for a profile that does not deny by default or does not
 * allow `socket` without conditions (the shape of Docker's default), so an unknown profile never
 * passes as derived.
 */
export function denySocketFamilies(
  defaultProfile: unknown,
  families: readonly number[],
): Profile {
  if (families.length === 0 || !families.every(Number.isInteger))
    throw new SeccompProfileError("families must be a list of integers");
  if (families.some((family) => family < 0))
    throw new SeccompProfileError("a family cannot be negative");
  if (!isProfile(defaultProfile))
    throw new SeccompProfileError("not a seccomp profile");

  if (!DENYING_DEFAULT_ACTIONS.has(String(defaultProfile.defaultAction)))
    throw new SeccompProfileError("the profile does not deny by default");

  const copy = structuredClone(defaultProfile);
  const derived: SyscallRule[] = [];
  for (const rule of copy.syscalls) {
    if (!rule.names.includes("socket")) continue;
    // Any other rule for `socket` is a shape this function was not written for.
    if (rule.args !== undefined || rule.action !== "SCMP_ACT_ALLOW")
      throw new SeccompProfileError(
        "the profile has a rule for socket it does not know",
      );
    // The rule keeps its other conditions (`includes`, `excludes`, a comment) and gains the family check.
    const conditions = { ...rule };
    delete conditions.args;
    rule.names = rule.names.filter((name) => name !== "socket");
    derived.push({
      ...conditions,
      names: ["socket"],
      args: families.map((family) => ({
        index: 0,
        value: family,
        op: "SCMP_CMP_NE",
      })),
    });
  }
  if (derived.length === 0)
    throw new SeccompProfileError("the profile does not allow socket");

  copy.syscalls = [
    ...copy.syscalls.filter((rule) => rule.names.length > 0),
    ...derived,
  ];
  return copy;
}

/**
 * A copy of `defaultProfile` in which `socket` is allowed for each of `families` too: the family conditions (`SCMP_CMP_NE`
 * on the first argument) that deny them are taken out of the rule that allows `socket`. It is the opposite of
 * `denySocketFamilies` and exists for one container, the Control container of a Firecracker VM on a customer's machine
 * (`local-control.ts`, #977): its Worker connects to the host over AF_VSOCK (`contracts/environment-control.v1.json`), which
 * Docker's default profile since 2022 refuses with exactly such a condition (`socket` allowed for `arg0 != 40`). Throws
 * `SeccompProfileError` for a profile that does not deny by default, has no `socket` rule that denies one of the families
 * this way (a profile that allows them already is not the one this was written for), or has a `socket` rule of another
 * shape, so that an unknown profile never passes as derived. Nothing else of the profile changes.
 */
export function allowSocketFamilies(
  defaultProfile: unknown,
  families: readonly number[],
): Profile {
  if (families.length === 0 || !families.every(Number.isInteger))
    throw new SeccompProfileError("families must be a list of integers");
  if (!isProfile(defaultProfile))
    throw new SeccompProfileError("not a seccomp profile");
  if (!DENYING_DEFAULT_ACTIONS.has(String(defaultProfile.defaultAction)))
    throw new SeccompProfileError("the profile does not deny by default");

  const copy = structuredClone(defaultProfile);
  const lifted = new Set<number>();
  for (const rule of copy.syscalls) {
    if (!rule.names.includes("socket")) continue;
    if (rule.action !== "SCMP_ACT_ALLOW")
      throw new SeccompProfileError(
        "the profile has a rule for socket it does not know",
      );
    const conditions = rule.args ?? [];
    const kept = conditions.filter((condition) => {
      const { index, value, op } = condition as Record<string, unknown>;
      const denied =
        index === 0 &&
        op === "SCMP_CMP_NE" &&
        typeof value === "number" &&
        families.includes(value);
      if (denied) lifted.add(value);
      return !denied;
    });
    if (kept.length > 0) rule.args = kept;
    else delete rule.args;
  }
  for (const family of families)
    if (!lifted.has(family))
      throw new SeccompProfileError(
        "the profile does not deny a family it was asked to allow",
      );
  return copy;
}
