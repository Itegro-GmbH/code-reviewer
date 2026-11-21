// SPDX-License-Identifier: LicenseRef-Proprietary

// What a node says about itself (#926), for the agent step in its two forms: with a profile, and (#1105) with its settings inline.
import { describe, expect, it } from "vitest";
import { describeNode } from "./describe.ts";

describe("describing an agent step", () => {
  // #1105-T50
  it("names the profile of a step that has one, and says so when it has none yet", () => {
    expect(
      describeNode({ kind: "agent", profile: "implementer@2" }, "agent")
        .summary,
    ).toBe("implementer@2 · new session");
    expect(describeNode({ kind: "agent" }, "agent").summary).toBe(
      "no profile yet · new session",
    );
  });

  // #1105-T51
  it("describes the settings of a step that carries them: harness, model and the push right", () => {
    expect(
      describeNode(
        {
          kind: "agent",
          model: { provider: "anthropic", model: "claude-sonnet-5-5" },
          canPush: true,
        },
        "agent",
      ).summary,
    ).toBe("opencode · anthropic/claude-sonnet-5-5 · may push · new session");
    expect(
      describeNode(
        {
          kind: "agent",
          harness: "claude-code",
          model: { entryId: "entry-1" },
          canPush: false,
        },
        "agent",
      ).summary,
    ).toBe("claude-code · entry-1 · read only · new session");
  });

  // #1105-T52
  it("shows a half written inline step as far as it goes, never as a missing profile", () => {
    const summary = describeNode(
      { kind: "agent", instructions: "Be brief." },
      "agent",
    ).summary;

    expect(summary).toBe("opencode · no model yet · new session");
    expect(summary).not.toContain("no profile");
  });

  // #1105-T53
  it("reads a step with both forms as the profile form, as the validator and the engine do", () => {
    expect(
      describeNode(
        { kind: "agent", profile: "implementer", canPush: true },
        "agent",
      ).summary,
    ).toBe("implementer · new session");
  });

  // #1105-T54
  it("shows the runner of a step by its name, and the id when no name is known", () => {
    const step = {
      kind: "agent",
      model: { provider: "anthropic", model: "claude-sonnet-5-5" },
      canPush: true,
      runner: "runner-1",
    };

    expect(
      describeNode(step, "agent", { "runner-1": "Vercel Sandbox 4 vCPU" })
        .summary,
    ).toBe(
      "opencode · anthropic/claude-sonnet-5-5 · may push · on Vercel Sandbox 4 vCPU · new session",
    );
    expect(describeNode(step, "agent").summary).toContain("on runner-1");
  });
});
