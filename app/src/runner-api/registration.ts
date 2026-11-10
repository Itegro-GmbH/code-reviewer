// SPDX-License-Identifier: LicenseRef-Proprietary

// The runner side of the registration (#854): `POST /api/runners/v1/register`, `PUT /api/runners/v1/self` and `POST
// /api/runners/v1/credential`, and the question every other call of a customer's runner begins with: who is this
// (`authenticate`). The format is contracts/runner-registration.v1.json; the errors are those of the runner API.
//
// The order is the contract; each step ends the request on failure, and nothing before the credential check touches the database:
//
//   1. credential   `Authorization: Bearer crc_...` (not for `register`, whose proof is the token in the body)     401
//   2. body         read up to 64 KiB, JSON object, checked                                                  413 / 400
//   3. work         the exchange, the announcement or the renewal
//
// A revoked runner, an unknown credential and a missing header are the same 401, so the answer says nothing about which.
import "server-only";
import type {
  MintedDeliveryKey,
  RunnerCredentialsRepository,
  StoredDelivery,
} from "../db/repositories/runner-credentials-repository.ts";
import type { StoredRunner } from "../db/repositories/runners-repository.ts";
import { readJsonBody } from "./body.ts";
import type { FieldError } from "./contract.ts";
import { describeError, type RunnerApiLogger } from "./logger.ts";
import { bearerTokenOf } from "./token-auth.ts";
import { errorResponse, jsonResponse, unauthorized } from "./responses.ts";
import {
  checkAnnouncement,
  checkRunnerName,
  type Announcement,
  type FieldIssue,
} from "../runner-identity/announcement.ts";
import {
  customerRunnerId,
  hashSecret,
  newRunnerCredential,
  REGISTRATION_TOKEN_PATTERN,
  RUNNER_CREDENTIAL_PATTERN,
} from "../runner-identity/tokens.ts";
import {
  checkDelivery,
  type DeliveryPolicy,
} from "../runner-identity/delivery.ts";
import { reservedLabelIssues } from "../runner-identity/labels.ts";
import { meetsMinimum } from "../runner-identity/versions.ts";

/**
 * The credential of an `Authorization: Bearer` header, or null when the header is missing, uses another scheme or does not carry a
 * credential of this form (the shared token, a lease token and the Worker's credential have other forms).
 */
export function bearerRunnerCredential(header: string | null): string | null {
  const token = bearerTokenOf(header);
  return token !== null && RUNNER_CREDENTIAL_PATTERN.test(token) ? token : null;
}

export { customerRunnerId };

export type FleetSettings = { minBaseVersion: string | null };

/** A runner that proved its credential. */
export type AuthenticatedRunner = {
  runner: StoredRunner;
  /** Whether its base is older than the minimum: it gets no job. */
  updateNeeded: boolean;
  minBaseVersion: string | null;
};

export type RunnerRegistrationApiDeps = {
  credentials: RunnerCredentialsRepository;
  settings: () => FleetSettings;
  logger: RunnerApiLogger;
  /** #972: makes the signing secret of a webhook delivery for a runner: the secret, its id and the sealed text the database keeps. */
  mintDeliveryKey: (runnerId: string) => MintedDeliveryKey;
  /** #972: which addresses a webhook delivery may name (`RUNNER_DELIVERY_ALLOW_LOOPBACK`); read on every call. Default: public https only. */
  deliveryPolicy?: () => DeliveryPolicy;
};

export type RunnerRegistrationApi = {
  register(request: Request): Promise<Response>;
  announce(request: Request): Promise<Response>;
  renew(request: Request): Promise<Response>;
  /** The runner of the request's credential, seen now; null for anything that is not a live runner's credential. */
  authenticate(request: Request): Promise<AuthenticatedRunner | null>;
};

function isRecordBody(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fieldErrors(issues: readonly FieldIssue[]): FieldError[] {
  return issues.map((issue) => ({ field: issue.field, code: issue.code }));
}

/**
 * #971: the labels of a body that are in the platform's reserved namespace `cr:`, as the 422 answer of the door. Only the platform
 * identity (the shared token) carries those labels, and nothing in this API is that identity: a customer's runner is refused whatever
 * the spelling. Asked only for a body that passed the form check, so a malformed body keeps its 400.
 */
function reservedLabelsOf(body: unknown): Response | null {
  const labels =
    typeof body === "object" && body !== null && !Array.isArray(body)
      ? (body as Record<string, unknown>).labels
      : undefined;
  const issues = Array.isArray(labels) ? reservedLabelIssues(labels) : [];
  return issues.length === 0
    ? null
    : errorResponse(422, "RUNNER_LABEL_RESERVED", { fields: issues });
}

/** The `delivery` of an answer: what the app holds; the secret only when this call made it. Left out for a runner that polls. */
function deliveryAnswer(
  delivery: StoredDelivery | undefined,
): { delivery: StoredDelivery } | Record<string, never> {
  return delivery === undefined || delivery.mode === "poll" ? {} : { delivery };
}

export function updateNeededFor(
  baseVersion: string,
  minBaseVersion: string | null,
): boolean {
  return minBaseVersion !== null && !meetsMinimum(baseVersion, minBaseVersion);
}

export function createRunnerRegistrationApi(
  deps: RunnerRegistrationApiDeps,
): RunnerRegistrationApi {
  async function authenticate(
    request: Request,
  ): Promise<AuthenticatedRunner | null> {
    const credential = bearerRunnerCredential(
      request.headers.get("authorization"),
    );
    if (credential === null) return null;
    const runner = await deps.credentials.authenticate(hashSecret(credential));
    if (runner === undefined) return null;
    const { minBaseVersion } = deps.settings();
    return {
      runner,
      minBaseVersion,
      updateNeeded: updateNeededFor(runner.baseVersion, minBaseVersion),
    };
  }

  function unexpected(what: string, error: unknown): Response {
    deps.logger.error(
      `[runner-registration] ${what} failed: ${describeError(error)}`,
    );
    return errorResponse(500, "RUNNER_INTERNAL_ERROR");
  }

  return {
    authenticate,

    async register(request) {
      try {
        const body = await readJsonBody(request);
        if (!body.ok) return body.response;
        const fields: Record<string, unknown> =
          typeof body.value === "object" &&
          body.value !== null &&
          !Array.isArray(body.value)
            ? (body.value as Record<string, unknown>)
            : {};
        const issues: FieldIssue[] = [];
        const token = fields.token;
        if (token === undefined)
          issues.push({ field: "token", code: "required" });
        else if (
          typeof token !== "string" ||
          !REGISTRATION_TOKEN_PATTERN.test(token)
        )
          issues.push({ field: "token", code: "invalid" });
        const name = checkRunnerName(fields.name);
        if (fields.name === undefined)
          issues.push({ field: "name", code: "required" });
        else if (name === null) issues.push({ field: "name", code: "invalid" });
        const announcement = checkAnnouncement(fields);
        if (!announcement.ok) issues.push(...announcement.fields);
        const delivery = checkDelivery(
          fields.delivery,
          deps.deliveryPolicy?.(),
        );
        if (!delivery.ok) issues.push(...delivery.fields);
        if (
          issues.length > 0 ||
          !announcement.ok ||
          !delivery.ok ||
          name === null
        )
          return errorResponse(400, "RUNNER_REQUEST_INVALID", {
            fields: fieldErrors(issues),
          });
        const reserved = reservedLabelsOf(fields);
        if (reserved !== null) return reserved;

        const credential = newRunnerCredential();
        // A webhook delivery gets its secret with the runner: sealed for the id the runner will have, shown once in this answer.
        const runnerId = crypto.randomUUID();
        const key =
          delivery.value.mode === "webhook"
            ? deps.mintDeliveryKey(runnerId)
            : undefined;
        const outcome = await deps.credentials.redeem(
          hashSecret(token as string),
          {
            ...announcement.value,
            name,
            credentialHash: hashSecret(credential),
            id: runnerId,
            ...(delivery.value.mode === "webhook" && key !== undefined
              ? { delivery: { url: delivery.value.url, key } }
              : {}),
          },
        );
        if (!outcome.ok)
          return errorResponse(401, "RUNNER_REGISTRATION_TOKEN_INVALID");
        deps.logger.info(
          `[runner-registration] registered runner=${outcome.runner.id} workspace=${outcome.runner.workspaceId}`,
        );
        return jsonResponse(201, {
          version: 1,
          runnerId: outcome.runner.id,
          credential,
          minBaseVersion: deps.settings().minBaseVersion,
          ...(delivery.value.mode === "webhook" && key !== undefined
            ? {
                delivery: {
                  mode: "webhook",
                  url: delivery.value.url,
                  keyId: key.keyId,
                  secret: key.secret,
                },
              }
            : {}),
        });
      } catch (error) {
        return unexpected("register", error);
      }
    },

    async announce(request) {
      try {
        const who = await authenticate(request);
        if (who === null) return unauthorized();
        const body = await readJsonBody(request);
        if (!body.ok) return body.response;
        const checked = checkAnnouncement(body.value);
        if (!checked.ok)
          return errorResponse(400, "RUNNER_REQUEST_INVALID", {
            fields: fieldErrors(checked.fields),
          });
        const delivery = checkDelivery(
          isRecordBody(body.value) ? body.value.delivery : undefined,
          deps.deliveryPolicy?.(),
        );
        if (!delivery.ok)
          return errorResponse(400, "RUNNER_REQUEST_INVALID", {
            fields: fieldErrors(delivery.fields),
          });
        const reserved = reservedLabelsOf(body.value);
        if (reserved !== null) return reserved;
        const announcement: Announcement = checked.value;
        // A runner revoked between the two statements is the same 401.
        if (!(await deps.credentials.announce(who.runner.id, announcement)))
          return unauthorized();
        const change = delivery.value;
        const stored = await deps.credentials.setDelivery(
          who.runner.id,
          change.mode === "poll"
            ? { mode: "poll" }
            : {
                mode: "webhook",
                url: change.url,
                rotateSecret: change.rotateSecret,
                mintKey: () => deps.mintDeliveryKey(who.runner.id),
              },
        );
        if (stored === undefined) return unauthorized();
        return jsonResponse(200, {
          version: 1,
          runnerId: who.runner.id,
          minBaseVersion: who.minBaseVersion,
          updateNeeded: updateNeededFor(
            announcement.baseVersion,
            who.minBaseVersion,
          ),
          ...deliveryAnswer(stored),
        });
      } catch (error) {
        return unexpected("announce", error);
      }
    },

    async renew(request) {
      try {
        const who = await authenticate(request);
        if (who === null) return unauthorized();
        const presented = bearerRunnerCredential(
          request.headers.get("authorization"),
        );
        if (presented === null) return unauthorized();
        const credential = newRunnerCredential();
        if (
          !(await deps.credentials.renew(
            who.runner.id,
            hashSecret(presented),
            hashSecret(credential),
          ))
        )
          return unauthorized();
        deps.logger.info(
          `[runner-registration] renewed runner=${who.runner.id}`,
        );
        return jsonResponse(200, { version: 1, credential });
      } catch (error) {
        return unexpected("renew", error);
      }
    },
  };
}
