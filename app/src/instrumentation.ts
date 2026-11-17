// SPDX-License-Identifier: LicenseRef-Proprietary

// Runs once when a Next.js instance starts, before it accepts requests. The app runs as serverless
// functions (Vercel): every cold start of every instance runs this, so it only CHECKS settings and
// reports. It opens no database and starts no timer. What a long-lived server would do at start is not
// done here on purpose:
//
// - migrations: `pnpm migrate` (src/db/migrate-cli.ts), run at deployment time; the app reports a
//   database that is behind on /api/health (src/health/health.ts) and never changes the schema;
// - the setup code: the operator makes it with `pnpm setup-code` (src/setup/setup-code-cli.ts) and the
//   instances check it in the database (src/setup/database-code-store.ts, #321);
// - the sync with GitHub, the cleanup, the check run reconciler and the models.dev fetch: an instance lives
//   for seconds, so a timer would never fire. The sync runs from a daily cron and from the webhooks
//   (src/app/api/internal/repository-sync), the rest from the sweep (src/dispatch/sweep.ts, #328).
//
// A bad setting aborts the start by throwing, never by `process.exit`: on a serverless platform that
// would end the function instead of failing one start.
import { DatabaseError } from "./db/errors.ts";

/** Stands for `process.exit` in the checks shared with other starts; they log first, then call it. */
function abortStart(code: number): never {
  throw new Error(
    `The start was aborted by a configuration check (it would have exited with code ${String(code)} on a server); the line above says what to fix.`,
  );
}

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { checkAuthConfigOnStart } = await import("./auth/startup.ts");
  checkAuthConfigOnStart({ exit: abortStart });
  const { checkDeploymentConfigOnStart } = await import("./deploy/startup.ts");
  await checkDeploymentConfigOnStart({ exit: abortStart });
  const { checkLlmConfigOnStart } = await import("./llm/startup.ts");
  checkLlmConfigOnStart();
  // Only the settings are read: the pool opens with the first request (`getDatabase()`).
  const { loadDatabaseConfig } = await import("./db/config.ts");
  try {
    loadDatabaseConfig(process.env);
  } catch (error) {
    if (error instanceof DatabaseError)
      console.error(`[database] ${error.code}: ${error.message}`);
    throw error;
  }
  const { warnAboutRunnerToken } = await import("./runner-api/startup.ts");
  warnAboutRunnerToken(process.env);
  const { logOperatorApiState } = await import("./operator-api/startup.ts");
  logOperatorApiState(process.env);
  const { jiraStateLine } = await import("./jira/config.ts");
  console.info(jiraStateLine(process.env));
  // The ticket actions of the workflow engine reach Jira from every entry point of the process (#1040); the engine's modules may not import
  // `jira` (an import cycle), so the provider is registered once here. It opens nothing: the connection is looked up with each call.
  const { registerTicketProvider } =
    await import("./integrations/ticket-provider.ts");
  const { jiraMirrorSyncFor, jiraTicketProvider } =
    await import("./jira/shared.ts");
  registerTicketProvider(jiraTicketProvider);
  // The same for the full read of a Jira project into the ticket mirror (the first read, the nightly resync and the button).
  const { registerJiraMirrorSync } =
    await import("./tracker/jira-mirror-sync.ts");
  registerJiraMirrorSync(jiraMirrorSyncFor);
  const { warnAboutDebounce } = await import("./webhooks/debounce-config.ts");
  warnAboutDebounce(process.env);
}
