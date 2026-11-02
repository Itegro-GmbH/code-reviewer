// SPDX-License-Identifier: LicenseRef-Proprietary

import { describe, expect, it } from "vitest";
import {
  IMAGE_INPUT_PATHS,
  parseDotenv,
  pairFrom,
  pairToEnv,
  pairToMeta,
  pairsEqual,
} from "./pair.ts";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const DIGEST = `sha256:${"a".repeat(64)}`;
const GOOD = {
  snapshotId: "snap_example01",
  imageDigest: DIGEST,
  commit: COMMIT,
};

describe("the snapshot pair", () => {
  // #403-T13
  it("takes the three values from the variables of the Dispatcher project", () => {
    expect(
      pairFrom({
        SANDBOX_SNAPSHOT_ID: "snap_example01",
        SANDBOX_IMAGE_DIGEST: DIGEST,
        SANDBOX_SNAPSHOT_COMMIT: COMMIT,
      }),
    ).toEqual(GOOD);
  });

  // #403-T13
  it.each([
    [
      "no id",
      { SANDBOX_IMAGE_DIGEST: DIGEST, SANDBOX_SNAPSHOT_COMMIT: COMMIT },
    ],
    [
      "no digest",
      {
        SANDBOX_SNAPSHOT_ID: "snap_example01",
        SANDBOX_SNAPSHOT_COMMIT: COMMIT,
      },
    ],
    [
      "no commit",
      { SANDBOX_SNAPSHOT_ID: "snap_example01", SANDBOX_IMAGE_DIGEST: DIGEST },
    ],
    [
      "an empty value",
      {
        SANDBOX_SNAPSHOT_ID: "",
        SANDBOX_IMAGE_DIGEST: DIGEST,
        SANDBOX_SNAPSHOT_COMMIT: COMMIT,
      },
    ],
    [
      "a digest that is not an image id",
      {
        SANDBOX_SNAPSHOT_ID: "snap_example01",
        SANDBOX_IMAGE_DIGEST: "latest",
        SANDBOX_SNAPSHOT_COMMIT: COMMIT,
      },
    ],
    [
      "a short commit",
      {
        SANDBOX_SNAPSHOT_ID: "snap_example01",
        SANDBOX_IMAGE_DIGEST: DIGEST,
        SANDBOX_SNAPSHOT_COMMIT: "abc1234",
      },
    ],
    [
      "an id with a space or a newline",
      {
        SANDBOX_SNAPSHOT_ID: "snap x\ny",
        SANDBOX_IMAGE_DIGEST: DIGEST,
        SANDBOX_SNAPSHOT_COMMIT: COMMIT,
      },
    ],
  ])("is no pair with %s", (_name, variables) => {
    expect(pairFrom(variables)).toBeUndefined();
  });

  // #403-T13
  it("writes the same pair as variables and as deployment meta, under the names the other steps read", () => {
    expect(pairToEnv(GOOD)).toEqual({
      SANDBOX_SNAPSHOT_ID: "snap_example01",
      SANDBOX_IMAGE_DIGEST: DIGEST,
      SANDBOX_SNAPSHOT_COMMIT: COMMIT,
    });
    expect(pairToMeta(GOOD)).toEqual({
      sandboxSnapshotId: "snap_example01",
      sandboxImageDigest: DIGEST,
      sandboxSnapshotCommit: COMMIT,
    });
  });

  // #403-T13
  it("compares pairs value by value", () => {
    expect(pairsEqual(GOOD, { ...GOOD })).toBe(true);
    expect(pairsEqual(GOOD, { ...GOOD, snapshotId: "snap_example02" })).toBe(
      false,
    );
    expect(pairsEqual(GOOD, undefined)).toBe(false);
  });
});

describe("a pulled environment file", () => {
  // #403-T13
  it("reads quoted, single quoted and bare values and ignores comments and blank lines", () => {
    expect(
      parseDotenv(
        [
          "# Created by Vercel CLI",
          "",
          'SANDBOX_SNAPSHOT_ID="snap_example01"',
          "SANDBOX_IMAGE_DIGEST='sha256:abc'",
          "PLAIN=value",
          'EMPTY=""',
          "export EXPORTED=1",
          "not a line",
        ].join("\n"),
      ),
    ).toEqual({
      SANDBOX_SNAPSHOT_ID: "snap_example01",
      SANDBOX_IMAGE_DIGEST: "sha256:abc",
      PLAIN: "value",
      EMPTY: "",
      EXPORTED: "1",
    });
  });
});

describe("the inputs of the Worker image", () => {
  const root = join(import.meta.dirname, "..", "..", "..");
  const dockerfile = readFileSync(join(root, "runner/Dockerfile"), "utf8");

  /** The files and folders the Dockerfile copies out of the build context (not from another stage). */
  const copied = dockerfile
    .split("\n")
    .filter((line) => /^COPY\s/.test(line) && !line.includes("--from="))
    .flatMap((line) =>
      line
        .replace(/^COPY\s+/, "")
        .split(/\s+/)
        .filter((word) => !word.startsWith("--"))
        .slice(0, -1),
    );
  const inList = (path: string): boolean =>
    IMAGE_INPUT_PATHS.some(
      (input) => path === input || path.startsWith(`${input}/`),
    );

  // #403-T14
  it("cover every file the Dockerfile copies from the build context", () => {
    expect(copied.length).toBeGreaterThan(8);
    for (const source of copied) expect(inList(source), source).toBe(true);
  });

  // #403-T14
  it("take nothing else of the image's folders: no tests, no README, nothing the build does not copy", () => {
    // The context files that decide what the build sees, the VM script, and the build tool's own files.
    const EXTRA = new Set([
      "runner/Dockerfile",
      "runner/Dockerfile.dockerignore",
      "docker/sandbox/vm-prepare.sh",
      "docker/sandbox/sysbox-prepare.sh",
      "dispatcher/src/snapshot/config.ts",
      "dispatcher/src/snapshot/pipeline.ts",
      "dispatcher/src/snapshot/probe-flags.ts",
      "dispatcher/src/snapshot/scripts.ts",
    ]);
    for (const path of IMAGE_INPUT_PATHS)
      expect(
        copied.includes(path) || EXTRA.has(path),
        `${path} is neither copied by the Dockerfile nor a context or tool file`,
      ).toBe(true);
    for (const wide of [
      "runner",
      "runner/tests",
      "runner/README.md",
      "dispatcher/src/snapshot",
      "docker/sandbox",
    ])
      expect(IMAGE_INPUT_PATHS as readonly string[], wide).not.toContain(wide);
  });

  // #403-T14
  it("name only paths that exist", () => {
    for (const path of IMAGE_INPUT_PATHS)
      expect(existsSync(join(root, path)), path).toBe(true);
  });

  // #403-T14
  it("have no way into the image the test above cannot see: no ADD, no bind mount, no copy from the context by URL", () => {
    expect(dockerfile).not.toMatch(/^\s*ADD\s/m);
    expect(dockerfile).not.toMatch(/--mount=[^\n]*type=bind/);
    expect(dockerfile).not.toMatch(/^COPY\s[^\n]*https?:/m);
  });

  // #403-T14
  it("cover every file of the build tool that decides what is in the snapshot: what the pipeline imports, apart from files that only carry codes and types", () => {
    const IGNORED = new Set([
      "errors.ts",
      "record.ts",
      "retention.ts",
      "service.ts",
      "names.ts",
    ]);
    const seen = new Set<string>();
    const walk = (file: string): void => {
      if (seen.has(file)) return;
      seen.add(file);
      const text = readFileSync(join(import.meta.dirname, file), "utf8");
      for (const match of text.matchAll(
        /^import [^;]*? from "\.\/([\w-]+\.ts)";/gm,
      ))
        walk(match[1] as string);
    };
    walk("pipeline.ts");
    const tooling = [...seen].filter((file) => !IGNORED.has(file));
    expect(tooling.sort()).toEqual([
      "config.ts",
      "pipeline.ts",
      "probe-flags.ts",
      "scripts.ts",
    ]);
    for (const file of tooling)
      expect(IMAGE_INPUT_PATHS as readonly string[]).toContain(
        `dispatcher/src/snapshot/${file}`,
      );
  });

  // #403-T14
  it("track the build target default: it lives in config.ts, which is an input, and the workflow does not repeat it", () => {
    const workflow = readFileSync(
      join(root, ".github/workflows/golden-snapshot.yml"),
      "utf8",
    );
    expect(
      readFileSync(join(import.meta.dirname, "config.ts"), "utf8"),
    ).toContain('target: "sandbox"');
    expect(workflow).not.toMatch(/inputs\.target \|\| /);
    expect(workflow).not.toMatch(/default: sandbox/);
  });
});
