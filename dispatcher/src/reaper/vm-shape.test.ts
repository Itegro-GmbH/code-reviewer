// SPDX-License-Identifier: LicenseRef-Proprietary

// The name a Launcher gives a job VM and the shape the stop route and the reaper recognise are one agreement (#759): a
// kind whose VM is not recognised could never be stopped or reaped, and would not count against its app's cap.
import { describe, expect, it } from "vitest";
import {
  FakeSandboxService,
  type FakeListFilter,
} from "../../../fakes/sandbox/service.ts";
import { KNOWN_KINDS } from "../core/types.ts";
import { jobVmName } from "../launchers/sandbox.ts";
import { findJobVms } from "../stop/job-stopper.ts";
import { shapeOf } from "./vm-shape.ts";

const JOB = "0b9f6f4e-3c1a-4d9e-8f43-2a7d5e1c9b10";

describe("the job VM of every kind", () => {
  // #759 (additional)
  it.each(KNOWN_KINDS)(
    "is recognised by the reaper's shape, with its tenant, when it is named like a %s launch names it",
    (kind) => {
      const name = jobVmName(kind, JOB, "abcd1234");

      expect(
        shapeOf({
          name,
          status: "running",
          createdAtMs: 0,
          tags: {
            app: "code-reviewer",
            kind,
            job: JOB,
            tenant: "factory",
          },
        }),
      ).toStrictEqual({ kind: "job", jobId: JOB, appId: "factory" });
    },
  );

  // #759 (additional)
  it.each(KNOWN_KINDS)(
    "is found by the stop route for its job and its app, and not for another app, as a %s VM",
    async (kind) => {
      const sandbox = new FakeSandboxService();
      const name = jobVmName(kind, JOB, "abcd1234");
      sandbox.seedVm({
        name,
        tags: { app: "code-reviewer", kind, job: JOB, tenant: "factory" },
        createdAtMs: Date.now() - 600_000,
      });

      expect(await findJobVms(sandbox, JOB, "factory")).toStrictEqual([name]);
      expect(await findJobVms(sandbox, JOB, "reviewer")).toStrictEqual([]);
    },
  );
});

// #759: the lookup lists only the kinds an app can have had, so a failing listing of a kind that cannot exist for the app
// cannot discard the VMs that were found.
describe("the kinds the stop route lists", () => {
  function reviewerVm(sandbox: FakeSandboxService, kind: "diff" | "dynamic") {
    const name = jobVmName(kind, JOB, "abcd1234");
    sandbox.seedVm({
      name,
      tags: { app: "code-reviewer", kind, job: JOB },
      createdAtMs: Date.now() - 600_000,
    });
    return name;
  }

  function listing(sandbox: FakeSandboxService, failing?: string) {
    const prefixes: string[] = [];
    return {
      prefixes,
      fleet: {
        list: (filter: FakeListFilter) => {
          prefixes.push(filter.namePrefix);
          if (failing !== undefined && filter.namePrefix.startsWith(failing))
            return Promise.reject(new Error("platform unavailable"));
          return sandbox.list(filter);
        },
      },
    };
  }

  // #759 (additional)
  it("never lists `cr-implementer-` for the app `reviewer`, which cannot have that kind", async () => {
    const sandbox = new FakeSandboxService();
    reviewerVm(sandbox, "dynamic");
    const { fleet, prefixes } = listing(sandbox);

    await findJobVms(fleet, JOB, "reviewer");

    expect(prefixes).toStrictEqual([`cr-diff-${JOB}-`, `cr-dynamic-${JOB}-`]);
  });

  // #759 (additional)
  it("still answers the VMs of `reviewer` when only a listing of the implementer kind fails", async () => {
    const sandbox = new FakeSandboxService();
    const name = reviewerVm(sandbox, "dynamic");
    const { fleet } = listing(sandbox, "cr-implementer-");

    expect(await findJobVms(fleet, JOB, "reviewer")).toStrictEqual([name]);
  });

  // #759 (additional)
  it("lists all three kinds for another app, whose kinds may have been narrowed since a VM started", async () => {
    const sandbox = new FakeSandboxService();
    const { fleet, prefixes } = listing(sandbox);

    await findJobVms(fleet, JOB, "factory");

    expect(prefixes).toStrictEqual([
      `cr-diff-${JOB}-`,
      `cr-dynamic-${JOB}-`,
      `cr-implementer-${JOB}-`,
    ]);
  });

  // #759 (additional)
  it("finds a VM that a Dispatcher before the kind started, named like a Diff VM, for the app `reviewer`", async () => {
    const sandbox = new FakeSandboxService();
    const name = reviewerVm(sandbox, "diff");
    const { fleet } = listing(sandbox);

    expect(await findJobVms(fleet, JOB, "reviewer")).toStrictEqual([name]);
  });
});
