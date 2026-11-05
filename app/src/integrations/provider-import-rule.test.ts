// SPDX-License-Identifier: LicenseRef-Proprietary

// Pins down the import rule that keeps the platform out of the rest of the app: only the registry
// and the providers' own folder may import a provider implementation. Jobs, the runner API and the
// UI import the normalized types, the IntegrationProvider interface or the registry, nothing else.
// The last test runs the rule on the real source tree.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  findProviderImportViolations,
  type SourceFile,
} from "./provider-import-rule.ts";

function file(path: string, content: string): SourceFile {
  return { path, content };
}

// The fixtures build their import statements instead of spelling them out, so that the real-tree
// test at the end does not mistake this file for a violation.
const importLine = (specifier: string) => `import x from "${specifier}";`;
const dynamicImport = (specifier: string) =>
  `const p = await import("${specifier}");`;
const reExport = (specifier: string) => `export * from "${specifier}";`;
const GITHUB = "integrations/providers/github-app";

const SKIPPED_DIRECTORIES = new Set([
  "node_modules",
  ".next",
  ".git",
  "out",
  "build",
  "coverage",
  "playwright-report",
  "test-results",
]);

/** Every TypeScript and JavaScript file of the app folder, paths relative to it. */
function collectSourceFiles(root: string, directory = ""): SourceFile[] {
  const files: SourceFile[] = [];
  for (const entry of readdirSync(join(root, directory), {
    withFileTypes: true,
  })) {
    const path = directory === "" ? entry.name : `${directory}/${entry.name}`;
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(entry.name))
        files.push(...collectSourceFiles(root, path));
    } else if (/\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(entry.name)) {
      files.push({ path, content: readFileSync(join(root, path), "utf8") });
    }
  }
  return files;
}

describe("the provider import rule", () => {
  // CR-20-T06
  it("flags a job module that imports the GitHub provider and names the file", () => {
    const specifier = `../${GITHUB}/provider.ts`;

    const violations = findProviderImportViolations([
      file("src/jobs/enqueue.ts", importLine(specifier)),
    ]);

    expect(violations).toEqual([{ file: "src/jobs/enqueue.ts", specifier }]);
  });

  // CR-20-T06
  it("flags the same import through the @ alias, a dynamic import and a re-export", () => {
    const violations = findProviderImportViolations([
      file("src/app/runners/page.tsx", importLine(`@/${GITHUB}`)),
      file(
        "src/app/api/runners/claim/route.ts",
        dynamicImport(`@/${GITHUB}/provider.ts`),
      ),
      file("src/ui/index.ts", reExport(`../${GITHUB}/index.ts`)),
    ]);

    expect(violations.map((violation) => violation.file)).toEqual([
      "src/app/runners/page.tsx",
      "src/app/api/runners/claim/route.ts",
      "src/ui/index.ts",
    ]);
  });

  it("allows the registry and the providers' own folder to import a provider", () => {
    const violations = findProviderImportViolations([
      file(
        "src/integrations/registry.ts",
        importLine("./providers/github-app/index.ts"),
      ),
      file(
        "src/integrations/providers/github-app/webhook.ts",
        [importLine("./sign.ts"), importLine("../other/index.ts")].join("\n"),
      ),
    ]);

    expect(violations).toEqual([]);
  });

  it("allows importing the interface, the normalized types and the registry from anywhere", () => {
    const violations = findProviderImportViolations([
      file(
        "src/jobs/enqueue.ts",
        [
          importLine("../integrations/types.ts"),
          importLine("@/integrations/provider.ts"),
          importLine("../integrations/registry.ts"),
          importLine("../integrations/providers-overview.ts"),
        ].join("\n"),
      ),
    ]);

    expect(violations).toEqual([]);
  });

  it("does not count a mention in a comment as an import", () => {
    const specifier = `../${GITHUB}`;

    const violations = findProviderImportViolations([
      file(
        "src/jobs/enqueue.ts",
        [
          `// never: ${importLine(specifier)}`,
          "/*",
          ` * ${importLine(specifier)}`,
          " */",
        ].join("\n"),
      ),
    ]);

    expect(violations).toEqual([]);
  });

  it("reports a violation in a test file as well", () => {
    const violations = findProviderImportViolations([
      file("src/jobs/enqueue.test.ts", importLine(`../${GITHUB}/provider.ts`)),
    ]);

    expect(violations).toHaveLength(1);
  });

  it("flags vi.mock, require, an import type and an import-equals of a provider", () => {
    const specifier = `../${GITHUB}/provider.ts`;
    const files = [
      file("src/jobs/a.test.ts", `vi.mock("${specifier}");`),
      file("src/jobs/b.ts", `const p = require("${specifier}");`),
      file("src/jobs/c.ts", `let x: import("${specifier}").Provider;`),
      file("src/jobs/d.ts", `import p = require("${specifier}");`),
      file("src/jobs/e.test.ts", `await vi.importActual("${specifier}");`),
    ];

    expect(
      findProviderImportViolations(files).map((violation) => violation.file),
    ).toEqual(files.map((f) => f.path));
  });

  it("flags a template literal whose fixed start points into a provider folder", () => {
    const violations = findProviderImportViolations([
      file(
        "src/jobs/load.ts",
        "const p = await import(`../integrations/providers/${name}/index.ts`);",
      ),
      file(
        "src/jobs/safe.ts",
        "const p = await import(`./modules/${name}.ts`);",
      ),
    ]);

    expect(violations.map((violation) => violation.file)).toEqual([
      "src/jobs/load.ts",
    ]);
  });

  it("flags a specifier that spells the providers folder through escape sequences", () => {
    // None of the files contains the folder's name as plain text, so a filter that only looks for
    // the name in the source would let them through.
    const spelled = (escaped: string) =>
      importLine(`../integrations/${escaped}/github-app/index.ts`);
    const files = [
      file("src/jobs/a.ts", spelled("prov\\u0069ders")),
      file("src/jobs/b.ts", spelled("prov\\u{69}ders")),
      file("src/jobs/c.ts", spelled("prov\\x69ders")),
      file("src/jobs/d.ts", spelled("prov\\151ders")),
      file("src/jobs/e.ts", spelled("prov\\\niders")),
      file("src/jobs/f.ts", spelled("prov\\iders")),
      file(
        "src/jobs/g.ts",
        "const p = await import(`../integrations/prov\\u0069ders/${name}/index.ts`);",
      ),
    ];

    expect(files.filter((f) => f.content.includes("providers"))).toEqual([]);
    expect(
      findProviderImportViolations(files).map((violation) => violation.file),
    ).toEqual(files.map((f) => f.path));
  });

  it("does not flag a file with escape sequences that spell something else", () => {
    const violations = findProviderImportViolations([
      file(
        "src/jobs/enqueue.ts",
        [
          importLine("../integrations/types\\u002Ets"),
          "const pattern = /\\d+\\/providers?/;",
          'const text = "a\\nb \\u0070ro\\x76iders";',
        ].join("\n"),
      ),
    ]);

    expect(violations).toEqual([]);
  });

  it("scans plain JavaScript and files at the root of the app", () => {
    const violations = findProviderImportViolations([
      file("proxy.js", importLine(`./src/${GITHUB}/provider.js`)),
      file("scripts/setup.mjs", importLine(`../src/${GITHUB}/provider.js`)),
    ]);

    expect(violations.map((violation) => violation.file)).toEqual([
      "proxy.js",
      "scripts/setup.mjs",
    ]);
  });

  it("is not fooled by comments, strings or trailing comments", () => {
    const specifier = `../${GITHUB}`;
    const violations = findProviderImportViolations([
      file(
        "src/jobs/enqueue.ts",
        [
          `import { x } from "./x.ts"; // ${importLine(specifier)}`,
          `/* a block comment`,
          `   that goes on: ${importLine(specifier)} */`,
          `const text = '${importLine(specifier)}';`,
        ].join("\n"),
      ),
    ]);

    expect(violations).toEqual([]);
  });

  it("holds for every source file of the app", () => {
    const root = fileURLToPath(new URL("../../", import.meta.url));
    const files = collectSourceFiles(root);

    expect(files.length).toBeGreaterThan(10);
    expect(files.map((f) => f.path)).toContain("next.config.ts");
    expect(findProviderImportViolations(files)).toEqual([]);
  });
});
