// SPDX-License-Identifier: LicenseRef-Proprietary

// The LLM access of a workspace, put together over a database: the key service of the workspace, the operator's
// key, the access a job of the workspace gets (src/llm/resolve.ts: the key mode of its entitlements, or the workspace's choice while
// billing is on, decides whose key it is) and what the pages may show. The same code serves the running server (shared.ts) and the tests,
// which build it over a test database and a chosen environment.
import type { Kysely } from "kysely";
import type { Database } from "../db/schema.ts";
import { createSecretStore } from "../secrets/store.ts";
import { createWorkspaceSecretStore } from "../secrets/workspace-store.ts";
import { isBillingOn } from "../billing/enabled.ts";
import { readEffectiveEntitlements } from "../workspaces/effective-entitlements.ts";
import {
  type LlmAccessResult,
  type LlmAccessSource,
  type LlmNotConfiguredReason,
} from "./access.ts";
import { readLlmDefaults } from "./config.ts";
import {
  OPERATOR_LLM_KEY_NAMES,
  type WorkspaceLlmKeyName,
} from "./secret-names.ts";
import {
  DEFAULT_LLM_PROVIDER,
  llmProviderDescriptors,
} from "./providers/index.ts";
import {
  createOperatorLlmKeyService,
  type OperatorLlmKeyService,
} from "./operator-key.ts";
import {
  keyModeForJob,
  resolveWorkspaceLlmAccess,
  type ResolveLlmInput,
} from "./resolve.ts";
import {
  createWorkspaceLlmKeyService,
  type OperatorProviderLookup,
  type WorkspaceLlmKeyService,
} from "./workspace-key.ts";
import { withNativeProviders } from "../native-providers/lookup.ts";
import {
  createClaudeCodeTokenService,
  type ClaudeCodeTokenSecretName,
  type ClaudeCodeTokenService,
} from "./claude-code-token.ts";

type Env = Readonly<Record<string, string | undefined>>;

/** What the pages may know about the access of a workspace. Never a key, never a variable's value. */
export type WorkspaceLlmSummary =
  | { configured: true; source: LlmAccessSource }
  | { configured: false; reason: LlmNotConfiguredReason };

export function summarizeLlmAccess(
  result: LlmAccessResult,
): WorkspaceLlmSummary {
  return result.ok
    ? { configured: true, source: result.source }
    : { configured: false, reason: result.reason };
}

export type WorkspaceLlmAssembly = {
  keyServiceFor(workspaceId: string): WorkspaceLlmKeyService;
  /**
   * The Claude Code OAuth token of the workspace (#1150): a slot of the same encrypted store as its keys, but no provider (it is not
   * in the registry, and nothing that lists providers sees it). The runs of the harness `claude-code` read it.
   */
  claudeCodeTokenFor(workspaceId: string): ClaudeCodeTokenService;
  /**
   * The operator's own keys, one for each provider (the instance admin saves them; only the admin portal and this
   * assembly use them). They are the keys of a workspace whose key mode is `managed`, and of no other.
   */
  operatorKey(): OperatorLlmKeyService;
  /**
   * The access a job of this workspace gets, or `llm_not_configured`: the key its key mode names, the
   * workspace's own or the operator's, never the other. The own key is the one of `provider` (the default provider
   * until a project can choose); a key of another provider is never used. Nothing of another workspace is read.
   */
  accessFor(workspaceId: string, provider?: string): Promise<LlmAccessResult>;
  /**
   * The key a job needs once its provider is chosen (#432, ADR 0005, 2.8): the workspace's own key of `provider`, or the
   * operator's key of `provider`, as the selection says (`keySource`). Unlike `accessFor` it does not read the
   * entitlements again, so the key always belongs to the key mode the selection was made for. Nothing of the other key
   * is read, and nothing of another provider.
   */
  keyFor(
    workspaceId: string,
    selection: { keyMode: "own" | "managed"; provider: string },
  ): Promise<LlmAccessResult>;
  summaryFor(
    workspaceId: string,
    provider?: string,
  ): Promise<WorkspaceLlmSummary>;
  /**
   * The LLM keys that are current for this workspace right now, to mask in the result of one of its jobs: its
   * own key of every provider, its Claude Code OAuth token (#1150), and the operator's key of every provider while the workspace is `managed`. Fails
   * closed: a key that exists but cannot be decrypted is left out (it cannot appear in a result), but a read that
   * fails throws, so a caller never masks with fewer keys than it should (src/runner-api/known-secrets.ts).
   */
  currentKeysFor(workspaceId: string): Promise<string[]>;
};

export function createWorkspaceLlm({
  db,
  appSecret,
  env,
  now,
  providers = llmProviderDescriptors,
}: {
  db: Kysely<Database>;
  /**
   * The master key (`APP_SECRET`), asked for when it is needed: building the assembly never fails for want of
   * it (the runner API checks its token before anything else is touched).
   */
  appSecret: () => string;
  /** The environment as it is NOW; read on every call, never cached. */
  env: () => Env;
  now?: () => Date;
  /**
   * The providers of the registry; a test passes its own. The workspace's own key also knows the catalog providers
   * (#555); the operator's key and a managed job do not (their models are the catalog entries of the admin).
   */
  providers?: OperatorProviderLookup;
}): WorkspaceLlmAssembly {
  const ownProviders = withNativeProviders(providers);
  const keyServiceFor = (workspaceId: string) =>
    createWorkspaceLlmKeyService({
      store: createWorkspaceSecretStore<WorkspaceLlmKeyName>({
        db,
        workspaceId,
        appSecret: appSecret(),
        ...(now === undefined ? {} : { now }),
      }),
      providers: ownProviders,
    });

  const claudeCodeTokenFor = (workspaceId: string) =>
    createClaudeCodeTokenService({
      store: createWorkspaceSecretStore<ClaudeCodeTokenSecretName>({
        db,
        workspaceId,
        appSecret: appSecret(),
        ...(now === undefined ? {} : { now }),
      }),
    });

  const operatorKey = () =>
    createOperatorLlmKeyService({
      store: createSecretStore({
        db,
        names: OPERATOR_LLM_KEY_NAMES,
        appSecret: appSecret(),
        ...(now === undefined ? {} : { now }),
      }),
      providers,
    });

  // What the key mode of the workspace's entitlements asks for, and only that: a managed job never reads the
  // workspace's key, and any other job never reads the operator's.
  async function resolveInput(
    workspaceId: string,
    provider: string,
  ): Promise<ResolveLlmInput> {
    const mode = keyModeForJob(
      await readEffectiveEntitlements(db, workspaceId, now),
    );
    // The model and the context window of the instance; the key is the one the mode names.
    const defaults = readLlmDefaults(env());
    if (mode === "unreadable") return { keyMode: mode, defaults };
    if (mode === "managed")
      return {
        keyMode: mode,
        provider,
        operatorKey: await operatorKey().forJob(provider),
        defaults,
      };
    return {
      keyMode: mode,
      provider,
      key: await keyServiceFor(workspaceId).keyFor(provider),
      defaults,
    };
  }

  async function accessFor(
    workspaceId: string,
    provider: string = DEFAULT_LLM_PROVIDER,
  ): Promise<LlmAccessResult> {
    const input = await resolveInput(workspaceId, provider);
    return resolveWorkspaceLlmAccess(
      input,
      input.keyMode === "own" ? ownProviders : providers,
    );
  }

  async function keyFor(
    workspaceId: string,
    { keyMode, provider }: { keyMode: "own" | "managed"; provider: string },
  ): Promise<LlmAccessResult> {
    // The model and the context window of the instance; the model of the job is the selection's, not this one.
    const defaults = readLlmDefaults(env());
    return resolveWorkspaceLlmAccess(
      keyMode === "managed"
        ? {
            keyMode,
            provider,
            operatorKey: await operatorKey().forJob(provider),
            defaults,
          }
        : {
            keyMode,
            provider,
            key: await keyServiceFor(workspaceId).keyFor(provider),
            defaults,
          },
      keyMode === "own" ? ownProviders : providers,
    );
  }

  return {
    keyServiceFor,
    claudeCodeTokenFor,
    operatorKey,
    accessFor,
    keyFor,
    async summaryFor(workspaceId, provider) {
      return summarizeLlmAccess(await accessFor(workspaceId, provider));
    },
    async currentKeysFor(workspaceId) {
      const keys: string[] = [];
      const service = keyServiceFor(workspaceId);
      for (const id of providers.ids) {
        const own = await service.keyFor(id);
        if (own.state === "key") keys.push(own.apiKey);
      }
      // The Claude Code token (#1150) is a secret of the workspace like its keys: it never appears in a result.
      const claude = await claudeCodeTokenFor(workspaceId).tokenForJob();
      if (claude.state === "token") keys.push(claude.token);
      // The keys of the catalog providers (#555) are masked in a result as well.
      for (const { provider } of await service.nativeStatuses()) {
        const own = await service.keyFor(provider);
        if (own.state === "key") keys.push(own.apiKey);
      }
      // While billing is on the workspace can change its key mode at any moment, and a review that started on our key is not
      // stopped by it (#496): its result must still be masked with the operator's key. The switch is read once; the key mode of
      // the entitlements only matters while it is off.
      const billing = { on: await isBillingOn(db) };
      if (
        !billing.on &&
        keyModeForJob(
          await readEffectiveEntitlements(db, workspaceId, now, billing),
        ) !== "managed"
      )
        return keys;
      const operators = operatorKey();
      for (const id of providers.ids) {
        const operator = await operators.forJob(id);
        if (operator.state === "key") keys.push(operator.apiKey);
      }
      return keys;
    },
  };
}
