// SPDX-License-Identifier: LicenseRef-Proprietary

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  AF_VSOCK,
  SeccompProfileError,
  allowSocketFamilies,
  denySocketFamilies,
} from "./seccomp.ts";

// A cut-down default profile: the shape of Docker's, with `socket` in the big allow list.
function defaultProfile() {
  return {
    defaultAction: "SCMP_ACT_ERRNO",
    defaultErrnoRet: 1,
    architectures: ["SCMP_ARCH_X86_64"],
    syscalls: [
      {
        names: ["read", "write", "socket", "socketpair"],
        action: "SCMP_ACT_ALLOW",
      },
      {
        names: ["personality"],
        action: "SCMP_ACT_ALLOW",
        args: [{ index: 0, value: 0, op: "SCMP_CMP_EQ" }],
      },
    ],
  };
}

describe("a seccomp profile derived from the default one", () => {
  // #325-T06
  it("lets socket through for every family but the denied one", () => {
    const derived = denySocketFamilies(defaultProfile(), [AF_VSOCK]);
    const syscalls = derived.syscalls as Array<{
      names: string[];
      action: string;
      args?: unknown[];
    }>;

    expect(syscalls.find((s) => s.names.includes("socketpair"))?.names).toEqual(
      ["read", "write", "socketpair"],
    );
    expect(syscalls.at(-1)).toEqual({
      names: ["socket"],
      action: "SCMP_ACT_ALLOW",
      args: [{ index: 0, value: 40, op: "SCMP_CMP_NE" }],
    });
    // Nothing else about the default profile changes.
    expect(derived.defaultAction).toBe("SCMP_ACT_ERRNO");
    expect(derived.architectures).toEqual(["SCMP_ARCH_X86_64"]);
  });

  // #325-T06
  it("denies several families with one rule", () => {
    const derived = denySocketFamilies(defaultProfile(), [AF_VSOCK, 16]);
    const rule = (derived.syscalls as Array<{ args?: unknown[] }>).at(-1);

    expect(rule?.args).toEqual([
      { index: 0, value: 40, op: "SCMP_CMP_NE" },
      { index: 0, value: 16, op: "SCMP_CMP_NE" },
    ]);
  });

  // #325-T06
  it("does not change the profile it is given", () => {
    const before = defaultProfile();
    denySocketFamilies(before, [AF_VSOCK]);

    expect(before).toEqual(defaultProfile());
  });

  // #325-T06
  it("fails closed on a profile it does not understand", () => {
    for (const bad of [
      null,
      {},
      { syscalls: [] },
      { syscalls: [{ names: ["read"], action: "SCMP_ACT_ALLOW" }] },
    ])
      expect(() => denySocketFamilies(bad, [AF_VSOCK])).toThrow(
        SeccompProfileError,
      );
    expect(() => denySocketFamilies(defaultProfile(), [])).toThrow(
      SeccompProfileError,
    );
    expect(() => denySocketFamilies(defaultProfile(), [-1])).toThrow(
      SeccompProfileError,
    );
  });

  // #325-T06
  it.each(["SCMP_ACT_ALLOW", "SCMP_ACT_LOG", "SCMP_ACT_TRACE", undefined])(
    "refuses a profile whose default action is %s: it would let the denied family through",
    (defaultAction) => {
      const profile: Record<string, unknown> = defaultProfile();
      if (defaultAction === undefined) delete profile.defaultAction;
      else profile.defaultAction = defaultAction;

      expect(() => denySocketFamilies(profile, [AF_VSOCK])).toThrow(
        SeccompProfileError,
      );
    },
  );

  // #325-T06
  it.each([
    "SCMP_ACT_ERRNO",
    "SCMP_ACT_KILL",
    "SCMP_ACT_KILL_PROCESS",
    "SCMP_ACT_TRAP",
  ])("accepts a profile whose default action is %s", (defaultAction) => {
    expect(() =>
      denySocketFamilies({ ...defaultProfile(), defaultAction }, [AF_VSOCK]),
    ).not.toThrow();
  });
});

// Docker's own default profile as of 29.1.3 (moby, `vendor/github.com/moby/profiles/seccomp/default.json`): `socket` is allowed
// for every family but AF_VSOCK, with a condition on the first argument.
function dockerDefault(): {
  syscalls: Array<{ names: string[]; args?: unknown[] }>;
} {
  return JSON.parse(
    readFileSync(
      new URL("./testdata/docker-default-seccomp-29.1.3.json", import.meta.url),
      "utf8",
    ),
  ) as ReturnType<typeof dockerDefault>;
}

describe("a seccomp profile that allows a family the default one denies", () => {
  // #977-T01
  it("takes the family condition out of the rule that allows socket, and changes nothing else", () => {
    const base = dockerDefault();
    const derived = allowSocketFamilies(base, [
      AF_VSOCK,
    ]) as unknown as ReturnType<typeof dockerDefault>;

    const rule = (profile: ReturnType<typeof dockerDefault>) =>
      profile.syscalls.find((r) => r.names.includes("socket"));
    expect(rule(base)?.args).toEqual([
      { index: 0, value: 40, op: "SCMP_CMP_NE" },
    ]);
    expect(rule(derived)?.args).toBeUndefined();
    const allowed = { ...rule(base) };
    delete allowed.args;
    expect(rule(derived)).toEqual(allowed);
    expect({
      ...derived,
      syscalls: derived.syscalls.filter((r) => !r.names.includes("socket")),
    }).toEqual({
      ...base,
      syscalls: base.syscalls.filter((r) => !r.names.includes("socket")),
    });
  });

  // #977-T01
  it("is the file the root file system gets (runner/vm-init/control-seccomp.json)", () => {
    const committed = JSON.parse(
      readFileSync(
        new URL(
          "../../../runner/vm-init/control-seccomp.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ) as unknown;

    expect(committed).toEqual(allowSocketFamilies(dockerDefault(), [AF_VSOCK]));
  });

  // #977-T01
  it("does not change the profile it is given", () => {
    const before = dockerDefault();
    allowSocketFamilies(before, [AF_VSOCK]);

    expect(before).toEqual(dockerDefault());
  });

  // #977-T01
  it("fails closed on a profile it does not understand", () => {
    const allowsAlready = {
      defaultAction: "SCMP_ACT_ERRNO",
      syscalls: [{ names: ["socket"], action: "SCMP_ACT_ALLOW" }],
    };
    for (const bad of [
      null,
      {},
      { syscalls: [] },
      { defaultAction: "SCMP_ACT_ALLOW", syscalls: dockerDefault().syscalls },
      // The family was never denied: this is not the profile the function was written for.
      allowsAlready,
      {
        defaultAction: "SCMP_ACT_ERRNO",
        syscalls: [{ names: ["socket"], action: "SCMP_ACT_ERRNO" }],
      },
    ])
      expect(() => allowSocketFamilies(bad, [AF_VSOCK])).toThrow(
        SeccompProfileError,
      );
    expect(() => allowSocketFamilies(dockerDefault(), [])).toThrow(
      SeccompProfileError,
    );
    // Another family that the default profile does not deny.
    expect(() => allowSocketFamilies(dockerDefault(), [AF_VSOCK, 16])).toThrow(
      SeccompProfileError,
    );
  });

  // #977-T01
  it("keeps the other conditions of the rule", () => {
    const profile = {
      defaultAction: "SCMP_ACT_ERRNO",
      syscalls: [
        {
          names: ["socket"],
          action: "SCMP_ACT_ALLOW",
          args: [
            { index: 0, value: 40, op: "SCMP_CMP_NE" },
            { index: 1, value: 1, op: "SCMP_CMP_EQ" },
          ],
        },
      ],
    };

    const derived = allowSocketFamilies(profile, [AF_VSOCK]);

    expect(derived.syscalls[0]?.args).toEqual([
      { index: 1, value: 1, op: "SCMP_CMP_EQ" },
    ]);
  });
});
