// SPDX-License-Identifier: LicenseRef-Proprietary

// The concrete runner of an agent step (#1105, ADR 0007, decisions 6, 14 and 16): a step with settings of its own names a runner by id,
// and the rules a profile and an environment had together (`runner_needs_own_key`, `harness_needs_runner`, `no_runner_announces`,
// `hosted_only_setting`) are judged at that runner.
import { describe, expect, it } from "vitest";
import { BUILT_IN_CONNECTORS } from "./connectors.ts";
import type { RunnerInfo, WorkflowResolver } from "./resolver.ts";
import { validateWorkflow } from "./validate.ts";

type Json = Record<string, unknown>;

const OWN = { provider: "anthropic", model: "claude-sonnet-5-5" };
const MANAGED = { entryId: "entry-1" };
const LOGIN = { provider: "claude-code", model: "sonnet" };

const HOSTED_4: RunnerInfo = {
  id: "h-4",
  name: "Vercel Sandbox 4 vCPU",
  kind: "hosted",
};
const DEVBOX: RunnerInfo = {
  id: "r-devbox",
  name: "DevBox",
  kind: "self_hosted",
};
const OLD_BOX: RunnerInfo = {
  id: "r-old",
  name: "Old box",
  kind: "self_hosted",
  revoked: true,
};

function resolver(extra: Partial<WorkflowResolver> = {}): WorkflowResolver {
  return {
    profiles: () => [
      { name: "implementer", versions: [1], facts: { 1: { canPush: true } } },
    ],
    environments: () => [{ name: "vm", kind: "hosted" }],
    runners: () => [HOSTED_4, DEVBOX, OLD_BOX],
    connectors: () => BUILT_IN_CONNECTORS,
    ...extra,
  };
}

function lane(...steps: Json[]): Json {
  return {
    version: 1,
    name: "Runners",
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
    runner: HOSTED_4.id,
    instruction: "Do it.",
    ...fields,
  };
}

function result(document: Json, r: WorkflowResolver = resolver()) {
  return validateWorkflow(document, r);
}

function codes(document: Json, r: WorkflowResolver = resolver()): string[][] {
  return result(document, r).errors.map((e) => [e.path, e.code]);
}

describe("the runner of an agent step (#1105)", () => {
  // #1105-R01
  it("is valid on a hosted runner and on a self-hosted one, by id", () => {
    expect(codes(lane(step()))).toEqual([]);
    expect(codes(lane(step({ runner: DEVBOX.id })))).toEqual([]);
  });

  // #1105-R02
  it("is runner_unknown for an id nobody has, listing the ids that exist (hosted first) and the names in the message", () => {
    const found = result(lane(step({ runner: "nowhere" }))).errors;
    expect(found.map((e) => [e.path, e.code])).toEqual([
      ["/steps/0/runner", "runner_unknown"],
    ]);
    expect(found[0]?.available).toEqual([HOSTED_4.id, DEVBOX.id]);
    expect(found[0]?.message).toContain("Vercel Sandbox 4 vCPU");
    expect(found[0]?.message).toContain("DevBox");
  });

  // #1105-R03
  it("says to write the id when the step wrote a runner's name", () => {
    const found = result(lane(step({ runner: "devbox" }))).errors;
    expect(found.map((e) => e.code)).toEqual(["runner_unknown"]);
    expect(found[0]?.message).toContain(`write '${DEVBOX.id}'`);
  });

  // #1105-R04
  it("refuses a revoked runner, never offers it, and says it was revoked", () => {
    const found = result(lane(step({ runner: OLD_BOX.id }))).errors;
    expect(found.map((e) => [e.path, e.code])).toEqual([
      ["/steps/0/runner", "runner_unknown"],
    ]);
    expect(found[0]?.message).toContain("revoked");
    expect(found[0]?.available).not.toContain(OLD_BOX.id);
  });

  // #1105-R05
  it("fails closed when the resolver knows no runners", () => {
    const blind = resolver();
    delete (blind as { runners?: unknown }).runners;
    expect(codes(lane(step()), blind)).toEqual([
      ["/steps/0/runner", "runner_unknown"],
    ]);
  });

  // #1105-R06
  it("takes a literal id: a reference is target_from_untrusted_value, a number is a wrong type", () => {
    expect(codes(lane(step({ runner: "{{trigger.ticket.title}}" })))).toEqual([
      ["/steps/0/runner", "target_from_untrusted_value"],
    ]);
    expect(codes(lane(step({ runner: 4 })))).toEqual([
      ["/steps/0/runner", "wrong_type"],
    ]);
  });

  // #1105-R07
  it("is not together with an environment (runner_with_environment) and, with neither, is runner_required", () => {
    expect(codes(lane(step({ environment: "vm" })))).toEqual([
      ["/steps/0/environment", "runner_with_environment"],
    ]);
    const neither = step();
    delete neither.runner;
    const found = result(lane(neither)).errors;
    expect(found.map((e) => [e.path, e.code])).toEqual([
      ["/steps/0/runner", "runner_required"],
    ]);
    expect(found[0]?.available).toEqual([HOSTED_4.id, DEVBOX.id]);
  });

  // #1105-R08
  it("is a setting of the step itself: with a profile it is profile_with_inline_settings", () => {
    expect(
      codes(
        lane({
          id: "work",
          kind: "agent",
          profile: "implementer",
          runner: HOSTED_4.id,
          instruction: "x",
        }),
      ),
    ).toContainEqual(["/steps/0/profile", "profile_with_inline_settings"]);
  });

  // #1105-R09
  it("takes setupScript and network on a hosted runner and refuses them on a self-hosted one (hosted_only_setting)", () => {
    const extras = { setupScript: "npm ci\n", network: { mode: "open" } };
    expect(codes(lane(step(extras)))).toEqual([]);
    expect(codes(lane(step({ ...extras, runner: DEVBOX.id })))).toEqual([
      ["/steps/0/network", "hosted_only_setting"],
      ["/steps/0/setupScript", "hosted_only_setting"],
    ]);
  });

  // #1105-R10
  it("holds a managed model to a hosted runner (runner_needs_own_key on a self-hosted one)", () => {
    expect(codes(lane(step({ model: MANAGED })))).toEqual([]);
    expect(codes(lane(step({ model: MANAGED, runner: DEVBOX.id })))).toEqual([
      ["/steps/0/runner", "runner_needs_own_key"],
    ]);
  });

  // #1105-R11
  it("holds a harness that is not OpenCode to a self-hosted runner (harness_needs_runner on a hosted one)", () => {
    const claude = { harness: "claude-code", model: LOGIN };
    expect(codes(lane(step({ ...claude, runner: DEVBOX.id })))).toEqual([]);
    expect(codes(lane(step(claude)))).toEqual([
      ["/steps/0/runner", "harness_needs_runner"],
    ]);
  });

  // #1105-R12
  it("warns when the runner is online and does not announce what the step asks for, over its own announcement", () => {
    const asks = lane(
      step({ harness: "claude-code", model: LOGIN, runner: DEVBOX.id }),
    );
    const online = (id: string) =>
      resolver({
        onlineRunners: () => [
          {
            id,
            labels: ["linux"],
            access: [{ harness: "opencode", version: "1", auth: "app-key" }],
          },
        ],
      });
    const checked = result(asks, online(DEVBOX.id));
    expect(checked.errors).toEqual([]);
    expect(checked.warnings?.map((w) => [w.path, w.code])).toEqual([
      ["/steps/0/runner", "no_runner_announces"],
    ]);
    // Another runner announcing it says nothing about this one; none online says nothing at all.
    expect(result(asks, online("other")).warnings ?? []).toEqual([]);
    expect(result(asks, resolver()).warnings ?? []).toEqual([]);
  });

  // #1105-R13
  it("keeps a session on one runner: a step that continues it names the same runner", () => {
    const first = step({ id: "first" });
    const second = step({ id: "second", session: { continue: "first" } });
    expect(codes(lane(first, second))).toEqual([]);
    const elsewhere = step({
      id: "second",
      session: { continue: "first" },
      runner: DEVBOX.id,
      model: OWN,
    });
    expect(codes(lane(first, elsewhere))).toEqual([
      ["/steps/1/session/continue", "session_target_invalid"],
    ]);
  });

  // #1105-R14
  it("leaves a step that names an environment as before", () => {
    const old = step({ environment: "vm" });
    delete old.runner;
    expect(codes(lane(old))).toEqual([]);
  });
});
