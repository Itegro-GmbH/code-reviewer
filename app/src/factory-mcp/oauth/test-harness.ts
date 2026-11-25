// SPDX-License-Identifier: LicenseRef-Proprietary

// The pieces the unit tests of the OAuth server and of the endpoint share: a clock that tests move, a store in memory, two
// workspaces and three people (Ada: Owner of "acme" and Member of "side"; Bob: Member of "acme"; Eve: member of nothing), and a
// walk through the whole flow with PKCE. Test use only.
import type { Membership } from "../../db/repositories/workspaces-repository.ts";
import type { WorkspaceRole } from "../../db/workspace-roles.ts";
import { s256Challenge } from "./tokens.ts";
import { createMemoryStore, type MemoryStore } from "./memory-store.ts";
import { createOAuthService, type OAuthService } from "./service.ts";

export const ISSUER = "https://factory.example.test";
export const RESOURCE = `${ISSUER}/api/mcp`;
export const VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
export const REDIRECT = "http://127.0.0.1:33418/callback";

export const ADA = { id: "user-ada", name: "Ada", email: "ada@example.test" };
export const BOB = { id: "user-bob", name: "Bob", email: "bob@example.test" };
export const EVE = { id: "user-eve", name: "Eve", email: "eve@example.test" };

export const ACME = { id: "ws-acme", slug: "acme", name: "Acme" };
export const SIDE = { id: "ws-side", slug: "side", name: "Side Project" };

export type TestWorld = {
  store: MemoryStore;
  service: OAuthService;
  /** The memberships; a test removes one to end somebody's access. */
  members: Map<string, WorkspaceRole>;
  clock: { now: Date };
  advance(ms: number): void;
};

function membershipOf(
  workspace: typeof ACME,
  role: WorkspaceRole,
): Membership {
  return {
    role,
    workspace: {
      ...workspace,
      createdBy: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      deletedAt: null,
    },
  };
}

export function createWorld(): TestWorld {
  const clock = { now: new Date("2026-11-25T10:00:00.000Z") };
  const members = new Map<string, WorkspaceRole>([
    [`${ADA.id}:${ACME.id}`, "owner"],
    [`${ADA.id}:${SIDE.id}`, "member"],
    [`${BOB.id}:${ACME.id}`, "member"],
  ]);
  const workspaces = [ACME, SIDE];
  const store = createMemoryStore([ADA, BOB, EVE]);
  const service = createOAuthService({
    store,
    config: { issuer: ISSUER, resource: RESOURCE },
    now: () => clock.now,
    memberships: {
      async findMembershipById(userId, workspaceId) {
        const role = members.get(`${userId}:${workspaceId}`);
        const workspace = workspaces.find((entry) => entry.id === workspaceId);
        return role === undefined || workspace === undefined
          ? undefined
          : membershipOf(workspace, role);
      },
      async listForUser(userId) {
        return workspaces.flatMap((workspace) => {
          const role = members.get(`${userId}:${workspace.id}`);
          return role === undefined ? [] : [membershipOf(workspace, role)];
        });
      },
    },
  });
  return {
    store,
    service,
    members,
    clock,
    advance(ms) {
      clock.now = new Date(clock.now.getTime() + ms);
    },
  };
}

export async function registerClient(
  world: TestWorld,
  overrides: Record<string, unknown> = {},
): Promise<{ clientId: string }> {
  const result = await world.service.registerClient({
    client_name: "Claude Code",
    redirect_uris: [REDIRECT],
    ...overrides,
  });
  if (result.kind !== "ok") throw new Error(`registration failed: ${result.error}`);
  return { clientId: result.response.client_id };
}

export function authorizeParams(
  clientId: string,
  overrides: Record<string, string | undefined> = {},
): URLSearchParams {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: s256Challenge(VERIFIER),
    code_challenge_method: "S256",
    scope: "factory:read factory:control",
    state: "xyz",
    resource: RESOURCE,
  });
  for (const [key, value] of Object.entries(overrides))
    if (value === undefined) params.delete(key);
    else params.set(key, value);
  return params;
}

export type Connected = {
  clientId: string;
  accessToken: string;
  refreshToken: string;
  scope: string;
};

/** The whole flow for one person: register, authorize, consent, exchange. */
export async function connect(
  world: TestWorld,
  options: {
    user?: string;
    workspaceId?: string;
    scope?: string;
    clientId?: string;
  } = {},
): Promise<Connected> {
  const clientId = options.clientId ?? (await registerClient(world)).clientId;
  const started = await world.service.beginAuthorization(authorizeParams(clientId));
  if (started.kind !== "request") throw new Error(`authorize failed: ${started.kind}`);
  const decided = await world.service.decide({
    requestId: started.requestId,
    userId: options.user ?? ADA.id,
    decision: "approve",
    workspaceId: options.workspaceId ?? ACME.id,
    scope: options.scope ?? "factory:control",
  });
  if (decided.kind !== "redirect") throw new Error(`consent failed: ${decided.kind}`);
  const code = new URL(decided.redirectTo).searchParams.get("code");
  if (code === null) throw new Error("no code in the redirect");
  const exchanged = await world.service.exchange(
    new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT,
      client_id: clientId,
      code_verifier: VERIFIER,
      resource: RESOURCE,
    }),
  );
  if (exchanged.kind !== "ok") throw new Error(`exchange failed: ${exchanged.error}`);
  return {
    clientId,
    accessToken: exchanged.body.access_token,
    refreshToken: exchanged.body.refresh_token,
    scope: exchanged.body.scope,
  };
}
