// SPDX-License-Identifier: LicenseRef-Proprietary

// POST /api/webhooks/github-app: the one webhook URL of the GitHub App (installations, repositories,
// pull requests and comment commands of every installation). Public: no session, the signature of
// the delivery is the authentication. All logic is in src/webhooks/; see its README. A label on an issue starts workflows (#845):
// the engine is wired in here, because it depends on src/webhooks/ and not the other way round; so is the ticket mirror (#923).
import { touched } from "../../../../dispatch/maintenance-shared.ts";
import { deliveryTouchedTheQueue } from "../../../../webhooks/touch-policy.ts";
import { getGithubAppWebhookHandler } from "../../../../webhooks/shared.ts";
import { trackerMirrorFor } from "../../../../tracker/shared.ts";
import {
  labelTriggerFor,
  ticketAnswersFor,
} from "../../../../workflow-runs/shared.ts";

export async function POST(request: Request): Promise<Response> {
  const response = await getGithubAppWebhookHandler({
    workflowsFor: labelTriggerFor,
    answersFor: ticketAnswersFor,
    trackerFor: trackerMirrorFor,
  })(request);
  // #395: a delivery that queued a job (or dropped waiting ones) is a moment at which the database is awake anyway;
  // the repair work of the sweep (expired leases, calls that are due) is done after the response, at most every
  // 30 seconds. A delivery that is not used, a duplicate or an ignored one is not (src/webhooks/touch-policy.ts).
  if (await deliveryTouchedTheQueue(response)) touched();
  return response;
}
