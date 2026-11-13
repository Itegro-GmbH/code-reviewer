// SPDX-License-Identifier: LicenseRef-Proprietary

// TypeScript types of the contract schemas (contracts/*.v1.json), generated into the two projects that
// speak them, so neither imports the other's source (#318). The schemas are the source; the generated
// files are committed and `make verify` fails while one differs (checkGenerated). Regenerate with
// `make generate-contracts`.
//
// Node runs this file as it is (type stripping), see cli.ts: relative imports with the .ts extension
// and no TypeScript-only runtime syntax.
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { compile } from "json-schema-to-typescript";
import { format } from "prettier";

export const REGENERATE_COMMAND = "make generate-contracts";

/** The contract files that get types, without `.v1.json`. The operator API has no second reader. */
export const SCHEMAS = [
  "runner-api",
  "worker-api",
  "dispatch-webhook",
  "worker-container",
  "environment-control",
  "vm-init",
] as const;

/** Where the generated files go, relative to the repository root. One identical copy per project. */
export const TYPE_TARGETS = [
  { directory: "app/src/contracts" },
  { directory: "dispatcher/src/contracts" },
] as const;

export type GeneratedFile = { path: string; content: string };

const REPOSITORY = join(import.meta.dirname, "..", "..", "..", "..");
const ROOT_NAME = "ContractRoot";

/** The text the library writes about the (empty) root type; it is not part of the contract. */
function withoutRoot(code: string): string {
  return code
    .replace(new RegExp(`export interface ${ROOT_NAME} \\{[^}]*\\}\\n+`), "")
    .replace(
      new RegExp(
        `\\s*\\*\\s*\\n\\s*\\* This (?:interface|type) was referenced by \`${ROOT_NAME}\`'s JSON-Schema\\n\\s*\\* via the \`definition\` "[^"]+"\\.`,
        "g",
      ),
      "",
    );
}

async function typesOf(name: string, contracts: string): Promise<string> {
  const file = `${name}.v1.json`;
  const schema = JSON.parse(await readFile(join(contracts, file), "utf8")) as {
    title?: string;
    description?: string;
  };
  // The root only carries the metadata of the file; the definitions are the types.
  schema.title = ROOT_NAME;
  delete schema.description;
  const code = withoutRoot(
    await compile(schema as never, ROOT_NAME, {
      cwd: `${contracts}/`,
      unreachableDefinitions: true,
      additionalProperties: true,
      bannerComment: "",
      format: false,
      // A reference to a sibling contract file is read from disk, never fetched.
      $refOptions: { resolve: { http: false } },
    }),
  );
  const header = [
    "// SPDX-License-Identifier: LicenseRef-Proprietary",
    "",
    `// Generated from contracts/${file}. Do not edit: change the schema and run \`${REGENERATE_COMMAND}\`.`,
    "// `make verify` fails while this file differs from what the schema generates.",
    "",
    "",
  ].join("\n");
  return format(`${header}${code}`, { parser: "typescript" });
}

/** Every generated file of every target, from the schemas in `contracts`. */
export async function generateTypes(
  contracts = join(REPOSITORY, "contracts"),
): Promise<GeneratedFile[]> {
  const files: GeneratedFile[] = [];
  for (const name of SCHEMAS) {
    const content = await typesOf(name, contracts);
    for (const target of TYPE_TARGETS)
      files.push({ path: `${target.directory}/${name}.ts`, content });
  }
  return files;
}

export async function writeGenerated(root = REPOSITORY): Promise<void> {
  const files = await generateTypes();
  for (const target of TYPE_TARGETS)
    await mkdir(join(root, target.directory), { recursive: true });
  for (const file of files)
    await writeFile(join(root, file.path), file.content);
  // A file of a schema that was removed must not linger.
  for (const path of await leftovers(root, files)) await rm(join(root, path));
}

async function leftovers(
  root: string,
  files: GeneratedFile[],
): Promise<string[]> {
  const expected = new Set(files.map((file) => file.path));
  const found: string[] = [];
  for (const target of TYPE_TARGETS) {
    let names: string[] = [];
    try {
      names = await readdir(join(root, target.directory));
    } catch {
      continue;
    }
    for (const name of names) {
      const path = `${target.directory}/${name}`;
      if (name.endsWith(".ts") && !expected.has(path)) found.push(path);
    }
  }
  return found;
}

export type CheckResult = { stale: string[]; message: string };

/** The files under `root` that differ from what the schemas generate (changed, missing or left over). */
export async function checkGenerated(root = REPOSITORY): Promise<CheckResult> {
  const files = await generateTypes();
  const stale: string[] = [];
  for (const file of files) {
    const current = await readFile(join(root, file.path), "utf8").catch(
      () => null,
    );
    if (current !== file.content) stale.push(file.path);
  }
  stale.push(...(await leftovers(root, files)));
  stale.sort();
  if (stale.length === 0) return { stale, message: "" };
  return {
    stale,
    message: [
      "The generated contract types are out of date with contracts/*.v1.json:",
      ...stale.map((path) => `  ${path}`),
      `Regenerate them with \`${REGENERATE_COMMAND}\` and commit the result.`,
    ].join("\n"),
  };
}
