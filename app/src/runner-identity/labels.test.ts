// SPDX-License-Identifier: LicenseRef-Proprietary

// The labels of the platform (#971): the reserved namespace `cr:`, the label of a hosted size and what the claim reads from them. The
// sizes are held to contracts/environment-sizes.v1.json.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  hasAllLabels,
  hostedLabels,
  HOSTED_VCPUS,
  isReservedLabel,
  MANAGED_LABEL,
  PLATFORM_LABELS,
  requiredLabelsOfTurn,
  RESERVED_LABEL_PREFIX,
  RUNNER_LABEL_PREFIX,
  runnerIdOfLabel,
  runnerIdOfRequiredLabels,
  runnerLabel,
  reservedLabelIssues,
  sizeLabel,
  sizeLabelOf,
  vcpusOfSizeLabel,
} from "./labels.ts";
import { LABEL_PATTERN } from "./announcement.ts";

const sizes = JSON.parse(
  readFileSync(
    join(
      import.meta.dirname,
      "..",
      "..",
      "..",
      "contracts",
      "environment-sizes.v1.json",
    ),
    "utf8",
  ),
) as { vcpus: number[] };

describe("the labels of the platform", () => {
  // #971-T02
  it("name a hosted job by `cr:managed` and its size, and the sizes are those of contracts/environment-sizes.v1.json", () => {
    expect([...HOSTED_VCPUS]).toEqual(sizes.vcpus);
    expect(MANAGED_LABEL).toBe("cr:managed");
    expect(sizeLabel(2)).toBe("cr:size-2");
    expect(hostedLabels(4)).toEqual(["cr:managed", "cr:size-4"]);
    expect([...PLATFORM_LABELS].sort()).toEqual(
      [
        "cr:managed",
        ...sizes.vcpus.map((vcpus) => `cr:size-${String(vcpus)}`),
      ].sort(),
    );
    // Every platform label is a label a runner could announce by its form: the namespace, not the pattern, keeps it out.
    for (const label of PLATFORM_LABELS)
      expect(LABEL_PATTERN.test(label)).toBe(true);
  });

  it("read the size back from a label, and only a size of the platform", () => {
    expect(vcpusOfSizeLabel("cr:size-8")).toBe(8);
    expect(vcpusOfSizeLabel("cr:size-1")).toBe(1);
    expect(vcpusOfSizeLabel("cr:size-3")).toBeUndefined();
    expect(vcpusOfSizeLabel("cr:size-08")).toBeUndefined();
    expect(vcpusOfSizeLabel("cr:managed")).toBeUndefined();
    expect(vcpusOfSizeLabel("size-2")).toBeUndefined();
    expect(sizeLabelOf(["cr:managed", "cr:size-6"])).toBe("cr:size-6");
    expect(sizeLabelOf(["gpu", "linux"])).toBeUndefined();
    expect(sizeLabelOf(null)).toBeUndefined();
  });

  // #971-T01
  it("reserve the namespace `cr:` whatever the case or the spacing, and nothing else", () => {
    expect(RESERVED_LABEL_PREFIX).toBe("cr:");
    for (const label of [
      "cr:managed",
      "CR:Managed",
      " cr:size-2 ",
      "cr:",
      "cr:anything",
    ])
      expect(isReservedLabel(label)).toBe(true);
    for (const label of [
      "linux",
      "gpu",
      "cr",
      "cr-managed",
      "acr:x",
      "my:cr:x",
      "managed",
    ])
      expect(isReservedLabel(label)).toBe(false);
  });

  // #971-T01
  it("point at each reserved label of an announcement, by position", () => {
    expect(reservedLabelIssues(["linux", "gpu"])).toEqual([]);
    expect(reservedLabelIssues(["linux", "cr:managed", "CR:size-2"])).toEqual([
      { field: "labels[1]", code: "reserved" },
      { field: "labels[2]", code: "reserved" },
    ]);
  });

  it("match a job only when the dispatcher has every label it requires", () => {
    expect(hasAllLabels(["linux", "gpu"], ["linux"])).toBe(true);
    expect(hasAllLabels(["linux"], ["linux", "gpu"])).toBe(false);
    expect(hasAllLabels([], [])).toBe(true);
    expect(hasAllLabels([], ["linux"])).toBe(false);
  });
});

describe("the labels a turn requires", () => {
  // #971-T07
  it("are the labels of a runner environment without any `cr:` label, which an environment stored before the namespace was reserved may hold", () => {
    expect(
      requiredLabelsOfTurn({
        runnerEnvironment: {
          id: "env-1",
          labels: ["cr:managed", "gpu", "CR:size-8", "linux", " cr:size-2"],
        },
      }),
    ).toEqual(["gpu", "linux"]);
  });

  // #1114-review-4
  it("keep `cr:runner:<id>` only for the copy of that very runner, so a stored copy with the shape of one cannot route to another runner", () => {
    expect(
      requiredLabelsOfTurn({
        runnerEnvironment: { id: "r-1", labels: ["cr:runner:r-1"] },
      }),
    ).toEqual(["cr:runner:r-1"]);
    expect(
      requiredLabelsOfTurn({
        runnerEnvironment: { id: "env-9", labels: ["cr:runner:r-1"] },
      }),
    ).toEqual([]);
  });

  it("are `cr:managed` and the size of a hosted environment, or the size of the kind without one", () => {
    expect(requiredLabelsOfTurn({ environment: { vcpus: 4 } })).toEqual([
      "cr:managed",
      "cr:size-4",
    ]);
    expect(requiredLabelsOfTurn({})).toEqual(["cr:managed", "cr:size-2"]);
  });
});

describe("the label of a concrete runner (#1105, ADR 0007, decision 10)", () => {
  // #1105-R50
  it("is `cr:runner:<id>`, reads its id back exactly, and no other label names a runner", () => {
    expect(runnerLabel("abc-123")).toBe("cr:runner:abc-123");
    expect(RUNNER_LABEL_PREFIX).toBe("cr:runner:");
    expect(runnerIdOfLabel("cr:runner:abc-123")).toBe("abc-123");
    for (const label of [
      "cr:runner:",
      "cr:runner: x",
      "CR:RUNNER:abc",
      "cr:managed",
      "cr:size-4",
      "runner:abc",
      "linux",
    ])
      expect(runnerIdOfLabel(label)).toBeUndefined();
    // It is still in the reserved namespace: a runner that announces it is refused like any `cr:` label.
    expect(isReservedLabel(runnerLabel("abc"))).toBe(true);
    expect(reservedLabelIssues([runnerLabel("abc")])).toEqual([
      { field: "labels[0]", code: "reserved" },
    ]);
  });

  // #1105-R51
  it("finds the runner among the labels a job requires", () => {
    expect(runnerIdOfRequiredLabels(["cr:runner:abc", "linux"])).toBe("abc");
    expect(
      runnerIdOfRequiredLabels(["cr:managed", "cr:size-2"]),
    ).toBeUndefined();
    expect(runnerIdOfRequiredLabels(null)).toBeUndefined();
  });

  // #1105-R52
  it("is what a turn of a self-hosted runner requires, alone; any other reserved label of a runner environment is still dropped", () => {
    expect(
      requiredLabelsOfTurn({
        runnerEnvironment: { id: "abc", labels: [runnerLabel("abc")] },
      }),
    ).toEqual(["cr:runner:abc"]);
    // Not exactly that one label: an environment stored before the namespace was reserved keeps losing its `cr:` labels.
    expect(
      requiredLabelsOfTurn({
        runnerEnvironment: { id: "abc", labels: [runnerLabel("abc"), "linux"] },
      }),
    ).toEqual(["linux"]);
    expect(
      requiredLabelsOfTurn({
        runnerEnvironment: { id: "abc", labels: ["cr:managed", "linux"] },
      }),
    ).toEqual(["linux"]);
    // A hosted runner's turn is a hosted job of its size.
    expect(requiredLabelsOfTurn({ environment: { vcpus: 6 } })).toEqual([
      "cr:managed",
      "cr:size-6",
    ]);
  });
});
