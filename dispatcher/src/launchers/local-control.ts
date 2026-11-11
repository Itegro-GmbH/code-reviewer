// SPDX-License-Identifier: LicenseRef-Proprietary

// The Control container of a Firecracker VM on a customer's own Linux machine (Runner v2, #977, epic #969, ADR 0005): the same
// container as the hosted Implementer's, rendered by the same code from the same spec, plus the two things the local environment
// control needs (contracts/environment-control.v1.json, the comment on #975):
//
//   - `RUNNER_ENVIRONMENT_CONTROL=vsock` in its environment. The name is a member of the local spec's allow-list and deliberately
//     not of the hosted list (`KnownImplementerEnvironmentName` of the app): a hosted container never sets it, and the Worker
//     refuses one that sets it next to the https switch.
//   - a seccomp profile that allows AF_VSOCK (`LOCAL_CONTROL_SECCOMP_PATH`, the file runner/vm-init/control-seccomp.json that
//     vm-init's install hook puts into the root file system): the Worker connects to the host's CID 2 on port 5100 from inside the
//     container itself, and Docker's default profile refuses that socket family. Only this container gets it. The agent's
//     container, the model door, the network door and the readers keep Docker's default profile, which refuses AF_VSOCK (defence in depth:
//     what the host trusts is the per-VM token, `control-token.ts`).
//
// Everything else is the hosted rendering: `renderDockerRunArguments` of container.ts through `ContainerLauncher`, the hosted
// environment (`environmentOf`), the Sandbox variant's IPv6 switches. The hosted spec (`IMPLEMENTER_CONTAINER_SPEC`) and its
// golden file are untouched; the arguments of this one have a golden file of their own next to it
// (testdata/docker-run.local-control.golden.json) that the runner's vm-init tests feed to the guest unchanged.
//
// The start the Dispatcher sends over vsock (`buildStartRequest`) carries these arguments, never the credential in them: the job
// document goes to Control's stdin in the guest, exactly as the hosted launcher writes it to the pipe of `docker run`.
import type { ImplementerContainerSpec } from "../contracts/worker-container.ts";
import type { OuterProxy, StartRequest } from "../contracts/vm-init.ts";
import type { LaunchSpec } from "../core/types.ts";
import {
  ContainerLauncher,
  workVolumeName,
  type ContainerInvocation,
  type ContainerRunResult,
} from "./container.ts";
import {
  IMPLEMENTER_CONTAINER_SPEC,
  SANDBOX_LAUNCHER_ADDITIONS,
} from "./container-spec.ts";
import { environmentOf, type Plan, type SysboxProof } from "./sandbox.ts";

/** The environment variable that chooses the vsock transport of the Worker's environment control. */
export const ENVIRONMENT_CONTROL_VARIABLE = "RUNNER_ENVIRONMENT_CONTROL";
export const ENVIRONMENT_CONTROL_VSOCK = "vsock";

/** Where the root file system has the seccomp profile that allows AF_VSOCK; the Docker CLI in the guest reads it from there. */
export const LOCAL_CONTROL_SECCOMP_PATH =
  "/etc/code-reviewer/control-seccomp.json";

/** The tag the local root file system gives the Worker image (the same recipe as the hosted golden snapshot's). */
export const LOCAL_IMAGE_REFERENCE = "code-reviewer-worker:golden";

/**
 * The hosted Implementer's spec with one more name in its allow-list: `RUNNER_ENVIRONMENT_CONTROL`. Not a copy of the
 * contract's example; it is that spec plus the one name, so a change of the hosted spec is a change of this one.
 */
export const LOCAL_IMPLEMENTER_CONTAINER_SPEC: ImplementerContainerSpec = {
  ...IMPLEMENTER_CONTAINER_SPEC,
  allowedEnvironment: [
    ...IMPLEMENTER_CONTAINER_SPEC.allowedEnvironment,
    ENVIRONMENT_CONTROL_VARIABLE,
  ],
};

export interface LocalControlOptions {
  /** The job: its id, the app, the credential (never in an argument), the timeout and the memory the kind's configuration sets. */
  spec: LaunchSpec;
  /** The image the manifest names, by id (`sha256:...`): exactly the one vm-init checks in the guest. */
  image: string;
  /** The memory plan of the VM (`planForKind`): the Control container's limits and what is left for the agent. */
  plan: Plan;
  /** The root file system's Sysbox verdict (`proven` or `unproven`), as `SANDBOX_SYSBOX_PROOF` is hosted. */
  sysboxProof: SysboxProof;
}

/**
 * The `docker run` arguments and the stdin document of the Control container, rendered by `ContainerLauncher` as the hosted
 * launcher renders them, for the local spec, the local environment and the vsock-capable seccomp profile.
 */
export async function renderLocalControl(
  options: LocalControlOptions,
): Promise<ContainerInvocation> {
  let invocation: ContainerInvocation | undefined;
  const launcher = new ContainerLauncher({
    host: {
      run(rendered): Promise<ContainerRunResult> {
        invocation = rendered;
        return Promise.resolve({ exitCode: 0 });
      },
    },
    spec: LOCAL_IMPLEMENTER_CONTAINER_SPEC,
    image: options.image,
    environment: {
      ...environmentOf(
        "implementer",
        undefined,
        options.plan,
        options.sysboxProof,
      ),
      [ENVIRONMENT_CONTROL_VARIABLE]: ENVIRONMENT_CONTROL_VSOCK,
    },
    additions: SANDBOX_LAUNCHER_ADDITIONS,
    seccompProfile: LOCAL_CONTROL_SECCOMP_PATH,
  });
  await launcher.launch({
    ...options.spec,
    config: { ...options.spec.config, container: options.plan.overrides },
  });
  if (invocation === undefined)
    throw new Error("the launcher did not render an invocation");
  return invocation;
}

export interface StartRequestOptions extends LocalControlOptions {
  /** The tag vm-init looks the image up by (`LOCAL_IMAGE_REFERENCE` unless the root file system says another). */
  imageReference?: string;
  /** The reserve disk of the work volume in GiB (hosted: 8, an eighth of the VM's 64 GB disk). */
  reserveGib: number;
  /** The VM's own token (`generateControlToken`): in every message of the VM, which the host refuses without it. */
  controlToken: string;
  /** The one credential that exists only on the dispatcher's device, if the job needs one (#980). */
  localCredential?: { name: string; value: string };
  /**
   * The outer wall's proxy of the VM's slot (#994): set when the dispatcher runs the proxy wall (the VM has no direct internet),
   * absent otherwise (the inner wall only; hosted never has one). It travels in the start, never in the rendered arguments: the
   * address is per slot, and the Control spec and its golden file are the same with and without the wall.
   */
  outerProxy?: OuterProxy;
}

/**
 * The start of `contracts/vm-init.v1.json` for a job: the rendered arguments, the job document, the VM's token, the image check
 * against the manifest's id and the work volume. Throws when the credential (or the local one, or the token) would be in an
 * argument. The image that runs is the image that is checked: vm-init refuses arguments that name another one, so `options.image`
 * (the id, which is the operand `renderLocalControl` renders) is the start's `image.id`.
 */
export async function buildStartRequest(
  options: StartRequestOptions,
): Promise<StartRequest> {
  const { args: rendered } = await renderLocalControl(options);
  // `docker run`: the contract wants the verb first and at least one argument after it.
  const [verb, first, ...rest] = rendered;
  if (verb !== "run" || first === undefined)
    throw new Error("the rendered arguments are not those of docker run");
  const args: [string, string, ...string[]] = [verb, first, ...rest];
  const secrets = [
    options.spec.credential,
    options.controlToken,
    ...(options.localCredential === undefined
      ? []
      : [options.localCredential.value]),
  ];
  if (args.some((argument) => secrets.some((s) => argument.includes(s))))
    throw new Error("an argument would hold a credential");
  return {
    version: 1,
    type: "start",
    job: {
      appUrl: options.spec.appUrl,
      jobId: options.spec.jobId,
      credential: options.spec.credential,
    },
    controlToken: options.controlToken,
    ...(options.localCredential === undefined
      ? {}
      : { localCredential: options.localCredential }),
    ...(options.outerProxy === undefined
      ? {}
      : { outerProxy: options.outerProxy }),
    image: {
      reference: options.imageReference ?? LOCAL_IMAGE_REFERENCE,
      id: options.image,
    },
    control: { args },
    workVolume: {
      name: workVolumeName(options.spec.jobId),
      reserveGib: options.reserveGib,
    },
  };
}
