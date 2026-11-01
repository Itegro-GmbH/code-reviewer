// SPDX-License-Identifier: LicenseRef-Proprietary

// What the production server checks about the deployment when it starts, besides sign in (see
// src/auth/startup.ts, which requires the master key and the public address): the shared token of the
// runner, that the operator API token (when set) is not a copy of another credential, and, in webhook
// dispatch mode, the URL and the signing secret of the dispatch webhook (src/dispatch/config.ts). A missing value would otherwise show up later as a failing runner with a less helpful
// message. The capability set of the deployment (`PRODUCT_CAPABILITIES`, src/capabilities/) is checked here too. Called from `src/instrumentation.ts`.
//
// The GitHub App is not an environment setting any more: it is entered in the admin portal, and the variables of
// an installation from before accounts are imported once (src/legacy-import/), which also says which of them
// could not be used. An instance starts without any `GITHUB_*` variable; GitHub is then "not configured" (the
// pages say so) until the integration is set up.

import { capabilityConfigProblems } from "../capabilities/products.ts";
import { dispatchConfigProblems } from "../dispatch/config.ts";
import { operatorTokenReuseProblem } from "../operator-api/token.ts";
import { runnerTokenProblem } from "../runner-api/token-auth.ts";

export const DEPLOY_ERROR_CODES = ["DEPLOY_CONFIG_INVALID"] as const;
export type DeployErrorCode = (typeof DEPLOY_ERROR_CODES)[number];

type Env = Readonly<Record<string, string | undefined>>;

type StartOptions = {
  env?: Env;
  log?: (message: string) => void;
  warn?: (message: string) => void;
  exit?: (code: number) => void;
  /** `NEXT_PUBLIC_PRODUCT_ID` as the build inlined it; a parameter because only the literal expression below is replaced. */
  builtProductId?: string;
};

/**
 * `next.config.ts` inlines `PRODUCT_ID` of the build as `NEXT_PUBLIC_PRODUCT_ID` (read by the page for a crash in the root
 * layout, #740). The server reads `PRODUCT_ID` when it runs, so a project whose variable changed after the build, or a value
 * the build did not see, shows another product in that one page. Names the variables only, never a value.
 */
export function productIdBuildProblem(
  env: Env,
  builtProductId: string | undefined,
): string | null {
  const running = env.PRODUCT_ID?.trim() ?? "";
  const built = builtProductId?.trim() ?? "";
  if (running === built) return null;
  return "NEXT_PUBLIC_PRODUCT_ID (set from PRODUCT_ID by the build) differs from PRODUCT_ID of the running server: redeploy so the page for a crash in the root layout shows the right product";
}

/** The problems of the deployment settings, each naming only the variables concerned. */
export function findDeploymentConfigProblems(env: Env): string[] {
  const problems: string[] = [];

  // The token is judged by the runner API's own rule, the one that also logs the start-up warning.
  const tokenProblem = runnerTokenProblem(env);
  if (tokenProblem !== null) problems.push(`RUNNER_TOKEN ${tokenProblem}`);

  // The operator API is optional (#275). Only a token that is the same as another credential stops the start; a
  // weak one keeps the API off and is reported by operator-api/startup.ts.
  const reuseProblem = operatorTokenReuseProblem(env);
  if (reuseProblem !== null)
    problems.push(`OPERATOR_API_TOKEN ${reuseProblem}`);

  // The dispatch webhook (#326) is off by default. Only a webhook mode with an incomplete setup stops the
  // start: the app would queue jobs and never wake anyone. The problems name variables, never values.
  problems.push(...dispatchConfigProblems(env));

  // The product and its capability set (#731, `implementer` #747); unset means today's code-review.com, so this adds no required variable.
  problems.push(...capabilityConfigProblems(env));

  return problems;
}

/**
 * In production, an incomplete deployment configuration (the runner token) ends the process with
 * exit code 1 and one readable line (the error code and the variable names), not a stack trace. Other
 * environments (the dev server) are not checked.
 */
export async function checkDeploymentConfigOnStart({
  env = process.env,
  log = console.error,
  warn = console.warn,
  exit = (code) => process.exit(code),
  builtProductId = process.env.NEXT_PUBLIC_PRODUCT_ID,
}: StartOptions = {}): Promise<void> {
  if (env.NODE_ENV !== "production") return;
  const buildProblem = productIdBuildProblem(env, builtProductId);
  if (buildProblem !== null) warn(`[deploy] ${buildProblem}.`);
  const problems = findDeploymentConfigProblems(env);
  if (problems.length > 0) {
    log(
      `[deploy] ${DEPLOY_ERROR_CODES[0]}: The deployment configuration is incomplete or invalid: ${problems.join("; ")}.`,
    );
    exit(1);
    return;
  }
}
