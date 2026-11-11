// SPDX-License-Identifier: LicenseRef-Proprietary

// The repository moved from a personal GitHub account to the organization Itegro-GmbH. The workflows guard every
// production job with `github.repository == '<owner>/<name>'`, so a guard that still names the old owner skips the
// deployment without any error. These tests hold the guards, the schema ids and every
// link to the repository to the one name in workflow-support.ts (`REPOSITORY`).
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { listTrackedFiles } from "./tracked-files.ts";
import { readText, REPOSITORY, repoRoot } from "./workflow-support.ts";

// Spelled in two parts so that this file is not a hit of its own scan.
const FORMER_OWNER = ["Expidet", "Games"].join("");

// Records of what happened at a point in time (research notes and their raw measurements, which name the test repository
// as it was called when they ran) and the manifest that another pull request owns. GitHub redirects the old names.
const HISTORICAL = [/^docs\/spike\//, /^project\.yaml$/];

const WORKFLOW_FILES = [
  ...readdirSync(`${repoRoot}.github/workflows`).map(
    (file) => `.github/workflows/${file}`,
  ),
  ...readdirSync(`${repoRoot}.github/actions`).map(
    (action) => `.github/actions/${action}/action.yml`,
  ),
];

describe("the identity of the repository", () => {
  it("is an owner and a name", () => {
    expect(REPOSITORY).toMatch(/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/);
  });

  it("is the only repository any workflow or action compares github.repository with", () => {
    const compared: Record<string, string[]> = {};
    for (const file of WORKFLOW_FILES) {
      const source = readFileSync(`${repoRoot}${file}`, "utf8");
      for (const match of source.matchAll(
        /github\.repository\s*[!=]=\s*'([^']*)'/g,
      ))
        (compared[file] ??= []).push(match[1] as string);
    }
    // The guarded workflows are the ones that deploy, roll back, snapshot or run the nightly; losing a guard is as bad as
    // keeping the wrong one.
    expect(Object.keys(compared).sort()).toEqual([
      ".github/workflows/deploy-production.yml",
      ".github/workflows/dispatcher-canary.yml",
      ".github/workflows/golden-snapshot.yml",
      ".github/workflows/nightly.yml",
      ".github/workflows/rollback-production.yml",
      ".github/workflows/runner-program-release.yml",
      ".github/workflows/vercel-stage.yml",
      ".github/workflows/vm-artifacts-release.yml",
    ]);
    for (const [file, names] of Object.entries(compared))
      expect(
        names.every((name) => name === REPOSITORY),
        `${file}: ${names.join(", ")}`,
      ).toBe(true);
  });

  it("is the address every schema of contracts/ carries in its $id, and the runner's copy of one", () => {
    const files = [
      ...readdirSync(`${repoRoot}contracts`).map((file) => `contracts/${file}`),
      "contracts/dynamic-review/schema.v1.json",
    ].filter((file) => file.endsWith(".json"));
    const identified = files
      .map((file) => ({
        file,
        id: (JSON.parse(readText(file)) as { $id?: string }).$id,
      }))
      .filter(({ id }) => id !== undefined); // a data file (the model lists) has none
    expect(identified.length).toBeGreaterThanOrEqual(8);
    for (const { file, id } of identified)
      expect(id, file).toBe(`https://github.com/${REPOSITORY}/${file}`);

    const copy = JSON.parse(
      readText(
        "runner/src/code_reviewer_runner/dynamic_review/findings-schema.v1.json",
      ),
    ) as { $id?: string };
    expect(copy.$id).toBe(
      `https://github.com/${REPOSITORY}/contracts/dynamic-review/schema.v1.json`,
    );
  });

  it("is named by no file under the owner it had before the transfer", () => {
    const stale = listTrackedFiles(repoRoot)
      .filter((path) => !HISTORICAL.some((pattern) => pattern.test(path)))
      .filter((path) =>
        readFileSync(`${repoRoot}${path}`, "utf8")
          .toLowerCase()
          .includes(FORMER_OWNER.toLowerCase()),
      );
    expect(stale).toEqual([]);
  });
});
