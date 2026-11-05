// SPDX-License-Identifier: LicenseRef-Proprietary

// The import rule behind the integration boundary: platform specific code (a provider
// implementation under src/integrations/providers/) is imported by the registry and by the provider's
// own folder only. Everything else, jobs, the runner API, the UI, depends on the normalized types,
// the IntegrationProvider interface and the registry. Pure function, no file system access, so it can
// be run by a test today and by a structure check (`verify:structure`) later.
//
// The files are parsed with the TypeScript compiler, so comments and strings never count, and these
// forms do: `import`/`export ... from`, `import x = require()`, `import()` (also as a type),
// `require()`, and `vi.mock`/`vi.doMock`/`vi.importActual`-style calls (`jest.*` too). A template
// literal with substitutions counts when its fixed start already points into a provider folder.
// A specifier that is built entirely at run time cannot be seen.
//
// Parsing every file of the app costs seconds and grows with it, so a file is parsed only if it can
// reach a provider folder at all (`mayReachProviders`). That is a filter in front of the parser, not
// a second rule: it lets through every file the parser could report.
import { posix } from "node:path";
import ts from "typescript";

export type SourceFile = {
  /** Path relative to the app folder, for example "src/jobs/enqueue.ts". */
  path: string;
  content: string;
};

export type ProviderImportViolation = {
  file: string;
  /** The import specifier exactly as written (for a template literal: its fixed start). */
  specifier: string;
};

const PROVIDERS_DIRECTORY = "src/integrations/providers";
const PROVIDERS_NAME = PROVIDERS_DIRECTORY.slice(
  PROVIDERS_DIRECTORY.lastIndexOf("/") + 1,
);
const REGISTRY_FILE = "src/integrations/registry.ts";
const MODULE_FUNCTIONS = new Set([
  "mock",
  "doMock",
  "unmock",
  "doUnmock",
  "importActual",
  "importMock",
]);

// An escape sequence of a string or template literal: a unicode escape (four digits or in braces), a
// hex or an octal escape, a line continuation, or a backslash before any other character.
const ESCAPE =
  /\\(?:u\{([0-9a-fA-F]+)\}|u([0-9a-fA-F]{4})|x([0-9a-fA-F]{2})|([0-7]{1,3})|\r\n|[\n\r\u2028\u2029]|([\s\S]))/g;

function unescapeLiterals(content: string): string {
  return content.replace(
    ESCAPE,
    (
      _match,
      braced: string | undefined,
      unicode: string | undefined,
      hex: string | undefined,
      octal: string | undefined,
      plain: string | undefined,
    ) => {
      const code = braced ?? unicode ?? hex;
      if (code !== undefined) {
        const value = Number.parseInt(code, 16);
        return value <= 0x10ffff ? String.fromCodePoint(value) : "";
      }
      if (octal !== undefined)
        return String.fromCharCode(Number.parseInt(octal, 8));
      return plain ?? "";
    },
  );
}

/**
 * Whether a file can import something inside the providers folder. A specifier from a file outside
 * it only resolves into it by spelling the folder's name (`./providers/...`, `@/integrations/providers`,
 * the fixed start of a template literal), if need be through escape sequences. Unescaping the whole
 * file shows that text wherever it stands in a literal; extra text elsewhere only means that a file
 * is parsed which did not need to be.
 */
function mayReachProviders(content: string): boolean {
  if (content.includes(PROVIDERS_NAME)) return true;
  return (
    content.includes("\\") && unescapeLiterals(content).includes(PROVIDERS_NAME)
  );
}

function resolveSpecifier(file: string, specifier: string): string | null {
  const resolved = specifier.startsWith("@/")
    ? posix.join("src", specifier.slice(2))
    : specifier.startsWith(".")
      ? posix.join(posix.dirname(file), specifier)
      : null;
  return resolved === null ? null : resolved.replace(/\/+$/, "");
}

function isInsideProviders(path: string): boolean {
  return (
    path === PROVIDERS_DIRECTORY || path.startsWith(`${PROVIDERS_DIRECTORY}/`)
  );
}

/** The fixed text of a module specifier expression, or undefined if it has none. */
function specifierText(node: ts.Node | undefined): string | undefined {
  if (node === undefined) return undefined;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    return node.text;
  if (ts.isTemplateExpression(node)) return node.head.text;
  return undefined;
}

function specifiersOf(source: ts.SourceFile): string[] {
  const found: string[] = [];
  const add = (node: ts.Node | undefined) => {
    const text = specifierText(node);
    if (text !== undefined) found.push(text);
  };

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
      add(node.moduleSpecifier);
    else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    )
      add(node.moduleReference.expression);
    else if (ts.isImportTypeNode(node)) {
      if (ts.isLiteralTypeNode(node.argument)) add(node.argument.literal);
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const isModuleCall =
        callee.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(callee) && callee.text === "require") ||
        (ts.isPropertyAccessExpression(callee) &&
          ts.isIdentifier(callee.expression) &&
          (callee.expression.text === "vi" ||
            callee.expression.text === "jest") &&
          MODULE_FUNCTIONS.has(callee.name.text));
      if (isModuleCall) add(node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

export function findProviderImportViolations(
  files: SourceFile[],
): ProviderImportViolation[] {
  const violations: ProviderImportViolation[] = [];

  for (const { path, content } of files) {
    const file = path.split("\\").join("/");
    if (file === REGISTRY_FILE || isInsideProviders(file)) continue;

    if (!mayReachProviders(content)) continue;

    const source = ts.createSourceFile(file, content, ts.ScriptTarget.Latest);
    for (const specifier of specifiersOf(source)) {
      const resolved = resolveSpecifier(file, specifier);
      if (resolved !== null && isInsideProviders(resolved))
        violations.push({ file, specifier });
    }
  }
  return violations;
}
