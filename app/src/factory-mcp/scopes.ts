// SPDX-License-Identifier: LicenseRef-Proprietary

// The two scopes of the factory MCP server (epic #1143). `factory:read` looks (projects, lanes, runs, models, costs);
// `factory:control` also changes things (saves lanes, starts and cancels runs, answers ToDos, ...). Control includes read, so a
// token with control may call every read tool. The user's role in the workspace applies on top of the scope, per tool
// (`tools/define.ts`): a scope never gives more than the role allows.

export const FACTORY_SCOPES = ["factory:read", "factory:control"] as const;
export type FactoryScope = (typeof FACTORY_SCOPES)[number];

export function isFactoryScope(value: unknown): value is FactoryScope {
  return FACTORY_SCOPES.some((scope) => scope === value);
}

/** What the person is asked to approve when the client names no scope: look only. */
export const DEFAULT_SCOPE: FactoryScope = "factory:read";

/** The scopes of a space-separated value; `null` when it names anything that is not ours (nothing is dropped silently). */
export function parseScopeList(
  value: string | null | undefined,
): FactoryScope[] | null {
  if (value === null || value === undefined) return [];
  const names = value.split(" ").filter((name) => name !== "");
  const scopes: FactoryScope[] = [];
  for (const name of names) {
    if (!isFactoryScope(name)) return null;
    if (!scopes.includes(name)) scopes.push(name);
  }
  return scopes;
}

/** The space-separated text of a list, in the order of `FACTORY_SCOPES`. */
export function formatScopeList(scopes: readonly FactoryScope[]): string {
  return FACTORY_SCOPES.filter((scope) => scopes.includes(scope)).join(" ");
}

/** Whether a token that was granted `granted` may use something that needs `needed` (control includes read). */
export function scopeSatisfies(
  granted: readonly FactoryScope[],
  needed: FactoryScope,
): boolean {
  if (granted.includes(needed)) return true;
  return needed === "factory:read" && granted.includes("factory:control");
}

/** What a granted scope means to a person, in a sentence (the consent page and the list of connected apps). */
export const SCOPE_DESCRIPTIONS: Record<FactoryScope, string> = {
  "factory:read":
    "Read only: look at projects, lanes, runs, ToDos, runners, models and costs.",
  "factory:control":
    "Read and control: also save lanes, start, pause and cancel runs, answer ToDos and manage runners and agent MCP servers, within your role.",
};
