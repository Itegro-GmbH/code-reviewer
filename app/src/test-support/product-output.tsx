// SPDX-License-Identifier: LicenseRef-Proprietary

// Everything a product's identity ends up in, as one value (#715 cut 7, #740): the five mails, the words of the model chooser
// and the brand, the check run and the verdict, the GitHub App manifest, the refusal notices and the message modules. The
// golden test pins it for code-review.com; the brand-leak test renders it for every other product and looks for a foreign name.
import { renderToStaticMarkup } from "react-dom/server";
import { createCapabilitySet } from "../capabilities/capability.ts";
import { PRODUCTS } from "../capabilities/products.ts";
import { Brand, ProductName } from "../components/brand.tsx";
import * as modelChoice from "../copy/model-choice.ts";
import type { ProductIdentity } from "../product-identity/identity.ts";
import * as authLoginErrors from "../auth/login-errors.ts";
import * as enablingCopy from "../billing/enabling-copy.ts";
import { describeCheck } from "../check-runs/check-text.ts";
import { withdrawMessage } from "../check-runs/service.ts";
import { verdictBody } from "../check-runs/verdict.ts";
import * as configNotices from "../config-status/notices.ts";
import * as planUsage from "../copy/plan-usage.ts";
import * as refusalCopy from "../copy/refusal-notice.ts";
import * as installationMessages from "../installation-binding/ui/messages.ts";
import {
  buildAppManifest,
  suggestedAppName,
} from "../integrations/registry.ts";
import { NOTICE_CODES, noticeBody } from "../refusal-notices/notice-text.ts";
import * as reviewSettingsMessages from "../review-settings/ui/messages.ts";
import * as errorCopy from "../runs/error-copy.ts";
import * as transportMessages from "../ui/transport-messages.ts";
import * as workspaceMessages from "../workspaces/ui/messages.ts";
import { balanceMessage } from "../mail/balance-message.ts";
import { invitationMessage } from "../mail/invitation-message.ts";
import { passwordResetMessage } from "../mail/password-reset-message.ts";
import { testMessage } from "../mail/test-mail.ts";
import { verificationMessage } from "../mail/verification-message.ts";

const LINK = "https://reviews.example.test/x?token=abc123";

// #740: the texts the sweep takes the name out of, as code-review.com shows them. A module's constants are taken as they
// are (a function is not data and drops out of the JSON), what a function writes is called with the codes that carry a word.
function texts(product: ProductIdentity) {
  const url = "https://reviews.example.test";
  const subjects = [
    { status: "queued" },
    { status: "running" },
    { status: "superseded" },
    { status: "succeeded", verdict: { kind: "skip", reason: "off" } },
    {
      status: "succeeded",
      verdict: { kind: "skip", reason: "review_incomplete" },
    },
    { status: "succeeded", verdict: { kind: "skip", reason: "no_severity" } },
    {
      status: "succeeded",
      verdict: { kind: "skip", reason: "findings_unknown" },
    },
    { status: "succeeded", verdict: { kind: "skip", reason: "no_model_work" } },
    { status: "cancelled", errorCode: "cost_limit_reached" },
    {
      status: "failed",
      errorCode: "cost_limit_reached",
      stoppedEarly: "cost_limit",
    },
    {
      status: "failed",
      errorCode: "cost_limit_reached",
      stoppedEarly: "project_cost_limit",
    },
    { status: "failed", errorCode: "billing_not_configured" },
    { status: "failed", errorCode: "a_code_nobody_knows" },
    { status: "failed", errorCode: null },
  ] as const;
  return {
    checkRuns: {
      checkName: product.checkName,
      withdrawMessage: withdrawMessage(product),
      verdictChanges: verdictBody(product, {
        jobId: "job-1",
        event: "request_changes",
        mode: "blocking",
        blocking: 2,
        commentUrl: `${url}/c`,
      }),
      verdictApproved: verdictBody(product, {
        jobId: "job-1",
        event: "approve",
        mode: "any",
        blocking: 0,
        commentUrl: null,
      }),
      checks: subjects.map((subject) =>
        describeCheck(product, {
          errorCode: null,
          commentUrl: `${url}/c`,
          findings: null,
          stoppedEarly: null,
          ...subject,
        } as Parameters<typeof describeCheck>[1]),
      ),
    },
    manifest: {
      built: buildAppManifest({
        // The words of the manifest do not depend on the product; its permissions do not depend on the words.
        capabilities: createCapabilitySet(PRODUCTS["code-review-com"].default),
        product: product,
        publicUrl: url,
        tenancy: "multi",
        name: suggestedAppName(product, url),
      }),
      suggestedName: suggestedAppName(product, url),
      suggestedNameWithoutHost: suggestedAppName(product, "not a url"),
    },
    refusalNotices: {
      copy: {
        ...refusalCopy,
        NOTICE_ASK_WHOEVER_RUNS_THE_INSTANCE:
          refusalCopy.noticeAskWhoeverRuns(product),
      },
      bodies: NOTICE_CODES.flatMap((code) => [
        noticeBody(product, code, "2026-10-01T00:00:00.000Z", null),
        noticeBody(
          product,
          code,
          "2026-10-01T00:00:00.000Z",
          `${url}/w/acme/plan`,
        ),
      ]),
    },
    errorCopy: {
      constants: {
        HISTORIC_ERROR_CODES: errorCopy.HISTORIC_ERROR_CODES,
        UNSHOWN_ERROR_CODES: errorCopy.UNSHOWN_ERROR_CODES,
        ERROR_COPY: errorCopy.errorCopy(product),
        CHECKOUT_REASON_COPY: errorCopy.CHECKOUT_REASON_COPY,
        UNKNOWN_REASON_COPY: errorCopy.unknownReasonCopy(product),
        UNKNOWN_ERROR_COPY: errorCopy.unknownErrorCopy(product),
      },
      costLimit: ["cost_limit", "project_cost_limit", "other", null].map(
        (stoppedEarly) =>
          errorCopy.describeErrorCode(
            product,
            "cost_limit_reached",
            stoppedEarly,
          ),
      ),
      unknown: errorCopy.describeErrorCode(product, "a_code_nobody_knows"),
      unknownReason: errorCopy.describeCheckoutReason(
        product,
        "a_reason_nobody_knows",
      ),
    },
    messages: {
      installation: {
        ...installationMessages,
        RESULT_COPY: installationMessages.resultCopy(product),
        AVAILABILITY_COPY: installationMessages.availabilityCopy(product),
        REQUEST_STATUS_COPY: installationMessages.requestStatusCopy(product),
      },
      workspaces: workspaceMessages,
      workspaceFailures: [
        "email_not_allowed",
        "signup_closed",
        "not_available",
      ].map((code) =>
        workspaceMessages.describeWorkspaceFailure(product, code),
      ),
      reviewSettings: reviewSettingsMessages,
      reviewSettingsIssues: [
        "MODEL_MANAGED_BY_INSTANCE",
        "CATALOG_ENTRY_OWN_KEY_MODE",
      ].map((code) =>
        reviewSettingsMessages.describeIssue(product, "model", code),
      ),
      transport: {
        TRANSPORT_FAILURE_COPY: transportMessages.transportFailureCopy(product),
        GENERIC_FAILURE: transportMessages.GENERIC_FAILURE,
      },
      loginErrors: [
        "access_denied",
        "email_not_allowed",
        "state_mismatch",
        "nothing_known",
      ].map((code) => authLoginErrors.loginErrorMessage(product, code)),
      planUsage: {
        ...planUsage,
        PLAN_MANAGED: planUsage.planManaged(product),
        PLAN_MANAGED_UNBILLED: planUsage.planManagedUnbilled(product),
      },
      configNotices: {
        constants: configNotices,
        admin: configNotices.describeConfigNotices(
          product,
          {
            githubApp: { configured: false, kind: "missing", variables: [] },
            llm: { warnings: [] },
          } as unknown as Parameters<
            typeof configNotices.describeConfigNotices
          >[1],
          "operator",
        ),
        adminWithVariables: configNotices.describeConfigNotices(
          product,
          {
            githubApp: {
              configured: false,
              kind: "invalid",
              variables: ["GITHUB_APP_ID"],
            },
            llm: { warnings: [] },
          } as unknown as Parameters<
            typeof configNotices.describeConfigNotices
          >[1],
          "operator",
        ),
      },
      enabling: enablingCopy.enablingNotice(product, {
        workspaces: 3,
        ownKeyWorkspaces: 1,
      }),
    },
  };
}

export function productOutput(product: ProductIdentity) {
  const words = modelChoice.modelChoiceWords(product);
  return {
    productName: product.name,
    passwordReset: passwordResetMessage({
      product: product,
      to: "ada@example.test",
      link: LINK,
      validForMinutes: 30,
    }),
    invitationAdmin: invitationMessage({
      product: product,
      to: "ada@example.test",
      link: LINK,
      workspaceName: "Acme <Team>",
      inviterName: "Grace",
      role: "admin",
      validForDays: 7,
    }),
    invitationMember: invitationMessage({
      product: product,
      to: "ada@example.test",
      link: LINK,
      workspaceName: "Acme",
      inviterName: "Grace",
      role: "member",
      validForDays: 7,
    }),
    verification: verificationMessage({
      product: product,
      to: "ada@example.test",
      link: LINK,
      validForHours: 24,
    }),
    balanceLow: balanceMessage({
      product: product,
      to: "ada@example.test",
      level: "low",
      workspaceName: "Acme",
      balanceText: "$1.20",
      link: LINK,
    }),
    balanceEmpty: balanceMessage({
      product: product,
      to: "ada@example.test",
      level: "empty",
      workspaceName: "Acme",
      balanceText: "$0.00",
      link: LINK,
    }),
    balanceNegative: balanceMessage({
      product: product,
      to: "ada@example.test",
      level: "negative",
      workspaceName: "Acme",
      balanceText: "-$0.40",
      link: LINK,
    }),
    testMail: testMessage(
      "ada@example.test",
      "https://reviews.example.test",
      product,
    ),
    // Under the names the golden file was recorded with, when the five sentences were constants of the copy module.
    modelChoice: Object.fromEntries([
      ...Object.entries(modelChoice).filter(
        ([, value]) => typeof value === "string",
      ),
      ["MODEL_CHOICE_BILLED_NOTE", words.billedNote],
      ["MODEL_CHOICE_HINT", words.hint],
      ["MODEL_CHOICE_DEFAULT_SOURCE", words.defaultSource],
      ["MODEL_CHOICE_NONE_CHOSEN", words.noneChosen],
      ["MODEL_CHOICE_NONE_OFFERED", words.noneOffered],
    ]),
    brand: renderToStaticMarkup(<Brand product={product} />),
    brandCompact: renderToStaticMarkup(<Brand product={product} compact />),
    productNameInText: renderToStaticMarkup(<ProductName product={product} />),
    ...texts(product),
  };
}
