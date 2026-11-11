// SPDX-License-Identifier: LicenseRef-Proprietary

// Which model names are the same model for Claude Code (#980). A runner announces the models of its subscription as its owner gave them (the aliases
// `sonnet`, `opus` and `haiku` by default, or ids) and a turn carries the model its profile names, an alias or an id. Two names match when they are
// equal, or when one is an alias and the other an id it stands for; two different ids never match and nothing else does. The map is the contract
// `contracts/claude-model-aliases.v1.json`: this is the app's typed copy (a test compares the two and runs the contract's vectors through both), the
// runner keeps its own (`implementer/claude_code/model_names.py`), and `accessRule` writes the same rule for the database from these patterns.

/** An alias and the pattern of the ids it stands for; one regular expression that JavaScript, Python and PostgreSQL read alike. */
export type ModelAlias = { readonly alias: string; readonly idPattern: string };

export const CLAUDE_MODEL_ALIASES: readonly ModelAlias[] = [
  { alias: "sonnet", idPattern: "^claude-([0-9]+(-[0-9]+)?-)?sonnet(-|$)" },
  { alias: "opus", idPattern: "^claude-([0-9]+(-[0-9]+)?-)?opus(-|$)" },
  { alias: "haiku", idPattern: "^claude-([0-9]+(-[0-9]+)?-)?haiku(-|$)" },
];

const COMPILED = CLAUDE_MODEL_ALIASES.map(
  ({ alias, idPattern }) => [alias, new RegExp(idPattern)] as const,
);

/** The alias an id belongs to, or null (an alias, an id of no known family, any other name). */
export function aliasOf(model: string): string | null {
  for (const [alias, pattern] of COMPILED)
    if (pattern.test(model)) return alias;
  return null;
}

/** Whether a model a device allows is the model a job asks for: equal, or an alias and an id it stands for. */
export function modelsMatch(announced: string, demanded: string): boolean {
  return (
    announced === demanded ||
    aliasOf(announced) === demanded ||
    aliasOf(demanded) === announced
  );
}

/** Whether a list of models (undefined: the device allows any) allows the model a job names. */
export function modelsAllow(
  models: readonly string[] | undefined,
  demanded: string,
): boolean {
  return (
    models === undefined || models.some((model) => modelsMatch(model, demanded))
  );
}
