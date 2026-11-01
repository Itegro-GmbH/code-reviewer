// SPDX-License-Identifier: LicenseRef-Proprietary

// Generated from contracts/dispatch-webhook.v1.json. Do not edit: change the schema and run `make generate-contracts`.
// `make verify` fails while this file differs from what the schema generates.

/**
 * Why a receiver answered 200 ignored. `not_claimable`: the claim of that job answered 204 (not due, running, finished, cancelled, superseded, or the pool cap is reached); the app resends after its acknowledgement timeout. `not_capable`: the receiver cannot run that review kind; the app stops resending that kind. A reader accepts any reason of the right form.
 */
export type KnownDispatchIgnoredReason = "not_claimable" | "not_capable";

/**
 * The body of the wake-up call. Closed: an unknown field, such as a secret, a token, a credential, a signature or repository data, is refused. A sender never adds one and a receiver refuses a body that has one.
 */
export interface DispatchWebhook {
  version: 1;
  type: "job.ready";
  /**
   * The id of a job (a UUID).
   */
  jobId: string;
  /**
   * The review kind a job was queued for (#195), pinned at enqueue time. Absent on a legacy Diff payload means diff. A runner is only handed a job whose kind one of its engines can run, and a Dynamic job is never silently run by PR-Agent. #746: `implementer` is a turn of the Implementer (the factory deployment only): its input has no pull request (`prUrl`, `command`, `base` and `dynamic` are absent) and carries the closed `implementer` object; only a runner that advertised the engine `implementer` is handed one, and a job of this kind is never run by another engine.
   */
  reviewKind: "diff" | "dynamic" | "implementer";
  /**
   * The number of the attempt the job is on (1 for the first).
   */
  attempt: number;
  /**
   * The id of a job (a UUID).
   */
  dispatchId: string;
  /**
   * ISO 8601, UTC.
   */
  sentAt: string;
}
/**
 * 202 from the receiver: the wake-up call is verified and the claim goes on in the background.
 */
export interface DispatchAccepted {
  version: 1;
  status: "accepted";
  [k: string]: unknown;
}
/**
 * 200 from the receiver: verified, and there is nothing to start.
 */
export interface DispatchIgnored {
  version: 1;
  status: "ignored";
  reason: string;
  [k: string]: unknown;
}
/**
 * The body of the stop call (#487). Closed, at most 1 KiB, no secret and no repository data. `stopId` is new for every stop of a job and is also the X-Dispatch-Id header; a receiver remembers the ones it handled, so a replay does nothing. The same signing rule as the wake-up call, over this body.
 */
export interface DispatchStop {
  version: 1;
  type: "job.stop";
  /**
   * The id of a job (a UUID).
   */
  jobId: string;
  /**
   * The id of a job (a UUID).
   */
  stopId: string;
  /**
   * ISO 8601, UTC.
   */
  sentAt: string;
}
/**
 * 202 from the receiver: the stop call is verified and the VMs of the job are being stopped in the background. `vms` (#493, optional) names them, so that the app can take the moment of this answer as the end of each VM's billable minutes; a receiver of the earlier release leaves it out, and the sender then falls back to the bounded estimate (contracts/README.md, "Rolling out the billable minutes").
 */
export interface DispatchStopAccepted {
  version: 1;
  status: "stopping";
  /**
   * @maxItems 16
   *
   * Items: #493: the name of a Sandbox VM, as the platform and the Dispatcher know it (unique per launch: `cr-<kind>-<job id>-<random>`). Free text of the Dispatcher's own naming; the app uses it only as a key and never as a command.
   */
  vms?:
    | []
    | [string]
    | [string, string]
    | [string, string, string]
    | [string, string, string, string]
    | [string, string, string, string, string]
    | [string, string, string, string, string, string]
    | [string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
      ]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
      ]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
      ]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
      ]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
      ]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
      ]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
      ];
  [k: string]: unknown;
}
/**
 * 200 from the receiver: verified, and there is nothing to do. `no_vm`: the job has no VM (it never had one, or it is stopped already). `replayed`: this stopId was handled before.
 */
export interface DispatchStopIgnored {
  version: 1;
  status: "ignored";
  reason: "no_vm" | "replayed";
  [k: string]: unknown;
}
/**
 * The file dispatch-signing-vectors.json: signing keys of the example (dummy values), the tolerance, and requests as a receiver sees them with the verdict each must get. A consumer (the app's sender and the Dispatcher's receiver, in TypeScript, and the runner suite in Python) computes the verdict itself and compares. Header names are lower case.
 */
export interface DispatchSigningVectors {
  version: 1;
  toleranceSeconds: number;
  keys: {
    current: DispatchSigningKey;
    previous: DispatchSigningKey;
  };
  /**
   * @minItems 1
   */
  vectors: [
    {
      name: string;
      /**
       * The receiver's clock, Unix seconds.
       */
      now: number;
      headers: {
        [k: string]: string;
      };
      /**
       * The raw body exactly as received.
       */
      body: string;
      expected:
        "ok" | "malformed" | "expired" | "unknown_key" | "bad_signature";
    },
    ...{
      name: string;
      /**
       * The receiver's clock, Unix seconds.
       */
      now: number;
      headers: {
        [k: string]: string;
      };
      /**
       * The raw body exactly as received.
       */
      body: string;
      expected:
        "ok" | "malformed" | "expired" | "unknown_key" | "bad_signature";
    }[],
  ];
  [k: string]: unknown;
}
/**
 * A signing key of the example. The secret is a dummy; a real one is at least 32 characters and unique to this purpose.
 */
export interface DispatchSigningKey {
  kid: string;
  secret: string;
}
