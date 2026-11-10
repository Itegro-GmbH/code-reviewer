// SPDX-License-Identifier: LicenseRef-Proprietary

// Generated from contracts/vm-init.v1.json. Do not edit: change the schema and run `make generate-contracts`.
// `make verify` fails while this file differs from what the schema generates.

/**
 * The context id of the host in the VM's AF_VSOCK address space (VMADDR_CID_HOST), where vm-init connects for the exit report.
 */
export type HostCid = 2;
/**
 * The vsock port vm-init listens on for the start (Firecracker: the host connects to `<vsock uds path>` and sends `CONNECT 5000`).
 */
export type StartPort = 5000;
/**
 * The vsock port the host listens on for the exit report (Firecracker maps it to the file `<vsock uds path>_5101` of the host).
 */
export type ReportPort = 5101;
/**
 * The most bytes a frame's body has. The largest start is a `docker run` of a few hundred arguments, a few kilobytes; the limit leaves room and stops a host that is wrong from filling the guest's memory.
 */
export type MaxFrameBytes = 262144;
/**
 * How long vm-init waits for the frame of the start after it accepted the connection.
 */
export type StartReadSeconds = 10;
/**
 * How long vm-init waits for the host's connection after it is prepared, counted from its own start.
 */
export type StartWaitSeconds = 300;
/**
 * How long vm-init spends on the exit report in all: the connect (with its retries) and the wait for the reply.
 */
export type ReportSeconds = 10;
/**
 * The pause between two tries to connect for the exit report.
 */
export type ReportRetrySeconds = 0.5;
/**
 * Why the VM ends: `worker_exited` (Control's container ran and ended; `exitCode` is its status: 0 ok, 1 the job failed, 2 setup error, 137 killed, anything else it was given), `docker_failed` (`docker run` itself failed: the status was 125, 126 or 127, so the container was not started or its command was not found), `prepare_failed` (a step of the VM's preparation or of the work volume failed, `exitCode` 2), `image_missing` and `image_mismatch` (the image check of `ImageCheck` failed, `exitCode` 2), `start_invalid` (the start was refused, `exitCode` 2), `start_timeout` (no start in time, `exitCode` 2).
 */
export type ExitReason =
  | "worker_exited"
  | "docker_failed"
  | "prepare_failed"
  | "image_missing"
  | "image_mismatch"
  | "start_invalid"
  | "start_timeout";
/**
 * The `type` of a request, and the `for` of the reply that answers it.
 */
export type RequestType = "start" | "exit";
/**
 * A frame that answers a request.
 */
export type Reply = AckReply | RefusedReply;

/**
 * What the Worker reads from its stdin (`worker --once`, the input the hosted launcher's `ContainerLauncher` writes): the app, the job and the job's credential `crj_...` (the Worker API's). vm-init writes it to Control's stdin as one JSON line and closes the pipe. It is the only place the credential goes.
 */
export interface JobDocument {
  appUrl: string;
  jobId: string;
  /**
   * Printable ASCII without a space.
   */
  credential: string;
}
/**
 * The arguments of `docker run` for the Control container, without the word `docker`, as `renderDockerRunArguments` of the Dispatcher (dispatcher/src/launchers/container.ts) renders them from the local Implementer spec (dispatcher/src/launchers/local-control.ts): the same hardened flags as the hosted container plus what the local one needs (RUNNER_ENVIRONMENT_CONTROL, a seccomp profile that allows AF_VSOCK). The first one is `run`. No argument may hold the job's credential.
 */
export interface ControlInvocation {
  /**
   * @minItems 2
   * @maxItems 256
   */
  args: [string, string, ...string[]];
}
/**
 * The job's work volume (`workVolumeCommands` of dispatcher/src/launchers/container.ts): a directory of the VM's disk that is a mount of its own with the profile's options, with a reserve disk of `reserveGib` GiB below it that the agent cannot fill, and a Docker named volume `name` over it. vm-init makes it with the same steps as the hosted launcher; only the size of the reserve is the host's (the hosted VM's is 8, an eighth of its 64 GB disk).
 */
export interface WorkVolume {
  name: string;
  reserveGib: number;
}
/**
 * Host to guest: run this job.
 */
export interface StartRequest {
  version: 1;
  type: "start";
  job: JobDocument;
  localCredential?: LocalCredential;
  image: ImageCheck;
  control: ControlInvocation;
  workVolume: WorkVolume;
}
/**
 * The one credential that exists only on the dispatcher's device and that this job needs (`local-key`, `subscription`: for example `CLAUDE_CODE_OAUTH_TOKEN`, #980; ADR 0005, decision 4). vm-init writes it to Control's stdin as the `localCredential` key of the job document and nowhere else: not an argument, not a file, not a log. What Control does with it is #980's.
 */
export interface LocalCredential {
  /**
   * The name of the environment variable the credential is for.
   */
  name: string;
  /**
   * Printable ASCII without a space.
   */
  value: string;
}
/**
 * The check of the hosted launcher's `prepare()`: `docker image inspect --format {{.Id}} <reference>` must print `id`, the image id of the manifest the local Dispatcher verified (#976, #978). vm-init ends the VM with `image_missing` when the reference is unknown and `image_mismatch` when the id is another one. The id is not a secret.
 */
export interface ImageCheck {
  reference: string;
  id: string;
}
/**
 * Guest to host: the VM ends with this.
 */
export interface ExitReport {
  version: 1;
  type: "exit";
  exitCode: number;
  reason: ExitReason;
}
/**
 * The request named in `for` is taken: for `start`, vm-init accepted the job and will run it; for `exit`, the host has the report.
 */
export interface AckReply {
  version: 1;
  type: "ack";
  for: RequestType;
}
/**
 * vm-init refuses a start and ends the VM (`start_invalid`): the document is not a `StartRequest`, or its arguments hold the credential. `reason` is a stable code and never a text.
 */
export interface RefusedReply {
  version: 1;
  type: "refused";
  for: "start";
  reason: "invalid_start";
}
