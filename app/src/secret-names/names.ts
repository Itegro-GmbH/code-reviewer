// SPDX-License-Identifier: LicenseRef-Proprietary

// The names of the secrets that code-review.com keeps (#715, cut 8), declared by the application and handed to the secret
// store where the application composes it (`src/secrets/` knows no name). The name is the row id of the `secrets` table and is
// bound into the ciphertext, so these never change: a stored secret would stop decrypting. A feature that stores a new
// credential adds its name here. The operator's LLM key of each provider is named by the provider's adapter
// (`src/llm/providers/`). The secrets of a workspace, such as its LLM key, are not here: they are stored with the workspace.
// This module imports nothing, so any module may import it.

/** The credentials of the GitHub App (`src/github-config/`): the OAuth client secret, the private key, the webhook secret. */
export const GITHUB_APP_SECRET_NAMES = [
  "github_app_client_secret",
  "github_app_private_key",
  "github_app_webhook_secret",
] as const;
export type GithubAppSecretName = (typeof GITHUB_APP_SECRET_NAMES)[number];

/** The password of the mail server (`src/mail/`). */
export const SMTP_SECRET_NAMES = ["smtp_password"] as const;
export type SmtpSecretName = (typeof SMTP_SECRET_NAMES)[number];

/**
 * The Stripe credentials of the billing module (ADR 0006, 2.14; #500): the API key and the signing secret of the webhook
 * endpoint. Encrypted and write-only like the others; the admin form that sets them is #504.
 */
export const STRIPE_SECRET_NAMES = [
  "stripe_api_key",
  "stripe_webhook_secret",
] as const;
export type StripeSecretName = (typeof STRIPE_SECRET_NAMES)[number];

/** Every secret that does not belong to an LLM provider. */
export const FIXED_SECRET_NAMES = [
  ...GITHUB_APP_SECRET_NAMES,
  ...SMTP_SECRET_NAMES,
  ...STRIPE_SECRET_NAMES,
] as const;
export type FixedSecretName = (typeof FIXED_SECRET_NAMES)[number];

/**
 * The slot of the Claude Code OAuth token in the encrypted store of a workspace (#1150): one row of `workspace_secrets` per workspace, named
 * like the LLM keys of a workspace (`llm_api_key…`) are, and not a provider's. The name never changes (the ciphertext is bound to it). Here so
 * that the routing rule of the database can ask whether a workspace holds one without importing the LLM module.
 */
export const CLAUDE_CODE_TOKEN_SECRET_NAME = "claude_code_oauth_token";
