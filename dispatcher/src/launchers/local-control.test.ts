// SPDX-License-Identifier: LicenseRef-Proprietary

import { readFileSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import type { LaunchSpec } from "../core/types.ts";
import { readContract } from "../test-support/harness.ts";
import {
  ContainerLauncher,
  ContainerSpecError,
  assertHardenedSpec,
  renderDockerRunArguments,
  type ContainerInvocation,
} from "./container.ts";
import {
  IMPLEMENTER_CONTAINER_SPEC,
  SANDBOX_LAUNCHER_ADDITIONS,
  WORKER_CONTAINER_SPEC,
} from "./container-spec.ts";
import {
  ENVIRONMENT_CONTROL_VARIABLE,
  LOCAL_CONTROL_SECCOMP_PATH,
  LOCAL_IMAGE_REFERENCE,
  LOCAL_IMPLEMENTER_CONTAINER_SPEC,
  buildStartRequest,
  renderLocalControl,
} from "./local-control.ts";
import { environmentOf, planForKind } from "./sandbox.ts";

const IMAGE =
  "registry.invalid/code-reviewer-worker@sha256:0000000000000000000000000000000000000000000000000000000000000000";
const IMAGE_ID = `sha256:${"ab".repeat(32)}`;
const CREDENTIAL = "crj_dummy-credential-0123456789";
const LOCAL_CREDENTIAL = "dummy-local-credential-0123456789";

function golden(name: string): string[] {
  return JSON.parse(
    readFileSync(new URL(`./testdata/${name}`, import.meta.url), "utf8"),
  ) as string[];
}

function spec(): LaunchSpec {
  return {
    appId: "app-1",
    appUrl: "https://app.example",
    jobId: "job-1",
    credential: CREDENTIAL,
    kind: "implementer",
    timeoutSeconds: 3600,
    config: {},
  };
}

const plan = planForKind("implementer", {});
const options = {
  spec: spec(),
  image: IMAGE,
  plan,
  sysboxProof: "proven",
} as const;

/** The hosted rendering of the same job: the Implementer's spec, the hosted environment, no seccomp profile. */
async function hostedInvocation(): Promise<ContainerInvocation> {
  let invocation: ContainerInvocation | undefined;
  await new ContainerLauncher({
    host: {
      run: (rendered) => {
        invocation = rendered;
        return Promise.resolve({ exitCode: 0 });
      },
    },
    spec: IMPLEMENTER_CONTAINER_SPEC,
    image: IMAGE,
    environment: environmentOf("implementer", undefined, plan, "proven"),
    additions: SANDBOX_LAUNCHER_ADDITIONS,
  }).launch({
    ...spec(),
    config: { container: plan.overrides },
  });
  if (invocation === undefined) throw new Error("nothing was rendered");
  return invocation;
}

describe("the local Control container's spec", () => {
  // #977-T01
  it("renders the arguments of the golden file, which the runner's vm-init tests feed to the guest unchanged", async () => {
    const { args } = await renderLocalControl(options);

    expect(args).toEqual(golden("docker-run.local-control.golden.json"));
  });

  // #977-T01
  it("is the hosted rendering with exactly two more things: the vsock variable and the seccomp profile", async () => {
    const local = (await renderLocalControl(options)).args;
    const hosted = (await hostedInvocation()).args;

    // Take the two out, with the flags that introduce them.
    const stripped: string[] = [];
    for (let i = 0; i < local.length; i += 1) {
      const next = local[i + 1];
      if (
        (local[i] === "--security-opt" &&
          next === `seccomp=${LOCAL_CONTROL_SECCOMP_PATH}`) ||
        (local[i] === "--env" &&
          next === `${ENVIRONMENT_CONTROL_VARIABLE}=vsock`)
      ) {
        i += 1;
        continue;
      }
      stripped.push(local[i] as string);
    }

    expect(stripped.length).toBe(local.length - 4);
    expect(stripped).toEqual(hosted);
    expect(local).toContain(`seccomp=${LOCAL_CONTROL_SECCOMP_PATH}`);
    expect(local).toContain(`${ENVIRONMENT_CONTROL_VARIABLE}=vsock`);
  });

  // #977-T01
  it("keeps every hardening flag of the hosted container", async () => {
    const { args } = await renderLocalControl(options);

    for (const flag of [
      "--read-only",
      "--cap-drop",
      "ALL",
      "no-new-privileges:true",
      "--pids-limit",
      "2048",
      "--oom-score-adj",
      "-1000",
      "--network",
      "bridge",
    ])
      expect(args).toContain(flag);
    expect(args).not.toContain("--privileged");
    expect(args.join(" ")).not.toContain("seccomp=unconfined");
    // Control is the only container that gets the profile; the Docker socket stays read-only.
    expect(args.filter((argument) => argument.startsWith("seccomp="))).toEqual([
      `seccomp=${LOCAL_CONTROL_SECCOMP_PATH}`,
    ]);
    expect(args.join(" ")).toContain("target=/run/docker.sock,readonly");
  });

  // #977-T01
  it("is a hardened Implementer spec", () => {
    expect(() =>
      assertHardenedSpec(LOCAL_IMPLEMENTER_CONTAINER_SPEC),
    ).not.toThrow();
  });

  // #977-T01
  it("differs from the hosted spec in its allow-list alone, and the hosted specs do not allow the variable", () => {
    expect({
      ...LOCAL_IMPLEMENTER_CONTAINER_SPEC,
      allowedEnvironment: IMPLEMENTER_CONTAINER_SPEC.allowedEnvironment,
    }).toEqual(IMPLEMENTER_CONTAINER_SPEC);
    expect(LOCAL_IMPLEMENTER_CONTAINER_SPEC.allowedEnvironment).toContain(
      ENVIRONMENT_CONTROL_VARIABLE,
    );
    for (const hosted of [IMPLEMENTER_CONTAINER_SPEC, WORKER_CONTAINER_SPEC]) {
      expect(hosted.allowedEnvironment).not.toContain(
        ENVIRONMENT_CONTROL_VARIABLE,
      );
      expect(() =>
        renderDockerRunArguments(hosted, {
          image: IMAGE,
          environment: { [ENVIRONMENT_CONTROL_VARIABLE]: "vsock" },
          ...("workVolume" in hosted ? { workVolume: "v" } : {}),
        }),
      ).toThrow(ContainerSpecError);
    }
  });

  // #977-T04
  it("never has the credential in an argument, and puts the job on stdin as the hosted launcher does", async () => {
    const { args, stdin } = await renderLocalControl(options);

    expect(args.join("\n")).not.toContain(CREDENTIAL);
    expect(JSON.parse(stdin)).toEqual({
      appUrl: "https://app.example",
      jobId: "job-1",
      credential: CREDENTIAL,
    });
    expect(stdin).toBe((await hostedInvocation()).stdin);
  });
});

describe("the start request of vm-init", () => {
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  const contract = readContract<{ $id: string }>("vm-init.v1.json");
  ajv.addSchema(contract);
  const valid = (definition: string, value: unknown): boolean => {
    const check = ajv.getSchema(`${contract.$id}#/$defs/${definition}`);
    if (check === undefined) throw new Error(definition);
    return check(value) as boolean;
  };

  // #977-T01
  it("is valid under the contract and carries the rendered arguments, the image check and the work volume", async () => {
    const start = await buildStartRequest({
      ...options,
      image: IMAGE_ID,
      reserveGib: 8,
    });

    expect(valid("StartRequest", start)).toBe(true);
    expect(start.control.args).toEqual(
      (await renderLocalControl({ ...options, image: IMAGE_ID })).args,
    );
    expect(start.image).toEqual({
      reference: LOCAL_IMAGE_REFERENCE,
      id: IMAGE_ID,
    });
    expect(start.workVolume).toEqual({
      name: "code-reviewer-work-job-1",
      reserveGib: 8,
    });
    expect(start.job).toEqual({
      appUrl: "https://app.example",
      jobId: "job-1",
      credential: CREDENTIAL,
    });
  });

  // #977-T04
  it("carries the local credential beside the job and never in an argument", async () => {
    const start = await buildStartRequest({
      ...options,
      image: IMAGE_ID,
      reserveGib: 8,
      localCredential: {
        name: "CLAUDE_CODE_OAUTH_TOKEN",
        value: LOCAL_CREDENTIAL,
      },
    });

    expect(valid("StartRequest", start)).toBe(true);
    expect(start.localCredential?.value).toBe(LOCAL_CREDENTIAL);
    expect(JSON.stringify(start.control)).not.toContain(LOCAL_CREDENTIAL);
    expect(JSON.stringify(start.control)).not.toContain(CREDENTIAL);
  });

  // #977-T04
  it("refuses a credential that would be an argument", async () => {
    await expect(
      buildStartRequest({
        ...options,
        image: IMAGE_ID,
        reserveGib: 8,
        spec: { ...spec(), credential: "worker-once" },
      }),
    ).rejects.toThrow();
  });

  // #977-T02
  it("is refused by the contract when a part is missing or unknown", async () => {
    const start = await buildStartRequest({
      ...options,
      image: IMAGE_ID,
      reserveGib: 8,
    });
    const withoutImage: Partial<typeof start> = { ...start };
    delete withoutImage.image;

    expect(valid("StartRequest", withoutImage)).toBe(false);
    expect(valid("StartRequest", { ...start, extra: 1 })).toBe(false);
    expect(
      valid("StartRequest", {
        ...start,
        workVolume: { name: "v", reserveGib: 65 },
      }),
    ).toBe(false);
  });

  it("has valid examples of every definition", () => {
    for (const definition of [
      "StartRequest",
      "ExitReport",
      "AckReply",
      "RefusedReply",
    ]) {
      const example = JSON.parse(
        readFileSync(
          new URL(
            `../../../contracts/examples/vm-init/${definition}.json`,
            import.meta.url,
          ),
          "utf8",
        ),
      ) as unknown;
      expect(valid(definition, example)).toBe(true);
    }
  });
});
