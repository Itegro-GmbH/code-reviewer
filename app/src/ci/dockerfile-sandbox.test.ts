// SPDX-License-Identifier: LicenseRef-Proprietary

// Pins down the Sandbox target of runner/Dockerfile (#324): the Worker image of the hosted
// deployment and the only image of the project. It keeps the pins, the user layout and the
// fail-closed self-check of #202, and it carries no Dispatcher bundle. The built image is judged by
// docker/smoke/runner.sh (nothing of a Dispatcher inside), which CI runs; here the Dockerfile that
// makes it is.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const dockerfile = readFileSync(`${repoRoot}runner/Dockerfile`, "utf8");

type Stage = { name: string; base: string; lines: string[] };

function stages(source: string): Stage[] {
  const lines = source
    .replace(/\\\n/g, " ")
    .split("\n")
    .map((line) => line.trim().replace(/\s+/g, " "))
    .filter((line) => line !== "" && !line.startsWith("#"));
  const found: Stage[] = [];
  for (const line of lines) {
    const from = /^FROM (\S+) AS (\S+)$/.exec(line);
    if (from)
      found.push({ name: from[2] ?? "", base: from[1] ?? "", lines: [] });
    else found.at(-1)?.lines.push(line);
  }
  return found;
}

function stage(name: string): Stage {
  const found = stages(dockerfile).find((entry) => entry.name === name);
  if (!found) throw new Error(`no stage ${name}`);
  return found;
}

/** The stage and every stage it is built on, base first. */
function lineage(name: string): Stage[] {
  const own = stage(name);
  const parent = stages(dockerfile).find((entry) => entry.name === own.base);
  return [...(parent ? lineage(parent.name) : []), own];
}

describe("the Sandbox image target", () => {
  // #324-T09
  it("is the last stage, so the default target is the Worker image", () => {
    expect(stages(dockerfile).at(-1)?.name).toBe("sandbox");
  });

  // #324-T09
  it("is built on the shared base stage and on nothing else of the file", () => {
    expect(lineage("sandbox").map((entry) => entry.name)).toEqual([
      "runtime-base",
      "sandbox",
    ]);
  });

  // #324-T09, #761-T02: Node.js is there for the Implementer's agent (the pinned toolchain), a Dispatcher is not.
  it("carries no Dispatcher bundle; Node.js comes only from the pinned toolchain stage", () => {
    const image = lineage("sandbox")
      .flatMap((entry) => entry.lines)
      .join("\n");

    expect(image).not.toMatch(/dispatcher/i);
    expect(image).not.toMatch(/COPY[^\n]*dispatcher/i);
    expect(image).not.toMatch(/apt-get install[^\n]*\bnode(js)?\b/);
    expect(image).toContain(
      "COPY --from=toolchain-fetch --chown=0:0 /toolchain/node /opt/node",
    );
  });

  // #324-T09: the target keeps the entry point and ends on the unprivileged user.
  it("keeps the entry point of the image and ends on the unprivileged user", () => {
    const own = lineage("sandbox").flatMap((entry) => entry.lines);

    expect(own).toContain(
      'ENTRYPOINT ["/usr/bin/tini", "--", "code-reviewer-runner"]',
    );
    expect(own.filter((line) => line.startsWith("USER ")).at(-1)).toBe(
      "USER 10001:10001",
    );
  });

  // #324-T09: the image has its own title.
  it("has its own title and enables nothing", () => {
    const labels = stage("sandbox").lines.join("\n");

    expect(labels).toContain("Sandbox");
    const settings = lineage("sandbox")
      .flatMap((entry) => entry.lines)
      .filter((line) => /^(ENV|ARG) /.test(line));
    expect(settings.join("\n")).not.toMatch(
      /RUNNER_DYNAMIC|RUNNER_OPENCODE|RUNNER_DIFF_JOB_USER|RUNNER_ADVERTISED|RUNNER_MODE/,
    );
  });
});
