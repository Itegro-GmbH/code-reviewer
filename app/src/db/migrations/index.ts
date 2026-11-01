// SPDX-License-Identifier: LicenseRef-Proprietary

// The ordered list of migrations. Kysely runs them in the alphabetical order of these keys, so
// every key after the first starts with a UTC timestamp, `YYYYMMDDHHMMSS_what_it_does`; "0001" sorts
// before all of them. A migration that has run is never edited: add a new one instead. Registered
// statically (not read from the disk) so it works in a Next.js bundle.
import type { Migration, MigrationProvider } from "kysely/migration";
import { migration as createAppMeta } from "./0001_create_app_meta.ts";
import { migration as createAuthTables } from "./20261010123800_create_auth_tables.ts";
import { migration as addUserOrgCheckedAt } from "./20261010125500_add_user_org_checked_at.ts";
import { migration as addUserOrgCheckedFor } from "./20261010131500_add_user_org_checked_for.ts";
import { migration as createAllowedLoginPins } from "./20261010133000_create_allowed_login_pins.ts";
import { migration as createIntegrations } from "./20261010134000_create_integrations.ts";
import { migration as createRepositories } from "./20261010143000_create_repositories.ts";
import { migration as createWebhookDeliveries } from "./20261010170000_create_webhook_deliveries.ts";
import { migration as createProjects } from "./20261010190000_create_projects.ts";
import { migration as createJobs } from "./20261010191500_create_jobs.ts";
import { migration as createAppSettings } from "./20261010201500_create_app_settings.ts";
import { migration as createJobComments } from "./20261011090000_create_job_comments.ts";
import { migration as addJobsRepositoryRecentIndex } from "./20261011100000_add_jobs_repository_recent_index.ts";
import { migration as createWorkspaces } from "./20261011160000_create_workspaces.ts";
import { migration as addWorkspaceToCustomerData } from "./20261011160100_add_workspace_to_customer_data.ts";
import { migration as prepareUsersForAccounts } from "./20261011160200_prepare_users_for_accounts.ts";
import { migration as createInstanceSettings } from "./20261011170000_create_instance_settings.ts";
import { migration as createRateLimits } from "./20261011170100_create_rate_limits.ts";
import { migration as addInstanceAdminFlagToUsers } from "./20261011170200_add_instance_admin_flag_to_users.ts";
import { migration as createSecrets } from "./20261011200000_create_secrets.ts";
import { migration as createPasswordResetTokens } from "./20261011200100_create_password_reset_tokens.ts";
import { migration as createEmailVerificationTokens } from "./20261011210000_create_email_verification_tokens.ts";
import { migration as createInvitations } from "./20261012100000_create_invitations.ts";
import { migration as createSignedStates } from "./20261012120000_create_signed_states.ts";
import { migration as addUsersEmailConflict } from "./20261012120100_add_users_email_conflict.ts";
import { migration as uniqueAccounts } from "./20261012120200_unique_accounts.ts";
import { migration as createWorkspaceSecrets } from "./20261012140000_create_workspace_secrets.ts";
import { migration as createJobClaimedKeys } from "./20261012140100_create_job_claimed_keys.ts";
import { migration as createInstallationBinding } from "./20261012150000_create_installation_binding.ts";
import { migration as removeCommands } from "./20261012160000_remove_commands.ts";
import { migration as addJobReviewKind } from "./20261013090000_add_job_review_kind.ts";
import { migration as fixDynamicDefaultModel } from "./20261014090000_fix_dynamic_default_model.ts";
import { migration as createWorkspaceEntitlements } from "./20261014120000_create_workspace_entitlements.ts";
import { migration as createUsageRecords } from "./20261014150000_create_usage_records.ts";
import { migration as createJobCheckRuns } from "./20261017100000_create_job_check_runs.ts";
import { migration as addJobAcceptsSupersede } from "./20261016140000_add_job_accepts_supersede.ts";
import { migration as widenUsageRecordSettledReason } from "./20261016140100_widen_usage_record_settled_reason.ts";
import { migration as addJobWorkerFetches } from "./20261015100000_add_job_worker_fetches.ts";
import { migration as createSetupCodes } from "./20261015110000_create_setup_codes.ts";
import { migration as createJobDispatches } from "./20261015120000_create_job_dispatches.ts";
import { migration as addUsageRecordSettledReason } from "./20261015200000_add_usage_record_settled_reason.ts";
import { migration as createRefusalNotices } from "./20261016090000_create_refusal_notices.ts";
import { migration as createPlanHandoffTokens } from "./20261016120000_create_plan_handoff_tokens.ts";
import { migration as createModelCatalogEntries } from "./20261017140000_create_model_catalog_entries.ts";
import { migration as addWorkspaceEntitlementsModelAccess } from "./20261017160000_add_workspace_entitlements_model_access.ts";
import { migration as addUsageRecordCatalogEntry } from "./20261018090000_add_usage_record_catalog_entry.ts";
import { migration as migrateModelTiersToCatalog } from "./20261018170000_migrate_model_tiers_to_catalog.ts";
import { migration as createBillingJournal } from "./20261019150000_create_billing_journal.ts";
import { migration as createJobVmRuns } from "./20261019160000_create_job_vm_runs.ts";
import { migration as createBillingTopupIntents } from "./20261019170000_create_billing_topup_intents.ts";
import { migration as addJobsCreatedAtIndex } from "./20261019183000_add_jobs_created_at_index.ts";
import { migration as createModelsDevCatalog } from "./20261019200000_create_models_dev_catalog.ts";
import { migration as createModelDecisions } from "./20261020090000_create_model_decisions.ts";
import { migration as widenRefusalNoticeCodes } from "./20261021090000_widen_refusal_notice_codes.ts";
import { migration as addBillingBalancesReservedIndex } from "./20261021120000_add_billing_balances_reserved_index.ts";
import { migration as createBillingStartCreditGrants } from "./20261021150000_create_billing_start_credit_grants.ts";
import { migration as widenJobVmRunsEndSource } from "./20261021090100_widen_job_vm_runs_end_source.ts";
import { migration as createBillingProfiles } from "./20261021130000_create_billing_profiles.ts";
import { migration as addBillingTopupIntentsProviderAmount } from "./20261021170000_add_billing_topup_intents_provider_amount.ts";
import { migration as addBillingTopupIntentsProviderCurrency } from "./20261021190000_add_billing_topup_intents_provider_currency.ts";
import { migration as addBillingWebhookEventsReviewContext } from "./20261021190100_add_billing_webhook_events_review_context.ts";
import { migration as widenRefusalNoticeCodesForLimits } from "./20261021210000_widen_refusal_notice_codes_for_limits.ts";
import { migration as createBillingWorkspaceSettings } from "./20261021210100_create_billing_workspace_settings.ts";
import { migration as addLimitQueryIndexes } from "./20261021210200_add_limit_query_indexes.ts";
import { migration as addUsageRecordBillingState } from "./20261022010000_add_usage_record_billing_state.ts";
import { migration as addBillingWebhookEventsResolution } from "./20261022020000_add_billing_webhook_events_resolution.ts";
import { migration as createBillingNotifications } from "./20261022030000_create_billing_notifications.ts";
import { migration as widenRefusalNoticeCodesForBillingSetup } from "./20261023090000_widen_refusal_notice_codes_for_billing_setup.ts";
import { migration as addJobCheckRunsReviewComment } from "./20261023120000_add_job_check_runs_review_comment.ts";
import { migration as addWorkspaceDeletedAt } from "./20261023150000_add_workspace_deleted_at.ts";
import { migration as addJobsSupersededByIndex } from "./20261023160000_add_jobs_superseded_by_index.ts";
import { migration as addUsersPosthogIdentity } from "./20261025140000_add_users_posthog_identity.ts";
import { migration as createImplementerSessionsAndTurns } from "./20261030140000_create_implementer_sessions_and_turns.ts";
import { migration as widenReviewKindChecksForImplementer } from "./20261030190000_widen_review_kind_checks_for_implementer.ts";

const migrations: Record<string, Migration> = {
  "0001_create_app_meta": createAppMeta,
  "20261010123800_create_auth_tables": createAuthTables,
  "20261010125500_add_user_org_checked_at": addUserOrgCheckedAt,
  "20261010131500_add_user_org_checked_for": addUserOrgCheckedFor,
  "20261010133000_create_allowed_login_pins": createAllowedLoginPins,
  "20261010134000_create_integrations": createIntegrations,
  "20261010143000_create_repositories": createRepositories,
  "20261010170000_create_webhook_deliveries": createWebhookDeliveries,
  "20261010190000_create_projects": createProjects,
  "20261010191500_create_jobs": createJobs,
  "20261010201500_create_app_settings": createAppSettings,
  "20261011090000_create_job_comments": createJobComments,
  "20261011100000_add_jobs_repository_recent_index":
    addJobsRepositoryRecentIndex,
  "20261011160000_create_workspaces": createWorkspaces,
  "20261011160100_add_workspace_to_customer_data": addWorkspaceToCustomerData,
  "20261011160200_prepare_users_for_accounts": prepareUsersForAccounts,
  "20261011170000_create_instance_settings": createInstanceSettings,
  "20261011170100_create_rate_limits": createRateLimits,
  "20261011170200_add_instance_admin_flag_to_users":
    addInstanceAdminFlagToUsers,
  "20261011200000_create_secrets": createSecrets,
  "20261011200100_create_password_reset_tokens": createPasswordResetTokens,
  "20261011210000_create_email_verification_tokens":
    createEmailVerificationTokens,
  "20261012100000_create_invitations": createInvitations,
  "20261012120000_create_signed_states": createSignedStates,
  "20261012120100_add_users_email_conflict": addUsersEmailConflict,
  "20261012120200_unique_accounts": uniqueAccounts,
  "20261012140000_create_workspace_secrets": createWorkspaceSecrets,
  "20261012140100_create_job_claimed_keys": createJobClaimedKeys,
  "20261012150000_create_installation_binding": createInstallationBinding,
  "20261012160000_remove_commands": removeCommands,
  "20261013090000_add_job_review_kind": addJobReviewKind,
  "20261014090000_fix_dynamic_default_model": fixDynamicDefaultModel,
  "20261014120000_create_workspace_entitlements": createWorkspaceEntitlements,
  "20261014150000_create_usage_records": createUsageRecords,
  "20261015100000_add_job_worker_fetches": addJobWorkerFetches,
  "20261015110000_create_setup_codes": createSetupCodes,
  "20261015120000_create_job_dispatches": createJobDispatches,
  "20261015200000_add_usage_record_settled_reason": addUsageRecordSettledReason,
  "20261016090000_create_refusal_notices": createRefusalNotices,
  "20261016120000_create_plan_handoff_tokens": createPlanHandoffTokens,
  "20261016140000_add_job_accepts_supersede": addJobAcceptsSupersede,
  "20261016140100_widen_usage_record_settled_reason":
    widenUsageRecordSettledReason,
  "20261017100000_create_job_check_runs": createJobCheckRuns,
  "20261017140000_create_model_catalog_entries": createModelCatalogEntries,
  "20261017160000_add_workspace_entitlements_model_access":
    addWorkspaceEntitlementsModelAccess,
  "20261018090000_add_usage_record_catalog_entry": addUsageRecordCatalogEntry,
  "20261018170000_migrate_model_tiers_to_catalog": migrateModelTiersToCatalog,
  "20261019150000_create_billing_journal": createBillingJournal,
  "20261019160000_create_job_vm_runs": createJobVmRuns,
  "20261019170000_create_billing_topup_intents": createBillingTopupIntents,
  "20261019183000_add_jobs_created_at_index": addJobsCreatedAtIndex,
  "20261019200000_create_models_dev_catalog": createModelsDevCatalog,
  "20261020090000_create_model_decisions": createModelDecisions,
  "20261021090000_widen_refusal_notice_codes": widenRefusalNoticeCodes,
  "20261021090100_widen_job_vm_runs_end_source": widenJobVmRunsEndSource,
  "20261021120000_add_billing_balances_reserved_index":
    addBillingBalancesReservedIndex,
  "20261021130000_create_billing_profiles": createBillingProfiles,
  "20261021150000_create_billing_start_credit_grants":
    createBillingStartCreditGrants,
  "20261021170000_add_billing_topup_intents_provider_amount":
    addBillingTopupIntentsProviderAmount,
  "20261021190000_add_billing_topup_intents_provider_currency":
    addBillingTopupIntentsProviderCurrency,
  "20261021190100_add_billing_webhook_events_review_context":
    addBillingWebhookEventsReviewContext,
  "20261021210000_widen_refusal_notice_codes_for_limits":
    widenRefusalNoticeCodesForLimits,
  "20261021210100_create_billing_workspace_settings":
    createBillingWorkspaceSettings,
  "20261021210200_add_limit_query_indexes": addLimitQueryIndexes,
  "20261022010000_add_usage_record_billing_state": addUsageRecordBillingState,
  "20261022020000_add_billing_webhook_events_resolution":
    addBillingWebhookEventsResolution,
  "20261022030000_create_billing_notifications": createBillingNotifications,
  "20261023090000_widen_refusal_notice_codes_for_billing_setup":
    widenRefusalNoticeCodesForBillingSetup,
  "20261023120000_add_job_check_runs_review_comment":
    addJobCheckRunsReviewComment,
  "20261023150000_add_workspace_deleted_at": addWorkspaceDeletedAt,
  "20261023160000_add_jobs_superseded_by_index": addJobsSupersededByIndex,
  "20261025140000_add_users_posthog_identity": addUsersPosthogIdentity,
  "20261030140000_create_implementer_sessions_and_turns":
    createImplementerSessionsAndTurns,
  "20261030190000_widen_review_kind_checks_for_implementer":
    widenReviewKindChecksForImplementer,
};

export const migrationProvider: MigrationProvider = {
  async getMigrations() {
    return migrations;
  },
};
