// SPDX-License-Identifier: LicenseRef-Proprietary

// Pins down the pnpm workspace of the app and the Dispatcher (#724): one pnpm-workspace.yaml and one pnpm-lock.yaml at the
// root, a catalog for what both projects share, installs that name the project they need, and the website outside of
// it. A second lockfile, a shared version written twice or an install of the whole workspace in a job that needs one
// project would bring back the drift and the install time that the workspace removed.
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { allActionFiles, readText, repoRoot } from "./workflow-support.ts";

type Manifest = {
  name?: string;
  private?: boolean;
  packageManager?: string;
  engines?: { node?: string };
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};
type Workspace = {
  packages?: string[];
  catalog?: Record<string, string>;
  ignoredBuiltDependencies?: string[];
};
type Lock = {
  lockfileVersion: string;
  catalogs?: { default?: Record<string, { specifier: string }> };
  importers: Record<string, unknown>;
};

const manifest = (path: string) => JSON.parse(readText(path)) as Manifest;
const root = manifest("package.json");
const app = manifest("app/package.json");
const dispatcher = manifest("dispatcher/package.json");
const workspace = parse(readText("pnpm-workspace.yaml")) as Workspace;
const lock = parse(readText("pnpm-lock.yaml")) as Lock;

// Declared by both projects with the same range, and not yet in the catalog: the two lockfiles resolved ^5.0.3 to 5.0.3
// (app) and 5.0.4 (Dispatcher), and one catalog entry would have moved the app to 5.0.4 in a change that must not change
// a resolved version. Remove it from here when the bump that aligns them puts it into the catalog.
const SHARED_OUTSIDE_THE_CATALOG = ["vitest"];

function declared(project: Manifest): Record<string, string> {
  return { ...project.dependencies, ...project.devDependencies };
}

describe("the pnpm workspace", () => {
  // #724-T01
  it("has the app and the Dispatcher as its two projects and nothing else, one lockfile at the root and none beside them", () => {
    expect(workspace.packages).toEqual(["app", "dispatcher"]);
    // `.` is the private root itself, which has no dependencies.
    expect(Object.keys(lock.importers).sort()).toEqual([
      ".",
      "app",
      "dispatcher",
    ]);
    expect(lock.importers["."]).toEqual({});
    expect(existsSync(`${repoRoot}pnpm-lock.yaml`)).toBe(true);
    expect(existsSync(`${repoRoot}app/pnpm-lock.yaml`)).toBe(false);
    expect(existsSync(`${repoRoot}dispatcher/pnpm-lock.yaml`)).toBe(false);
    // pnpm reads its settings from the workspace root only: a second file would be ignored without a word.
    expect(existsSync(`${repoRoot}app/pnpm-workspace.yaml`)).toBe(false);
    expect(existsSync(`${repoRoot}dispatcher/pnpm-workspace.yaml`)).toBe(false);
  });

  // #724-T01
  it("is a private root that pins the one pnpm and Node the projects use", () => {
    expect(root.private).toBe(true);
    expect(root.packageManager).toMatch(/^pnpm@10\.\d+\.\d+$/);
    // The projects keep the same pin: Vercel reads the package manager from the project's own package.json.
    expect(app.packageManager).toBe(root.packageManager);
    expect(dispatcher.packageManager).toBe(root.packageManager);
    expect(root.engines).toEqual(app.engines);
    expect(root.engines).toEqual(dispatcher.engines);
  });

  // #724-T01
  it("keeps the website out: its own lockfile, its own workspace root, so its install and the Cloudflare build never run the root one", () => {
    expect(workspace.packages).not.toContain("website");
    expect(existsSync(`${repoRoot}website/pnpm-lock.yaml`)).toBe(true);
    // Without this file pnpm walks up to the root workspace and installs that instead of the site.
    const own = parse(readText("website/pnpm-workspace.yaml")) as Workspace;
    expect(own.packages).toEqual(["."]);
  });

  // #724-T02
  it("writes every version the projects share once, in the catalog, and the lockfile records the same catalog", () => {
    const catalog = workspace.catalog ?? {};
    const shared = Object.keys(declared(app)).filter(
      (name) => name in declared(dispatcher),
    );

    expect(shared.length).toBeGreaterThan(0);
    for (const name of shared) {
      if (SHARED_OUTSIDE_THE_CATALOG.includes(name)) continue;
      expect(catalog, name).toHaveProperty([name]);
    }
    for (const name of Object.keys(catalog)) {
      for (const project of [app, dispatcher]) {
        const spec = declared(project)[name];
        if (spec !== undefined) expect(spec, name).toBe("catalog:");
      }
    }
    expect(
      Object.fromEntries(
        Object.entries(lock.catalogs?.default ?? {}).map(([name, entry]) => [
          name,
          entry.specifier,
        ]),
      ),
    ).toEqual(catalog);
  });

  // #724-T02
  it("keeps the build-script exclusions the app had in its own pnpm-workspace.yaml", () => {
    expect(workspace.ignoredBuiltDependencies?.sort()).toEqual([
      "sharp",
      "unrs-resolver",
    ]);
  });
});

describe("the installs", () => {
  // #724-T01
  it("are frozen, name the project they need and the packages it needs, and never use --dir or a project's own lockfile", () => {
    const installs: string[] = [];
    for (const [path, text] of allActionFiles()) {
      expect(text, path).not.toMatch(/package_json_file: (?:app|dispatcher)\//);
      expect(text, path).not.toMatch(/(?:app|dispatcher)\/pnpm-lock\.yaml/);
      expect(text, path).not.toMatch(/pnpm --dir \S+ install/);
      for (const line of text.split("\n")) {
        const command = line.trim().replace(/^run:\s*/, "");
        if (!command.startsWith("pnpm install")) continue;
        // The landing page is its own pnpm project (website-workflow.test.ts).
        if (
          path.endsWith("ci.yml") &&
          command === "pnpm install --frozen-lockfile"
        )
          continue;
        installs.push(`${path}: ${command}`);
      }
    }

    expect(installs.length).toBeGreaterThanOrEqual(10);
    for (const install of installs) {
      expect(install).toMatch(
        /pnpm install --frozen-lockfile (?:--ignore-scripts )?(?:--filter "?(?:code-reviewer-(?:app|dispatcher)|\.\/\$DIRECTORY)\.\.\."? ?)+$/,
      );
    }
  });

  // #724-T01
  it("are the projects' own install commands on Vercel, filtered to the project", () => {
    const commands = {
      app: "pnpm install --frozen-lockfile --filter code-reviewer-app...",
      dispatcher:
        "pnpm install --frozen-lockfile --filter code-reviewer-dispatcher...",
    };
    for (const [project, command] of Object.entries(commands)) {
      const config = JSON.parse(readText(`${project}/vercel.json`)) as {
        installCommand?: string;
      };
      expect(config.installCommand, project).toBe(command);
    }
    expect(app.name).toBe("code-reviewer-app");
    expect(dispatcher.name).toBe("code-reviewer-dispatcher");
  });

  // #724-T01
  it("key the dependency cache on the one lockfile", () => {
    for (const [path, text] of allActionFiles()) {
      for (const match of text.matchAll(/cache-dependency-path: (\S+)/g)) {
        const value = match[1];
        // The landing page keeps its own lockfile.
        if (value === "website/pnpm-lock.yaml") continue;
        expect(value, path).toBe("pnpm-lock.yaml");
      }
    }
  });
});
