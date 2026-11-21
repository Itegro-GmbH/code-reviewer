// SPDX-License-Identifier: LicenseRef-Proprietary

// An agent step that carries its settings itself instead of a `profile` (#1105, ADR 0007, release A step 1): the form (exactly one of the
// two), the rules a profile gets when it is saved (model, harness, canPush, instructions), the hosted settings (`setupScript`, `network`),
// the rules at the environment (`runner_needs_own_key`, `harness_needs_runner`, `no_runner_announces`) and the session identity.
import { describe, expect, it } from "vitest";
import { SETUP_SCRIPT_MAX_BYTES as ENVIRONMENT_SCRIPT_MAX_BYTES } from "../implementer/environments/limits.ts";
import { inlineModelsIn } from "./agent-settings.ts";
import { SETUP_SCRIPT_MAX_BYTES } from "./limits.ts";
import { BUILT_IN_CONNECTORS } from "./connectors.ts";
import type { ProfileInfo, WorkflowResolver } from "./resolver.ts";
import { validateWorkflow } from "./validate.ts";

type Json = Record<string, unknown>;

const OWN = { provider: "anthropic", model: "claude-sonnet-5-5" };
const MANAGED = { entryId: "entry-1" };

function resolver(extra: Partial<WorkflowResolver> = {}): WorkflowResolver {
  return {
    profiles: (): readonly ProfileInfo[] => [
      { name: "implementer", versions: [1], facts: { 1: { canPush: true } } },
    ],
    environments: () => [
      { name: "vm", kind: "hosted" },
      { name: "box", kind: "runner", labels: ["linux"] },
    ],
    connectors: () => BUILT_IN_CONNECTORS,
    ...extra,
  };
}

function lane(...steps: Json[]): Json {
  return {
    version: 1,
    name: "Inline",
    trigger: { kind: "github.issueLabeled", label: "ready" },
    budgetUsd: 5,
    steps,
  };
}

function step(fields: Json = {}): Json {
  return {
    id: "work",
    kind: "agent",
    model: OWN,
    canPush: true,
    environment: "vm",
    instruction: "Do it.",
    ...fields,
  };
}

function codes(document: Json, r: WorkflowResolver = resolver()): string[][] {
  return validateWorkflow(document, r).errors.map((e) => [e.path, e.code]);
}

describe("an agent step with settings of its own (#1105)", () => {
  // #1105-T01
  it("is valid with a model, canPush and an environment, and needs no profile", () => {
    expect(codes(lane(step()))).toEqual([]);
  });

  // #1105-T02
  it("takes harness, instructions, setupScript and network on a hosted environment", () => {
    const full = step({
      instructions: "Be brief.",
      setupScript: "npm ci\n",
      network: {
        mode: "list",
        hosts: ["registry.npmjs.org", "*.pythonhosted.org"],
      },
    });
    expect(codes(lane(full))).toEqual([]);
    expect(codes(lane(step({ network: { mode: "open" } })))).toEqual([]);
  });

  // #1105-T03
  it("is refused with both a profile and settings of its own, at the profile, naming the keys", () => {
    const found = validateWorkflow(
      lane(step({ profile: "implementer", instructions: "x" })),
      resolver(),
    ).errors;
    expect(found.map((e) => [e.path, e.code])).toEqual([
      ["/steps/0/profile", "profile_with_inline_settings"],
    ]);
    expect(found[0]?.message).toContain("model");
    expect(found[0]?.message).toContain("canPush");
  });

  // #1105-T04
  it("is refused with neither a profile nor settings, at the step", () => {
    expect(
      codes(
        lane({
          id: "work",
          kind: "agent",
          environment: "vm",
          instruction: "x",
        }),
      ),
    ).toEqual([["/steps/0", "agent_settings_required"]]);
  });

  // #1105-T05
  it("keeps a step that names a profile exactly as before", () => {
    expect(
      codes(
        lane({
          id: "work",
          kind: "agent",
          profile: "implementer",
          environment: "vm",
          instruction: "x",
        }),
      ),
    ).toEqual([]);
  });

  // #1105-T06
  it("needs model and canPush: each is a missing_field at its own place", () => {
    const bare = lane({
      id: "work",
      kind: "agent",
      environment: "vm",
      instruction: "x",
      instructions: "standing text",
    });
    expect(codes(bare)).toEqual([
      ["/steps/0/canPush", "missing_field"],
      ["/steps/0/model", "missing_field"],
    ]);
  });

  // #1105-T07
  it("holds the model to the two shapes of a profile's model", () => {
    expect(codes(lane(step({ model: "sonnet" })))).toEqual([
      ["/steps/0/model", "wrong_type"],
    ]);
    expect(codes(lane(step({ model: { entryId: "a", model: "b" } })))).toEqual([
      ["/steps/0/model", "invalid_value"],
    ]);
    expect(codes(lane(step({ model: { entryId: "  " } })))).toEqual([
      ["/steps/0/model", "invalid_value"],
    ]);
    expect(codes(lane(step({ model: MANAGED })))).toEqual([]);
  });

  // #1105-T08
  it("holds canPush to a boolean, the harness to the two names, and instructions to a text", () => {
    expect(codes(lane(step({ canPush: "yes" })))).toEqual([
      ["/steps/0/canPush", "wrong_type"],
    ]);
    expect(codes(lane(step({ harness: "codex" })))).toEqual([
      ["/steps/0/harness", "invalid_value"],
    ]);
    expect(codes(lane(step({ instructions: 5 })))).toEqual([
      ["/steps/0/instructions", "wrong_type"],
    ]);
    expect(codes(lane(step({ instructions: "   " })))).toEqual([
      ["/steps/0/instructions", "invalid_value"],
    ]);
    expect(codes(lane(step({ instructions: "" })))).toEqual([
      ["/steps/0/instructions", "invalid_value"],
    ]);
    expect(codes(lane(step({ instructions: "x".repeat(20_001) })))).toEqual([
      ["/steps/0/instructions", "limit_exceeded"],
    ]);
  });

  // #1105-T09
  it("keeps the claude-code provider and the harness together, as a profile does", () => {
    const login = { provider: "claude-code", model: "sonnet" };
    expect(
      codes(
        lane(
          step({ harness: "claude-code", model: login, environment: "box" }),
        ),
      ),
    ).toEqual([]);
    expect(
      codes(
        lane(step({ harness: "claude-code", model: OWN, environment: "box" })),
      ),
    ).toEqual([["/steps/0/model", "invalid_value"]]);
    expect(codes(lane(step({ model: login, environment: "box" })))).toEqual([
      ["/steps/0/model", "invalid_value"],
    ]);
  });

  // #1105-T10
  it("is refused a model the workspace cannot run, with the reason, and not on a guess", () => {
    const refusing = resolver({
      modelCheck: (model) => ("entryId" in model ? "not_allowed" : null),
    });
    const found = validateWorkflow(
      lane(step({ model: MANAGED })),
      refusing,
    ).errors;
    expect(found.map((e) => [e.path, e.code])).toEqual([
      ["/steps/0/model", "model_not_allowed"],
    ]);
    expect(found[0]?.message).toContain("not_allowed");
    expect(codes(lane(step()), refusing)).toEqual([]);
    // A resolver that did not look at the model refuses nothing; the harness on a login has no catalog to ask.
    expect(codes(lane(step({ model: MANAGED })), resolver())).toEqual([]);
    expect(
      codes(
        lane(
          step({
            harness: "claude-code",
            model: { provider: "claude-code", model: "opus" },
            environment: "box",
          }),
        ),
        resolver({ modelCheck: () => "never" }),
      ),
    ).toEqual([]);
  });

  // #1105-T11
  it("is refused a managed model on a runner (runner_needs_own_key) and a harness that is not OpenCode on a platform VM", () => {
    expect(codes(lane(step({ model: MANAGED, environment: "box" })))).toEqual([
      ["/steps/0/environment", "runner_needs_own_key"],
    ]);
    expect(codes(lane(step({ model: MANAGED })))).toEqual([]);
    expect(
      codes(
        lane(
          step({
            harness: "claude-code",
            model: { provider: "claude-code", model: "sonnet" },
          }),
        ),
      ),
    ).toEqual([["/steps/0/environment", "harness_needs_runner"]]);
  });

  // #1105-T12
  it("warns when no online runner announces what the step asks for, and says nothing without runners", () => {
    const online = resolver({
      onlineRunners: () => [
        {
          labels: ["linux"],
          access: [{ harness: "opencode", version: "1", auth: "app-key" }],
        },
      ],
    });
    const asks = lane(
      step({
        harness: "claude-code",
        model: { provider: "claude-code", model: "opus" },
        environment: "box",
      }),
    );
    const checked = validateWorkflow(asks, online);
    expect(checked.errors).toEqual([]);
    expect(checked.warnings?.map((w) => [w.path, w.code])).toEqual([
      ["/steps/0/environment", "no_runner_announces"],
    ]);
    expect(validateWorkflow(asks, resolver()).warnings ?? []).toEqual([]);
  });

  // #1105-T13
  it("names a runner or an environment: with neither it is runner_required, and an environment nobody knows is environment_unknown", () => {
    const noEnvironment = step();
    delete noEnvironment.environment;
    expect(codes(lane(noEnvironment))).toEqual([
      ["/steps/0/runner", "runner_required"],
    ]);
    expect(codes(lane(step({ environment: "nowhere" })))).toEqual([
      ["/steps/0/environment", "environment_unknown"],
    ]);
  });

  describe("setupScript and network (decision 11)", () => {
    // #1105-T14
    it("are refused in an environment that runs on a runner, each at its own place", () => {
      expect(
        codes(
          lane(
            step({
              environment: "box",
              setupScript: "make",
              network: { mode: "off" },
            }),
          ),
        ),
      ).toEqual([
        ["/steps/0/network", "hosted_only_setting"],
        ["/steps/0/setupScript", "hosted_only_setting"],
      ]);
    });

    // #1105-T15
    it("hold the script to text within 64 KB and the network rule to the rules of the environment's", () => {
      expect(codes(lane(step({ setupScript: 7 })))).toEqual([
        ["/steps/0/setupScript", "wrong_type"],
      ]);
      expect(codes(lane(step({ setupScript: "a\u0000b" })))).toEqual([
        ["/steps/0/setupScript", "invalid_value"],
      ]);
      expect(codes(lane(step({ setupScript: "x".repeat(65 * 1024) })))).toEqual(
        [["/steps/0/setupScript", "limit_exceeded"]],
      );
      expect(codes(lane(step({ network: "open" })))).toEqual([
        ["/steps/0/network", "wrong_type"],
      ]);
      expect(codes(lane(step({ network: { mode: "wide" } })))).toEqual([
        ["/steps/0/network/mode", "invalid_value"],
      ]);
      expect(codes(lane(step({ network: {} })))).toEqual([
        ["/steps/0/network/mode", "missing_field"],
      ]);
      expect(codes(lane(step({ network: { mode: "list" } })))).toEqual([
        ["/steps/0/network/hosts", "missing_field"],
      ]);
      expect(
        codes(lane(step({ network: { mode: "list", hosts: [] } }))),
      ).toEqual([["/steps/0/network/hosts", "invalid_value"]]);
      expect(
        codes(lane(step({ network: { mode: "list", hosts: ["10.0.0.1"] } }))),
      ).toEqual([["/steps/0/network/hosts/0", "network_host_invalid"]]);
      expect(
        codes(
          lane(
            step({ network: { mode: "list", hosts: ["a.com:443", 5, ""] } }),
          ),
        ),
      ).toEqual([
        ["/steps/0/network/hosts/0", "network_host_invalid"],
        ["/steps/0/network/hosts/1", "wrong_type"],
        ["/steps/0/network/hosts/2", "invalid_value"],
      ]);
      // The engine's reading (`checkNetwork`): blank entries are nothing, so a list of blanks names no host; duplicates count once.
      expect(
        codes(lane(step({ network: { mode: "list", hosts: ["  ", "\t"] } }))),
      ).toEqual([["/steps/0/network/hosts", "invalid_value"]]);
      expect(
        codes(
          lane(
            step({
              network: {
                mode: "list",
                hosts: [
                  "  ",
                  "a.example.com",
                  " A.Example.com ",
                  "a.example.com",
                ],
              },
            }),
          ),
        ),
      ).toEqual([]);
      expect(
        codes(
          lane(step({ network: { mode: "open", hosts: ["a.example.com"] } })),
        ),
      ).toEqual([["/steps/0/network/hosts", "invalid_value"]]);
      expect(codes(lane(step({ network: { mode: "off", extra: 1 } })))).toEqual(
        [["/steps/0/network/extra", "unknown_field"]],
      );
    });
  });

  describe("canPush and what the step yields", () => {
    // #1105-T16
    it("yields branch and commits only when canPush is true, and says canPush when a reference is refused", () => {
      const reads = (canPush: boolean) =>
        lane(step({ canPush }), {
          id: "pr",
          kind: "action",
          connector: "github.pullRequest.open",
          head: "{{work.branch}}",
          title: "t",
          body: "b",
        });
      expect(codes(reads(true))).toEqual([]);
      const refused = validateWorkflow(reads(false), resolver()).errors;
      expect(refused.map((e) => e.code)).toEqual([
        "reference_fact_unavailable",
      ]);
      expect(refused[0]?.message).toContain("canPush");
    });
  });

  describe("session.continue", () => {
    function continuing(second: Json): Json {
      return lane(step({ id: "first" }), {
        ...step({ id: "second" }),
        session: { continue: "first" },
        ...second,
      });
    }

    // #1105-T17
    it("is fine when the step repeats the settings of the step it continues", () => {
      expect(codes(continuing({}))).toEqual([]);
    });

    // #1105-T18
    it.each([
      ["canPush", { canPush: false }],
      ["model", { model: { provider: "anthropic", model: "other" } }],
      [
        "harness",
        {
          harness: "claude-code",
          model: { provider: "claude-code", model: "sonnet" },
          environment: "box",
        },
      ],
      ["instructions", { instructions: "different" }],
    ])("is session_target_invalid when %s differs", (what, change) => {
      const found = validateWorkflow(
        continuing(change as Json),
        resolver(),
      ).errors;
      const invalid = found.filter((e) => e.code === "session_target_invalid");
      expect(invalid.length).toBeGreaterThan(0);
      expect(invalid.map((e) => e.path)).toEqual(
        invalid.map(() => "/steps/1/session/continue"),
      );
      // The setting is named, except where the environment differs too and says so.
      if (what !== "harness") expect(invalid[0]?.message).toContain(what);
    });

    // #1105-T19
    it("is refused to mix a step with a profile and one with settings of its own", () => {
      const mixed = lane(
        {
          id: "first",
          kind: "agent",
          profile: "implementer",
          environment: "vm",
          instruction: "x",
        },
        { ...step({ id: "second" }), session: { continue: "first" } },
      );
      expect(codes(mixed)).toEqual([
        ["/steps/1/session/continue", "session_target_invalid"],
      ]);
    });
  });
});

describe("inlineModelsIn", () => {
  // #1105-T20
  it("lists the distinct models of agent steps that name no profile, nested, and respects the bound", () => {
    const document = lane(
      step({ id: "a" }),
      step({ id: "b", model: MANAGED }),
      step({ id: "c" }),
      {
        id: "loop",
        kind: "loop",
        maxRounds: 2,
        body: [step({ id: "d", model: { entryId: "e2" } })],
        until: { empty: "{{a.summary}}" },
      },
      {
        id: "p",
        kind: "agent",
        profile: "implementer",
        model: { entryId: "ignored" },
      },
    );
    expect(inlineModelsIn(document, 50)).toEqual([
      OWN,
      MANAGED,
      { entryId: "e2" },
    ]);
    expect(inlineModelsIn(document, 1)).toEqual([OWN]);
    expect(inlineModelsIn(null, 5)).toEqual([]);
  });

  // #1105-T26
  it("reads only the places steps live: an agent-shaped object in a description, an input or an unknown key is no step", () => {
    const document = {
      ...lane(step({ id: "a" })),
      description: { kind: "agent", model: MANAGED },
      extra: { kind: "agent", model: { entryId: "fake" } },
      onFailure: [step({ id: "f", model: { entryId: "cleanup" } })],
      triggers: [
        {
          kind: "github.issueLabeled",
          label: "x",
          steps: [step({ id: "pre", model: { entryId: "pre" } })],
        },
      ],
    };

    expect(inlineModelsIn(document, 50)).toEqual([
      { entryId: "pre" },
      OWN,
      { entryId: "cleanup" },
    ]);
  });
});

describe("the bounds copied from the environment", () => {
  // #1105-T21
  it("holds the setup script's bound equal to the environment's", () => {
    expect(SETUP_SCRIPT_MAX_BYTES).toBe(ENVIRONMENT_SCRIPT_MAX_BYTES);
  });
});
