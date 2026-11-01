// SPDX-License-Identifier: LicenseRef-Proprietary

// The keys and write tokens remembered for jobs on the running server, and the write-token service built on them (#753, #790).
// Kept apart from `shared.ts` so that the queue's hook for ended claims and the maintenance can use them without importing the
// whole runner API.
import "server-only";
import { resolveAppSecret } from "../crypto/app-secret.ts";
import { createIntegrationsRepository } from "../db/repositories/integrations-repository.ts";
import { createJobClaimedKeysRepository } from "../db/repositories/job-claimed-keys-repository.ts";
import { createRepositoriesRepository } from "../db/repositories/repositories-repository.ts";
import { getDatabase } from "../db/startup.ts";
import { integrationRegistry } from "../integrations/registry.ts";
import { createClaimedKeys, type ClaimedKeys } from "./claimed-keys.ts";
import { consoleRunnerApiLogger } from "./logger.ts";
import { createWriteTokens, type WriteTokens } from "./write-token.ts";

// The key each job was handed lives in the database (encrypted), so any app instance can mask a result.
export function getClaimedKeys(): ClaimedKeys {
  return createClaimedKeys({
    db: getDatabase(),
    appSecret: () => {
      const resolved = resolveAppSecret(process.env);
      // The server does not start without it (src/auth/startup.ts); this is the second line.
      if (!resolved.ok) throw new Error(resolved.problem);
      return resolved.secret;
    },
  });
}

/** The write tokens of the Implementer's turns: switching them off when a turn ends, and trying again for the ones that failed. */
export function getWriteTokens(): WriteTokens {
  const db = getDatabase();
  return createWriteTokens({
    repositories: (workspaceId) =>
      createRepositoriesRepository(db, workspaceId),
    integrations: (workspaceId) =>
      createIntegrationsRepository(db, workspaceId),
    registry: integrationRegistry,
    claimedKeys: getClaimedKeys(),
    rows: createJobClaimedKeysRepository(db),
    logger: consoleRunnerApiLogger,
    now: () => new Date(),
  });
}
