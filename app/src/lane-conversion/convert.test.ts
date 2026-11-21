// SPDX-License-Identifier: LicenseRef-Proprietary

// The conversion of one lane document (#1105, ADR 0007, "Migration path", release A, steps 2 and 3): what is copied from the profile, what
// is not, how an environment becomes a runner, and what makes a step "not converted". No database: the world is a fake.
import { describe, expect, it, vi } from "vitest";
import { convertDocument } from "./convert.ts";
import type {
  ConversionWorld,
  EnvironmentValues,
  ProfileLookup,
  ProfileValues,
} from "./types.ts";

const PROFILE: ProfileValues = {
  name: "implementer",
  version: 3,
  description: "Writes the change.",
  model: { entryId: "entry-1" },
  instructions: "Be careful.",
  canPush: true,
  defaultResult: null,
  harness: "opencode",
  environmentId: "env-node",
};

const NODE_ENV: EnvironmentValues = {
  id: "env-node",
  name: "node",
  kind: "hosted",
  vcpus: 4,
  setupScript: "npm ci",
  labels: [],
  network: {
    mode: "list",
    hosts: ["registry.npmjs.org", "*.pythonhosted.org"],
  },
};

const HOSTED = [
  { id: "h-2", name: "Vercel Sandbox 2 vCPU", vcpus: 2 },
  { id: "h-4", name: "Vercel Sandbox 4 vCPU", vcpus: 4 },
  { id: "h-8", name: "Vercel Sandbox 8 vCPU", vcpus: 8 },
];

type Fake = {
  profiles?: Record<string, ProfileLookup>;
  environments?: EnvironmentValues[];
  selfHosted?: { id: string; name: string; labels: string[] }[];
};

function world(fake: Fake = {}) {
  const profile = vi.fn(
    (name: string, version: number | undefined): Promise<ProfileLookup> => {
      const key = version === undefined ? name : `${name}@${String(version)}`;
      return Promise.resolve(
        fake.profiles?.[key] ?? { kind: "found", profile: PROFILE },
      );
    },
  );
  const environments = fake.environments ?? [NODE_ENV];
  const value: ConversionWorld = {
    profile,
    environment: ({ id, name }) =>
      Promise.resolve(
        environments.find((e) =>
          id !== undefined ? e.id === id : e.name === name,
        ),
      ),
    hostedRunners: () => HOSTED,
    selfHostedRunners: () => fake.selfHosted ?? [],
  };
  return { value, profile };
}

const lane = (...steps: Record<string, unknown>[]) => ({
  version: 1,
  name: "Lane",
  triggers: [{ id: "manual", kind: "manual", steps: [] }],
  steps,
});

const agent = (extra: Record<string, unknown> = {}) => ({
  id: "implement",
  kind: "agent",
  profile: "implementer@3",
  instruction: "Do it.",
  ...extra,
});

const stepsOf = (document: Record<string, unknown> | undefined) =>
  (document?.steps ?? []) as Record<string, unknown>[];

describe("converting a lane document", () => {
  // #1105-T200
  it("writes the profile values and the hosted runner of the environment's size into the step", async () => {
    const { value } = world();
    const converted = await convertDocument(lane(agent()), value);

    expect(converted.reasons).toEqual([]);
    expect(converted.steps).toBe(1);
    expect(stepsOf(converted.document)[0]).toEqual({
      id: "implement",
      description: "Writes the change.",
      kind: "agent",
      harness: "opencode",
      model: { entryId: "entry-1" },
      canPush: true,
      instructions: "Be careful.",
      runner: "h-4",
      setupScript: "npm ci",
      network: {
        mode: "list",
        hosts: ["registry.npmjs.org", "*.pythonhosted.org"],
      },
      instruction: "Do it.",
    });
  });

  // #1105-T201
  it("resolves a bare profile name as the newest version and name@n as that version", async () => {
    const { value, profile } = world();
    await convertDocument(
      lane(agent({ profile: "implementer" }), agent({ id: "b" })),
      value,
    );

    expect(profile).toHaveBeenNthCalledWith(1, "implementer", undefined);
    expect(profile).toHaveBeenNthCalledWith(2, "implementer", 3);
  });

  // #1105-T202
  it("does not copy the cost limit: the converted step has no such key", async () => {
    const { value } = world({
      profiles: {
        "implementer@3": {
          kind: "found",
          profile: { ...PROFILE, costLimitCents: 500 } as ProfileValues,
        },
      },
    });
    const converted = await convertDocument(lane(agent()), value);

    expect(JSON.stringify(converted.document)).not.toContain("costLimit");
  });

  describe("the default result and the description", () => {
    const schema = {
      type: "object",
      required: ["summary"],
      properties: { summary: { type: "string" } },
    };
    const withDefault = world({
      profiles: {
        "implementer@3": {
          kind: "found",
          profile: { ...PROFILE, defaultResult: JSON.stringify(schema) },
        },
      },
    });

    // #1105-T203
    it("makes the default result of the profile the step's result when the step declared none", async () => {
      const converted = await convertDocument(lane(agent()), withDefault.value);

      expect(stepsOf(converted.document)[0]?.result).toEqual(schema);
    });

    // #1105-T204
    it("keeps the result a step declared", async () => {
      const own = { type: "object", properties: {} };
      const converted = await convertDocument(
        lane(agent({ result: own })),
        withDefault.value,
      );

      expect(stepsOf(converted.document)[0]?.result).toEqual(own);
    });

    // #1105-T205
    it("takes the description of the profile only for a step with none, and none for a blank one", async () => {
      const own = await convertDocument(
        lane(agent({ description: "Mine." })),
        world().value,
      );
      const blank = await convertDocument(
        lane(agent()),
        world({
          profiles: {
            "implementer@3": {
              kind: "found",
              profile: { ...PROFILE, description: "  " },
            },
          },
        }).value,
      );

      expect(stepsOf(own.document)[0]?.description).toBe("Mine.");
      expect(stepsOf(blank.document)[0]).not.toHaveProperty("description");
    });

    // #1105-T206
    it("leaves instructions out when the profile had none, and an off network rule and an empty script too", async () => {
      const converted = await convertDocument(
        lane(agent()),
        world({
          profiles: {
            "implementer@3": {
              kind: "found",
              profile: { ...PROFILE, instructions: "" },
            },
          },
          environments: [
            {
              ...NODE_ENV,
              setupScript: "",
              network: { mode: "off", hosts: [] },
            },
          ],
        }).value,
      );
      const step = stepsOf(converted.document)[0] ?? {};

      expect(step).not.toHaveProperty("instructions");
      expect(step).not.toHaveProperty("setupScript");
      expect(step).not.toHaveProperty("network");
      expect(step.runner).toBe("h-4");
    });

    // #1105-T207
    it("copies an open network rule without hosts", async () => {
      const converted = await convertDocument(
        lane(agent()),
        world({
          environments: [{ ...NODE_ENV, network: { mode: "open", hosts: [] } }],
        }).value,
      );

      expect(stepsOf(converted.document)[0]?.network).toEqual({
        mode: "open",
      });
    });
  });

  describe("the environment becomes a runner", () => {
    // #1105-T210
    it("maps each hosted size to the hosted runner of that type", async () => {
      for (const [vcpus, id] of [
        [2, "h-2"],
        [8, "h-8"],
      ] as const) {
        const converted = await convertDocument(
          lane(agent()),
          world({ environments: [{ ...NODE_ENV, vcpus }] }).value,
        );
        expect(stepsOf(converted.document)[0]?.runner).toBe(id);
      }
    });

    // #1105-T211
    it("does not convert a size no hosted runner type offers", async () => {
      const converted = await convertDocument(
        lane(agent()),
        world({ environments: [{ ...NODE_ENV, vcpus: 1 }] }).value,
      );

      expect(converted.document).toBeUndefined();
      expect(converted.reasons).toMatchObject([
        { code: "environment_size_unsupported", stepId: "implement" },
      ]);
    });

    const RUNNER_ENV: EnvironmentValues = {
      id: "env-devbox",
      name: "devbox",
      kind: "runner",
      vcpus: null,
      setupScript: "",
      labels: ["devbox", "gpu"],
      network: { mode: "off", hosts: [] },
    };
    const runnerProfile = (): Fake["profiles"] => ({
      "implementer@3": {
        kind: "found",
        profile: { ...PROFILE, environmentId: "env-devbox" },
      },
    });

    // #1105-T212
    it("names the self-hosted runner that has all the labels when exactly one has", async () => {
      const converted = await convertDocument(
        lane(agent()),
        world({
          profiles: runnerProfile(),
          environments: [RUNNER_ENV],
          selfHosted: [
            { id: "r-1", name: "DevBox", labels: ["devbox", "gpu", "linux"] },
            { id: "r-2", name: "Other", labels: ["devbox"] },
          ],
        }).value,
      );
      const step = stepsOf(converted.document)[0] ?? {};

      expect(step.runner).toBe("r-1");
      // A runner's setup and network are its owner's: nothing of the environment is copied.
      expect(step).not.toHaveProperty("setupScript");
      expect(step).not.toHaveProperty("network");
    });

    // #1105-T213
    it("lists the lane when no runner has all the labels", async () => {
      const converted = await convertDocument(
        lane(agent()),
        world({
          profiles: runnerProfile(),
          environments: [RUNNER_ENV],
          selfHosted: [{ id: "r-2", name: "Other", labels: ["devbox"] }],
        }).value,
      );

      expect(converted.document).toBeUndefined();
      expect(converted.reasons).toMatchObject([
        { code: "runner_none_match", candidates: [] },
      ]);
    });

    // #1105-T214
    it("lists the lane with the candidates when several runners have all the labels, and never picks", async () => {
      const converted = await convertDocument(
        lane(agent()),
        world({
          profiles: runnerProfile(),
          environments: [RUNNER_ENV],
          selfHosted: [
            { id: "r-1", name: "DevBox A", labels: ["devbox", "gpu"] },
            { id: "r-2", name: "DevBox B", labels: ["gpu", "devbox", "x"] },
          ],
        }).value,
      );

      expect(converted.document).toBeUndefined();
      expect(converted.reasons).toEqual([
        expect.objectContaining({
          code: "runner_several_match",
          stepId: "implement",
          candidates: [
            { id: "r-1", name: "DevBox A" },
            { id: "r-2", name: "DevBox B" },
          ],
        }),
      ]);
    });

    // #1105-T215
    it("reads the environment from the step when the profile version names none, and says so when neither does", async () => {
      const old = world({
        profiles: {
          "implementer@3": {
            kind: "found",
            profile: { ...PROFILE, environmentId: null },
          },
        },
      });
      const named = await convertDocument(
        lane(agent({ environment: "NODE" })),
        {
          ...old.value,
          environment: ({ name }) =>
            Promise.resolve(
              name?.toLowerCase() === "node" ? NODE_ENV : undefined,
            ),
        },
      );
      const none = await convertDocument(lane(agent()), old.value);
      const gone = await convertDocument(
        lane(agent({ environment: "elsewhere" })),
        old.value,
      );

      expect(stepsOf(named.document)[0]).toMatchObject({ runner: "h-4" });
      expect(stepsOf(named.document)[0]).not.toHaveProperty("environment");
      expect(none.reasons[0]?.code).toBe("environment_missing");
      expect(gone.reasons[0]?.code).toBe("environment_not_found");
    });

    // #1105-T216
    it("does not convert a step whose profile's environment is gone", async () => {
      const converted = await convertDocument(
        lane(agent()),
        world({ environments: [] }).value,
      );

      expect(converted.reasons[0]?.code).toBe("environment_not_found");
    });
  });

  describe("the profile cannot be resolved", () => {
    // #1105-T220
    it.each([
      ["archived", "profile_archived"],
      ["missing", "profile_missing"],
      ["version_missing", "profile_version_missing"],
    ] as const)(
      "lists a lane whose profile is %s and returns no document",
      async (kind, code) => {
        const converted = await convertDocument(
          lane(agent()),
          world({ profiles: { "implementer@3": { kind } } }).value,
        );

        expect(converted.document).toBeUndefined();
        expect(converted.reasons).toMatchObject([
          { code, stepId: "implement" },
        ]);
      },
    );

    // #1105-T221
    it("finds every step that cannot be converted, and converts nothing when one cannot", async () => {
      const converted = await convertDocument(
        lane(
          agent(),
          agent({ id: "second", profile: "gone@1" }),
          agent({ id: "third", profile: "gone@2" }),
        ),
        world({
          profiles: {
            "gone@1": { kind: "missing" },
            "gone@2": { kind: "archived" },
          },
        }).value,
      );

      expect(converted.document).toBeUndefined();
      expect(converted.steps).toBe(0);
      expect(converted.reasons.map((r) => [r.stepId, r.code])).toEqual([
        ["second", "profile_missing"],
        ["third", "profile_archived"],
      ]);
    });
  });

  describe("what is left alone", () => {
    // #1105-T230
    it("returns no document for a lane whose steps are inline already, so a second run changes nothing", async () => {
      const inline = lane({
        id: "implement",
        kind: "agent",
        model: { entryId: "e" },
        canPush: true,
        runner: "h-4",
        instruction: "Do it.",
      });
      const { value, profile } = world();
      const first = await convertDocument(inline, value);

      expect(first).toEqual({ steps: 0, reasons: [] });
      expect(profile).not.toHaveBeenCalled();
    });

    // #1105-T231
    it("converts a converted document no further", async () => {
      const { value } = world();
      const once = await convertDocument(lane(agent()), value);
      const again = await convertDocument(once.document, value);

      expect(again).toEqual({ steps: 0, reasons: [] });
    });

    // #1105-T232
    it("does not change the document it is given", async () => {
      const original = lane(agent());
      const snapshot = structuredClone(original);
      await convertDocument(original, world().value);

      expect(original).toEqual(snapshot);
    });

    // #1105-T233
    it("keeps a step that already names a runner and settings of its own", async () => {
      const own = {
        id: "implement",
        kind: "agent",
        model: { entryId: "e" },
        canPush: false,
        runner: "r-9",
        instruction: "Do it.",
      };
      const converted = await convertDocument(
        lane(own, agent({ id: "old" })),
        world().value,
      );

      expect(converted.steps).toBe(1);
      expect(stepsOf(converted.document)[0]).toEqual(own);
    });
  });

  describe("steps in other places and in the form between", () => {
    // #1105-T240
    it("converts agent steps in loop bodies, branches, trigger steps and onFailure", async () => {
      const document = {
        ...lane({
          id: "fix",
          kind: "loop",
          maxRounds: 2,
          body: [agent({ id: "in-loop" })],
          until: { empty: "{{x}}" },
        }),
        triggers: [
          {
            id: "manual",
            kind: "manual",
            steps: [agent({ id: "in-trigger" })],
          },
        ],
        onFailure: [agent({ id: "in-failure" })],
      };
      const converted = await convertDocument(document, world().value);

      expect(converted.steps).toBe(3);
      expect(JSON.stringify(converted.document)).not.toContain('"profile"');
      expect(JSON.stringify(converted.document)).not.toContain('"environment"');
    });

    // #1105-T241
    it("turns the environment of a step with settings of its own into its runner, keeping the script it has itself", async () => {
      const step = {
        id: "implement",
        kind: "agent",
        model: { entryId: "e" },
        canPush: true,
        environment: "node",
        setupScript: "make deps",
        instruction: "Do it.",
      };
      const converted = await convertDocument(lane(step), world().value);
      const out = stepsOf(converted.document)[0] ?? {};

      expect(out.runner).toBe("h-4");
      expect(out).not.toHaveProperty("environment");
      expect(out.setupScript).toBe("make deps");
      expect(out.network).toEqual({
        mode: "list",
        hosts: ["registry.npmjs.org", "*.pythonhosted.org"],
      });
    });
  });

  // #1105-T250
  it("says so for a document that is no object", async () => {
    const converted = await convertDocument("nope", world().value);

    expect(converted.reasons[0]?.code).toBe("document_unreadable");
  });
});
