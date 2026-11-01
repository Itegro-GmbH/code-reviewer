// SPDX-License-Identifier: LicenseRef-Proprietary

// The structure test of workspace scoping (docs/decisions/0001-editions-setup-and-accounts.md,
// section 2.7: "a test fails when a repository function takes no workspace"). It reads the source of
// every repository module:
//
// - each module must be classified here, as scoped or as instance level, so a new repository cannot
//   slip in unnoticed, and a classification of a module that is gone fails too;
// - in a scoped module, every exported function that is handed a database connection must take the
//   `workspaceId` too, and the module must have at least one such function (so the check cannot pass
//   because it found nothing).
//
// What the test proves is the signature. That the queries behind it really filter by the workspace
// is proven by scoped-isolation.integration.test.ts.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/** Repositories of customer data: created for one workspace, every query filters by it. */
const SCOPED = [
  "app-settings-repository.ts",
  "billing-journal-repository.ts",
  "billing-notifications-repository.ts",
  "billing-profiles-repository.ts",
  "billing-topup-intents-repository.ts",
  "billing-workspace-settings-repository.ts",
  "installation-link-requests-repository.ts",
  "implementer-repository.ts",
  "integrations-repository.ts",
  "invitations-repository.ts",
  "job-check-runs-repository.ts",
  "job-vm-runs-repository.ts",
  "jobs-repository.ts",
  "plan-handoff-tokens-repository.ts",
  "projects-repository.ts",
  "refusal-notices-repository.ts",
  "repositories-repository.ts",
  "runs-repository.ts",
  "usage-records-repository.ts",
  "workspace-entitlements-repository.ts",
  "workspace-erasure-repository.ts",
  "workspace-members-repository.ts",
  "workspace-secrets-repository.ts",
] as const;

/**
 * Not scoped, each for a reason that has to hold:
 * - the tables are not customer data (app_meta, allowed_login_pins, webhook_deliveries, workspaces,
 *   instance_settings, rate_limits, secrets, setup_codes);
 * - integration-directory: webhooks and the synchronization find a connection before the workspace is
 *   known; it only reads and the answer names the workspace;
 * - invitation-directory: a person who opens an invitation link holds only the token, and the list of the
 *   invitations that wait for an address spans workspaces; it only reads and every answer names the
 *   workspace, and whatever is done next goes through the scoped invitations repository;
 * - installation-link-request-directory: the instance admin decides the requests of every workspace to link
 *   an installation; it reads with the workspace and requester names, and its one write is the decision
 *   (a guarded statement on a request that still waits). Asking, refreshing and withdrawing go through the
 *   scoped installation-link-requests repository;
 * - unclaimed-installations: installations that no workspace has linked belong to no workspace by definition;
 * - runner-jobs: runners serve the whole instance, every statement is fenced by the lease token;
 * - jobs-claim: the one SQL statement of the runner side, not a repository;
 * - legacy-users: the import of an existing installation (src/legacy-import/) reads the users of the earlier
 *   sign in with their GitHub identity and marks them as imported; users belong to no workspace;
 * - usage-feed: the settled usage records of every workspace for the operator API (#278) and the count of runs that
 *   settled without a cost per workspace and key mode (#385), which serve the whole instance from one token; it only
 *   reads, takes the optional bound of the safety lag, and every item and count names its workspace. The reads of one workspace (its page and its summary) go through the scoped usage records repository;
 * - usage-records-sweep: the sweep of usage records for instance level code that ends jobs of any workspace (the
 *   lease side of the queue, the switch-off of Dynamic Review); one statement that only voids `reserved` records of
 *   jobs that have ended, and it takes no workspace on purpose;
 * - claim-admission: the check of the entitlements of a claimed job (#277), made inside the claim transaction of
 *   the lease side of the queue for whichever workspace the job is in; it reads, and everything it reads goes
 *   through repositories created for that job's workspace (the instance default and the workspace row it locks
 *   are not customer data);
 * - refusal-notices-sweep: the notices of refused reviews that are due to be posted again (#281), for the cron sweep that
 *   serves the whole instance; it only reads the rows that wait for a retry, and every answer names its workspace. The
 *   record itself goes through the scoped refusal notices repository;
 * - job-check-runs-sweep: the jobs whose check run on GitHub is behind (#405), for the reconciler that serves the whole
 *   instance (the sweep, the timer and the requests that touch the database); it only reads the rows that are due and
 *   the waiting or running jobs without one, and every answer names its workspace. The record itself goes through
 *   the scoped job check runs repository;
 * - job-dispatches: where the signed wake-up call of a job stands (#326). The sender holds the job it just queued and
 *   the sweep works through the whole instance, like the lease side of the queue; the table has a job id and
 *   counters, no repository data, and is only written in webhook mode;
 * - plan-handoff-redeem: the redemption of a handoff token by the external plan page (#284, operator API). The caller
 *   holds only the token, so there is no workspace to scope to before the token is looked up by its hash; it never
 *   lists, the answer names its own workspace, and the one statement that uses a token up and the check of the member's
 *   role both run on the workspace the token was made for. Making a token goes through the scoped plan handoff tokens
 *   repository; the clean-up deletes expired rows of every workspace and reads nothing;
 * - own-key-count: how many workspaces hold a stored own LLM key (#504), for the instance admin who is about to switch billing
 *   on; it counts across workspaces, takes no argument, and returns one number, no row and no name;
 * - job-claimed-keys: the encrypted LLM key handed out with the claim of a job. It is keyed by the job and read
 *   only by the runner API when that job is completed (the job and its workspace are known there); it never
 *   lists, and a key is only ever looked up by the id of a job the caller holds;
 * - catalog: the operator's list of the models managed workspaces may use (#425, ADR 0005, 2.6). It is instance
 *   configuration, not customer data, and no workspace owns an entry. Its one read across workspaces is a count of
 *   how many projects select an entry (for the operator's confirmation when the model behind it changes); it
 *   returns a number, never a row, a project or a workspace.
 * - job-directory: the jobs of every workspace for the instance admin's job view (#541). The operator looks at a run
 *   by its id without being a member of its workspace, to see what a run did. It only reads (a page of the newest
 *   jobs without their results, and one job by its id), and every answer names its workspace; the only callers are
 *   the pages of the admin portal behind the admin guard. What a member sees of a run goes through the scoped
 *   runs repository;
 * - models-dev: the providers and models read from models.dev (#548) and the state of the last fetch. It is the catalog
 *   of the installation, fetched at run time from a public source: not customer data, and no workspace owns a row. It
 *   stores and reads whole rows (no query takes a workspace or returns one) and never deletes;
 * - billing-topup-intent-directory: finds a top-up intent from what a provider event names (#497), before the workspace
 *   is known; it only reads, an intent is found only for the adapter that created it, and every answer names its
 *   workspace, which is where everything that follows goes (the scoped intents repository and the journal of that
 *   workspace);
 * - billing-holds-sweep: the reservations of ended jobs that nobody released (#591), for the sweep and the switch-on that
 *   serve the whole instance; it only reads, driven by the workspaces that have something reserved, and every answer names
 *   its workspace, which is where the release goes (the journal repository of that workspace);
 * - billing-journal-directory: the ids of the workspaces that have a billing journal, page by page (#626), for the scheduled check
 *   of the journal that serves the whole instance; it only reads and returns workspace ids and nothing else, and the check of
 *   each one goes through the journal repository of that workspace;
 * - billing-start-credit-grants: which GitHub accounts were granted the start credit (#507). The credit is tied to the
 *   account of an installation, which no workspace owns, so it is asked across workspaces and the row outlives the
 *   workspace. A numeric account id, a workspace id and a time; no name, login or address, so it is not customer data;
 * - billing-notification-directory: the mails of balance crossings that are due (#506), for the one process that sends them
 *   after a response. It is told that something is due and not for which workspace; it claims due rows (one guarded statement
 *   for each, which only one of several senders can win) and records how a delivery ended, and every answer names its
 *   workspace, which is where the sender looks up the recipients. The rows are made and changed through the scoped
 *   billing notifications repository, in the transaction that moved the balance;
 * - billing-webhook-events: the record of provider events by `(provider, event id)` (#497): an id, an outcome and the
 *   order of the states of a refund or dispute, and for an event under review the ids of our own top-up and workspace it belongs to and
 *   what an operator recorded when closing it (#603: their id, time and note, and the journal entry). No payload, no amount and no
 *   buyer, so it is not customer data;
 * - instance-settings-store: the generic key/value access to `instance_settings` (#715, cut 2), which the repository of the
 *   whole instance and the domains that own a key (billing, the setup wizard) build on. Instance level like the repository,
 *   and it knows no setting;
 * - instance-setting-types: the shapes of two instance settings (tenancy, the sign-up rule), no function, no query.
 */
const INSTANCE_LEVEL = [
  "allowed-login-pins-repository.ts",
  "app-meta-repository.ts",
  "billing-holds-sweep.ts",
  "billing-journal-directory-repository.ts",
  "billing-notification-directory-repository.ts",
  "billing-start-credit-grants-repository.ts",
  "billing-topup-intent-directory-repository.ts",
  "billing-webhook-events-repository.ts",
  "catalog-repository.ts",
  "claim-admission.ts",
  "implementer-sessions-sweep.ts",
  "installation-link-request-directory-repository.ts",
  "instance-setting-types.ts",
  "instance-settings-repository.ts",
  "instance-settings-store.ts",
  "integration-directory-repository.ts",
  "invitation-directory-repository.ts",
  "job-check-runs-sweep.ts",
  "job-claimed-keys-repository.ts",
  "job-directory-repository.ts",
  "job-dispatches-repository.ts",
  "jobs-claim.ts",
  "legacy-users-repository.ts",
  "model-enablements-repository.ts",
  "model-price-confirmations-repository.ts",
  "models-dev-repository.ts",
  "own-key-count-repository.ts",
  "plan-handoff-redeem-repository.ts",
  "rate-limits-repository.ts",
  "refusal-notices-sweep.ts",
  "runner-jobs-repository.ts",
  "secrets-repository.ts",
  "setup-codes-repository.ts",
  "unclaimed-installations-repository.ts",
  "usage-feed-repository.ts",
  "usage-records-sweep.ts",
  "webhook-deliveries-repository.ts",
  "workspaces-repository.ts",
] as const;

const DIRECTORY = import.meta.dirname;

function sourceFiles(): string[] {
  return readdirSync(DIRECTORY)
    .filter((name) => name.endsWith(".ts") && !name.includes(".test."))
    .sort();
}

type ExportedFunction = {
  name: string;
  parameters: Array<{ name: string; type: string }>;
};

/** The exported functions of a module: declarations and `export const x = (...) =>`. */
function exportedFunctions(file: string): ExportedFunction[] {
  const text = readFileSync(join(DIRECTORY, file), "utf8");
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const found: ExportedFunction[] = [];
  const isExported = (node: ts.Node) =>
    ts.canHaveModifiers(node) &&
    ts
      .getModifiers(node)
      ?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ===
      true;
  const describe = (name: string, fn: ts.SignatureDeclarationBase) =>
    found.push({
      name,
      parameters: fn.parameters.map((parameter) => ({
        name: parameter.name.getText(source),
        type: parameter.type?.getText(source) ?? "",
      })),
    });

  for (const statement of source.statements) {
    if (!isExported(statement)) continue;
    if (ts.isFunctionDeclaration(statement) && statement.name !== undefined)
      describe(statement.name.text, statement);
    if (ts.isVariableStatement(statement))
      for (const declaration of statement.declarationList.declarations) {
        const init = declaration.initializer;
        if (
          init !== undefined &&
          (ts.isArrowFunction(init) || ts.isFunctionExpression(init))
        )
          describe(declaration.name.getText(source), init);
      }
  }
  return found;
}

/** An exported function that is handed a database connection (or a transaction). */
function touchesTheDatabase(fn: ExportedFunction): boolean {
  return fn.parameters.some((parameter) => parameter.type.includes("Kysely"));
}

describe("the repositories and workspace scoping", () => {
  // DM-08
  it("classifies every repository module as scoped or instance level, and nothing else", () => {
    const classified = [...SCOPED, ...INSTANCE_LEVEL].sort();

    expect(sourceFiles()).toEqual(classified);
    expect(new Set(classified).size).toBe(classified.length);
  });

  // DM-08
  it.each(SCOPED)(
    "has a factory in %s and every exported function that takes a connection also takes the workspace",
    (file) => {
      const databaseFunctions =
        exportedFunctions(file).filter(touchesTheDatabase);
      expect(
        databaseFunctions.length,
        `${file} exports no function that takes a database connection`,
      ).toBeGreaterThan(0);

      for (const fn of databaseFunctions) {
        const workspace = fn.parameters.find(
          (parameter) => parameter.name === "workspaceId",
        );
        expect(
          workspace,
          `${file}: ${fn.name} takes a database connection but no workspaceId`,
        ).toBeDefined();
        expect(workspace?.type, `${file}: ${fn.name}`).toBe("WorkspaceId");
      }
    },
  );

  // DM-08
  it("recognises a function without a workspace (the check can fail)", () => {
    const withoutWorkspace: ExportedFunction = {
      name: "createLeakyRepository",
      parameters: [
        { name: "db", type: "Kysely<Database>" },
        { name: "now", type: "() => Date" },
      ],
    };

    expect(touchesTheDatabase(withoutWorkspace)).toBe(true);
    expect(
      withoutWorkspace.parameters.some((p) => p.name === "workspaceId"),
    ).toBe(false);
  });

  // #425-T11
  it("classifies the model catalog repository as instance level, with an exported factory that takes no workspace", () => {
    expect(INSTANCE_LEVEL).toContain("catalog-repository.ts");
    expect(SCOPED).not.toContain("catalog-repository.ts");
    const factories = exportedFunctions("catalog-repository.ts").filter(
      touchesTheDatabase,
    );
    expect(factories.map((fn) => fn.name)).toEqual(["createCatalogRepository"]);
  });

  // #548-T12
  it("classifies the models.dev catalog repository as instance level, with an exported factory that takes no workspace", () => {
    expect(INSTANCE_LEVEL).toContain("models-dev-repository.ts");
    expect(SCOPED).not.toContain("models-dev-repository.ts");
    const factories = exportedFunctions("models-dev-repository.ts").filter(
      touchesTheDatabase,
    );
    expect(factories.map((fn) => fn.name)).toEqual([
      "createModelsDevRepository",
    ]);
  });

  // #549-T12
  it("classifies the model enablement and price confirmation repositories as instance level, with an exported factory that takes no workspace", () => {
    for (const [file, factory] of [
      ["model-enablements-repository.ts", "createModelEnablementsRepository"],
      [
        "model-price-confirmations-repository.ts",
        "createModelPriceConfirmationsRepository",
      ],
    ] as const) {
      expect(INSTANCE_LEVEL).toContain(file);
      expect(SCOPED).not.toContain(file);
      const factories = exportedFunctions(file).filter(touchesTheDatabase);
      expect(factories.map((fn) => fn.name)).toEqual([factory]);
    }
  });

  it("keeps the instance level modules from taking a workspace, so the two groups stay apart", () => {
    for (const file of INSTANCE_LEVEL)
      for (const fn of exportedFunctions(file))
        expect(
          fn.parameters.map((parameter) => parameter.name),
          `${file}: ${fn.name}`,
        ).not.toContain("workspaceId");
  });
});
