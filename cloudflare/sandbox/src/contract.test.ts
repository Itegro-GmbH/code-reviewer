// SPDX-License-Identifier: LicenseRef-Proprietary

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { readConfig } from "./config.ts";
import { handle, type HandlerDeps, type VmClient } from "./handler.ts";
import { RegistryController } from "./registry-controller.ts";
import {
  FakeContainer,
  FakeRegistryStorage,
  FakeVmStorage,
  RecordingLogger,
} from "./test-fakes.ts";
import { VmController } from "./vm-controller.ts";
import { FAILURE_KINDS } from "./errors.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const schema = JSON.parse(
  readFileSync(join(ROOT, "contracts", "cf-sandbox.v1.json"), "utf8"),
) as { $defs: Record<string, unknown> };
const examplesDir = join(ROOT, "contracts", "examples", "cf-sandbox");

const ajv = new Ajv2020({ strict: false, allErrors: true });
ajv.addSchema(schema, "cf");
const check = (definition: string, value: unknown) => {
  const validate = ajv.getSchema(`cf#/$defs/${definition}`);
  if (!validate) throw new Error(`no definition ${definition}`);
  return {
    valid: validate(value) as boolean,
    errors: JSON.stringify(validate.errors),
  };
};

describe("contracts/cf-sandbox.v1.json", () => {
  // #1159-T29
  it("has a valid example for every definition that has one, named by the definition", () => {
    const files = readdirSync(examplesDir).filter((f) => f.endsWith(".json"));
    expect(files.length).toBeGreaterThanOrEqual(13);
    for (const file of files) {
      const definition = file.replace(/\.json$/, "");
      const result = check(
        definition,
        JSON.parse(readFileSync(join(examplesDir, file), "utf8")),
      );
      expect(result.valid, `${file}: ${result.errors}`).toBe(true);
    }
  });

  // #1159-T29
  it("lists the failure kinds of the Dispatcher's port and of this Worker alike", () => {
    const kinds = (
      schema.$defs.ErrorResponse as {
        properties: { error: { enum: string[] } };
      }
    ).properties.error.enum;
    expect([...kinds].sort()).toEqual([...FAILURE_KINDS].sort());
  });

  // #1159-T29
  it("holds against the Worker's own answers", async () => {
    const token = "c".repeat(40);
    const registryStorage = new FakeRegistryStorage();
    const containers = new Map<string, FakeContainer>();
    const registry = new RegistryController(
      registryStorage,
      { destroy: async () => undefined },
      () => 1_795_639_378_000,
    );
    const controllers = new Map<string, VmController>();
    const deps: HandlerDeps = {
      config: readConfig({
        IMAGE_VERSION: "abc",
        WORKER_FEATURES: "implementer_multi_repo",
        WORKER_IMAGE_ID: `sha256:${"1".repeat(64)}`,
        AGENT_IMAGE_ID: `sha256:${"2".repeat(64)}`,
      }),
      token,
      registry,
      vm: (name) => {
        let controller = controllers.get(name);
        if (!controller) {
          const container = new FakeContainer();
          containers.set(name, container);
          controller = new VmController({
            container,
            storage: new FakeVmStorage(),
            registry,
            logger: new RecordingLogger(),
            now: () => 1_795_639_378_000,
            newId: () => "1",
          });
          controllers.set(name, controller);
        }
        return controller as VmClient;
      },
      now: () => 1_795_639_378_000,
    };
    const call = (method: string, path: string, body?: unknown) =>
      handle(
        new Request(`https://x.example${path}`, {
          method,
          headers: { authorization: `Bearer ${token}` },
          body: body === undefined ? undefined : JSON.stringify(body),
        }),
        deps,
      );
    const read = async (
      definition: string,
      response: Response,
      status: number,
    ) => {
      expect(response.status).toBe(status);
      const result = check(definition, await response.json());
      expect(result.valid, `${definition}: ${result.errors}`).toBe(true);
    };

    const create = JSON.parse(
      readFileSync(join(examplesDir, "CreateRequest.json"), "utf8"),
    ) as { name: string };
    expect(check("CreateRequest", create).valid).toBe(true);
    await read("CreateResponse", await call("POST", "/v1/vms", create), 201);
    await read("ListResponse", await call("GET", "/v1/vms"), 200);
    await read(
      "ExecResponse",
      await call("POST", `/v1/vms/${create.name}/exec`, {
        label: "x",
        cmd: "true",
        args: [],
      }),
      200,
    );
    containers.get(create.name)?.scripts.set("docker", {});
    await read(
      "StartProcessResponse",
      await call("POST", `/v1/vms/${create.name}/processes`, {
        label: "p",
        cmd: "docker",
        args: [],
      }),
      201,
    );
    await read(
      "ProcessStatus",
      await call("GET", `/v1/vms/${create.name}/processes/p-1`),
      200,
    );
    await read(
      "ErrorResponse",
      await call("GET", "/v1/vms/nobody/processes/p-1"),
      404,
    );
    await read(
      "HealthResponse",
      await handle(new Request("https://x.example/health"), deps),
      200,
    );
  });
});
