// SPDX-License-Identifier: LicenseRef-Proprietary

// #423-T06: adding a provider means adding an adapter. The one real provider is named only inside its own
// adapter folder; every other source file reads it from the registry. The scan reads the real source files,
// so a new mention in application code fails here and in `make verify`.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { listSourceFiles } from "../../ci/spdx-headers/source-files.ts";

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));

/**
 * Each real provider: the word that names it, its adapter folder (the only place that may know it) and the files
 * that may name it although they are not the adapter, each with the reason. Keep the lists short: a mention that is
 * only a convenience belongs behind the registry (`label`, `defaultProvider`).
 */
const PROVIDERS = [
  {
    name: "openrouter",
    pattern: /openrouter/i,
    folders: ["app/src/llm/providers/openrouter/"],
    allowed: {
      "app/src/llm/providers/index.ts":
        "the registry lists its adapters (descriptors, client-safe)",
      "app/src/llm/providers/server.ts":
        "the registry lists its adapters (with their network calls, server only)",
      "app/src/contracts/runner-api.ts":
        "generated from the runner API contract, whose `KnownLlmProvider` lists the slugs of this release and whose text says what an absent `llmProviders` means (#424)",
      "app/src/contracts/worker-api.ts":
        "generated from the Worker API contract, whose text says what an absent `llmProviders` means (#424)",
      "app/src/runner-api/contract.ts":
        "the wire default of a caller that advertised no providers: what a previous-release runner can run (`DEFAULT_LLM_PROVIDERS`, #424)",
      "app/src/copy/member-copy-scan.ts":
        "the list of vendor words that copy for a member must never say, the provider's name among them",
      "app/src/model-catalog/provider-label.ts":
        "the display name of the maker `openrouter/...` model ids start with (`openrouter/auto`), which a member reads as the provider of a catalog entry (#675)",
      "app/src/review-settings/runner-settings.ts":
        "a comment that names PR-Agent's own key variable (the runner side of the provider, the next issue)",
      "app/src/ci/opencode-providers/derive.ts":
        "the table of the SDKs the pinned engine bundles, by package name (`@openrouter/ai-sdk-provider`), from which the supported-provider file is derived (#548)",
      "app/src/models-dev/wire.ts":
        "the list of the SDKs the pinned engine bundles (`BUNDLED_NPM`), by package name (`@openrouter/ai-sdk-provider`): an allow-list for the job entry (#548)",
    } as Readonly<Record<string, string>>,
  },
  {
    // #511-T08: the word also names the vendor of the models an OpenRouter id starts with, so both adapter
    // folders are exempt; outside them it may only be the registry and the lists of known words.
    name: "anthropic",
    pattern: /anthropic/i,
    folders: [
      "app/src/llm/providers/anthropic/",
      "app/src/llm/providers/openrouter/",
    ],
    allowed: {
      "app/src/llm/providers/index.ts":
        "the registry lists its adapters (descriptors, client-safe)",
      "app/src/llm/providers/server.ts":
        "the registry lists its adapters (with their network calls, server only)",
      "app/src/contracts/runner-api.ts":
        "generated from the runner API contract, whose `KnownLlmProvider` lists the slugs of this release (#424)",
      "app/src/copy/member-copy-scan.ts":
        "the list of vendor words that copy for a member must never say, the provider's name among them",
      "app/src/model-catalog/provider-label.ts":
        "the display names of the makers a model id can start with, which a member reads as the provider of a catalog entry (#675)",
      "app/src/ci/opencode-providers/derive.ts":
        "the table of the SDKs the pinned engine bundles and the address each one defaults to, by package name (#548)",
      "app/src/models-dev/wire.ts":
        "`anthropic-messages`, the name of a wire family (the Messages API format), which other providers speak too (#548)",
      "app/src/models-dev/generic-adapter.ts":
        "the `anthropic-version` header that the Messages wire family carries, for any provider that speaks it (#548)",
      "app/src/runner-api/claim.ts":
        "the API host Claude Code talks to, named as the model host of a hosted turn on the harness `claude-code`, which the Dispatcher signs into the VM's network policy (#1150): no key goes to it and it is no LLM provider of the registry",
    } as Readonly<Record<string, string>>,
  },
] as const;

function isApplicationSource(
  path: string,
  folders: readonly string[],
): boolean {
  if (!path.startsWith("app/src/")) return false;
  if (/\.test\.tsx?$/.test(path)) return false;
  if (path.startsWith("app/src/test-support/")) return false;
  // A migration is history: it must keep describing what was true when it ran.
  if (path.startsWith("app/src/db/migrations/")) return false;
  return !folders.some((folder) => path.startsWith(folder));
}

describe.each(PROVIDERS)(
  "the provider $name is named only inside its adapter",
  (provider) => {
    const files = listSourceFiles(repoRoot)
      .filter((path) => isApplicationSource(path, provider.folders))
      .map((path) => ({
        path,
        mentions: provider.pattern.test(
          readFileSync(`${repoRoot}${path}`, "utf8"),
        ),
      }));

    // #423-T06
    it("keeps the name out of every source file outside the adapter, except the listed ones", () => {
      const offenders = files
        .filter((file) => file.mentions && !(file.path in provider.allowed))
        .map((file) => file.path);
      expect(offenders).toEqual([]);
    });

    // #423-T06
    it("lists no exception that no longer needs one", () => {
      const stale = Object.keys(provider.allowed).filter(
        (path) => !files.some((file) => file.path === path && file.mentions),
      );
      expect(stale).toEqual([]);
    });
  },
);
