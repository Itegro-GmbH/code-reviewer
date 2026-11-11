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
 * The per-VM token of the host (`ControlToken` of `environment-control.v1.json`, the same value and the same rules): 32 to 96 random bytes in base64url without padding, made by the host for one VM. vm-init writes it to Control's stdin as the `controlToken` key of the job document (with the credential and nowhere else: not an argument, not the environment, not a file, not a log) and puts it in every exit report it sends after it read a start. Control puts it in every message of the environment control. It is a secret of the host's own: the host compares it in constant time and never logs it.
 */
export type ControlToken = string;
/**
 * Why the VM ends: `worker_exited` (Control's container ran and ended; `exitCode` is its status: 0 ok, 1 the job failed, 2 setup error, 20, 21 and 22 the job failed because the subscription of the device refused it (#980: the login, the usage limit, the model; the result delivered to the app carries `subscription_auth`, `subscription_limit` or `subscription_model_refused`), 137 killed, anything else it was given), `docker_failed` (`docker run` itself failed: the status was 125, 126 or 127, so the container was not started or its command was not found), `prepare_failed` (a step of the VM's preparation or of the work volume failed, `exitCode` 2), `image_missing` and `image_mismatch` (the image check of `ImageCheck` failed, `exitCode` 2), `start_invalid` (the start was refused, `exitCode` 2), `start_timeout` (no start in time, `exitCode` 2).
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
 * The arguments of `docker run` for the Control container, without the word `docker`, as `renderDockerRunArguments` of the Dispatcher (dispatcher/src/launchers/container.ts) renders them from the local Implementer spec (dispatcher/src/launchers/local-control.ts): the same hardened flags as the hosted container plus what the local one needs (RUNNER_ENVIRONMENT_CONTROL, a seccomp profile that allows AF_VSOCK). The first one is `run`. No argument may hold the job's credential. The image operand (the first argument after the options) must be the start's `image.id`, or `image.reference`, which vm-init then replaces with the id, so that what runs is the image whose id was checked; any other image is refused. A cheap deny-list refuses `--privileged`, `seccomp=unconfined`, `apparmor=unconfined`, `--pid`, `--net`, `--network`, `--ipc`, `--userns` and `--uts` with `host`, `--device`, `--cap-add ALL`, `--volume` and every `--mount` but the job's work volume (`workVolume.name` at `/work`) and the Docker socket (read only): it catches a bug of the Dispatcher that renders such an option. The host owns the VMM, the kernel and the root file system and is trusted (`runner/vm-init/README.md`, "Trust, the token and the wall clock"); the list is no defence against a host that is hostile.
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
  controlToken: ControlToken;
  localCredential?: LocalCredential;
  image: ImageCheck;
  control: ControlInvocation;
  workVolume: WorkVolume;
}
/**
 * The one credential that exists only on the dispatcher's device and that this job needs (`local-key`, `subscription`: for example `CLAUDE_CODE_OAUTH_TOKEN`, #980; ADR 0005, decision 4). vm-init writes it to Control's stdin as the `localCredential` key of the job document and nowhere else: not an argument, not a file, not a log. vm-init checks the shape; Control (the Worker image's `code-reviewer-worker`) checks the name against its own allow-list (today only `CLAUDE_CODE_OAUTH_TOKEN`) and refuses every other one before it puts the value into any environment (#980). The Worker of a dispatcher's own process reads the same `localCredential` object from its start document.
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
 * Guest to host: the VM ends with this. `token` is the start's `controlToken`: every report of a VM that read a start carries it (`image_missing`, `image_mismatch`, `prepare_failed` after the start, `worker_exited`, `docker_failed`). The reports of a VM that never read one (`start_timeout`, `start_invalid`, `prepare_failed` of the daemon before the start, a VM that could not listen) cannot: no job and no agent exists then, and the host knows it has no `ack` for a start from that VM, so it accepts a report without a token only until then. A host that has an `ack` for the start refuses a report without the token or with another one (`verify` in `dispatcher/src/launchers/control-token.ts`). THE HOST TAKES THE FIRST REPORT of a VM that passes this check and answers every later one with the same `ack`: vm-init sends the report again when the `ack` did not come, so the report is idempotent.
 */
export interface ExitReport {
  version: 1;
  type: "exit";
  exitCode: number;
  reason: ExitReason;
  token?: ControlToken;
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
 * vm-init refuses a start and ends the VM (`start_invalid`): the document is not a `StartRequest` (a frame that is not whole, too large or not one object, a byte after the frame, a field that does not match, a `controlToken` that is missing), its arguments hold a credential, name another image than the checked one or hold an option of the deny-list. `reason` is a stable code and never a text.
 */
export interface RefusedReply {
  version: 1;
  type: "refused";
  for: "start";
  reason: "invalid_start";
}
