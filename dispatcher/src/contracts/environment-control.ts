// SPDX-License-Identifier: LicenseRef-Proprietary

// Generated from contracts/environment-control.v1.json. Do not edit: change the schema and run `make generate-contracts`.
// `make verify` fails while this file differs from what the schema generates.

/**
 * The environment variable that chooses the vsock transport; its one value is `ControlTransportValue`. The Worker refuses a container that sets it to anything else, and one that sets it next to `RUNNER_IMPLEMENTER_NETWORK_SWITCH` (the https transport), with `implementer_config_invalid`. It holds no secret and is set by whoever starts the Worker container (vm-init, #977).
 */
export type ControlVariable = "RUNNER_ENVIRONMENT_CONTROL";
/**
 * The value of `ControlVariable`.
 */
export type ControlTransportValue = "vsock";
/**
 * The context id of the host in the VM's AF_VSOCK address space (VMADDR_CID_HOST).
 */
export type ControlHostCid = 2;
/**
 * The vsock port the host's environment control listens on (Firecracker maps it to the file `<vsock uds path>_5100` of the host).
 */
export type ControlPort = 5100;
/**
 * The most bytes a frame's body has. The largest message is a `narrow` request with a list rule of 100 host names of 253 characters, about 27,000 bytes.
 */
export type ControlMaxFrameBytes = 65536;
/**
 * How long the Worker waits for the answer to `narrow`, from the connect to the end of the reply.
 */
export type ControlNarrowSeconds = 30;
/**
 * How long the Worker waits for the answer to `end`; the Worker is ending, so it is short.
 */
export type ControlEndSeconds = 5;
/**
 * A frame from the Worker to the host.
 */
export type ControlRequest = NarrowRequest | EndRequest;
/**
 * The `type` of a request, and the `for` of the reply that answers it.
 */
export type ControlRequestType = "narrow" | "end";
/**
 * Why a host refused: `rule_not_allowed` (the rule or the model host is not one this host lets a job have), `invalid_request` (the request is well formed JSON but not a request of this contract), `unavailable` (the host cannot do it now, for example its proxy does not answer). A Worker branches on the code and never on anything else.
 */
export type ControlRefusalReason =
  "rule_not_allowed" | "invalid_request" | "unavailable";
/**
 * A frame from the host to the Worker.
 */
export type ControlReply = AckReply | RefusedReply;

/**
 * The rule for the agent's network, the same as `ImplementerNetworkRule` of the runner API (`off`: nothing, `list`: the host names in `hosts`, each exact or `*.` and a suffix, `open`: any public name; `hosts` is empty unless the mode is `list`). `ports` is the Worker's own narrowing of the ports the network door dials and is present only when it is not both of them.
 */
export interface ControlNetworkRule {
  mode: "off" | "list" | "open";
  /**
   * @maxItems 100
   */
  hosts: string[];
  /**
   * @minItems 1
   * @maxItems 2
   */
  ports?: [80 | 443] | [80 | 443, 80 | 443];
}
/**
 * Worker to host: switch the outer wall from the setup's wide rule to the job's: GitHub, the app, the model provider's host (`modelHost`, a plain lower-case ASCII host name, never an address or a wildcard) and `network`. Sent once, after the setup script ended and before the agent exists.
 */
export interface NarrowRequest {
  version: 1;
  type: "narrow";
  network: ControlNetworkRule;
  modelHost: string;
}
/**
 * Worker to host: the Worker ends with this exit code (0 ok, 1 the job failed, 2 setup error); the host may power the sandbox off once it answered. Best effort: the Worker does not wait for more than `ControlEndSeconds` and ignores a refusal.
 */
export interface EndRequest {
  version: 1;
  type: "end";
  exitCode: number;
}
/**
 * Host to Worker: the request named in `for` is done (for `narrow`, the outer wall holds the rule).
 */
export interface AckReply {
  version: 1;
  type: "ack";
  for: ControlRequestType;
}
/**
 * Host to Worker: the request named in `for` was not done, and asking again will not change that.
 */
export interface RefusedReply {
  version: 1;
  type: "refused";
  for: ControlRequestType;
  reason: ControlRefusalReason;
}
