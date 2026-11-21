// SPDX-License-Identifier: LicenseRef-Proprietary

// A lane names the MCP servers its agents may use, and an agent step may narrow that list (#1052, epic #1049): the validator checks the
// two lists against the servers of the workspace, and `effectiveMcpServers` is the one answer the runtime (#1053) reads.
import { describe, expect, it } from "vitest";
import { BUILT_IN_LANE_KEYS, builtInLaneDocument } from "./built-in-lanes.ts";
import { EXAMPLE_BUILT_IN_AGENTS } from "./test-fixtures.ts";
import { BUILT_IN_CONNECTORS } from "./connectors.ts";
import { isFormIssue } from "./issues.ts";
import {
  effectiveMcpServers,
  effectiveMcpServersOfStep,
  laneMcpServers,
  MCP_REFS_MAX,
  mcpServersNamedBy,
} from "./mcp.ts";
import type {
  McpServerInfo,
  ProfileInfo,
  WorkflowResolver,
} from "./resolver.ts";
import { validateWorkflow } from "./validate.ts";

type Json = Record<string, unknown>;

const GITHUB = "11111111-1111-4111-8111-111111111111";
const LINEAR = "22222222-2222-4222-8222-222222222222";
const SENTRY = "33333333-3333-4333-8333-333333333333";
const BROKEN = "44444444-4444-4444-8444-444444444444";
/** A server of ANOTHER workspace: this workspace's resolver does not list it. */
const FOREIGN = "99999999-9999-4999-8999-999999999999";

const SERVERS: McpServerInfo[] = [
  { id: GITHUB, name: "GitHub", status: "ok" },
  { id: LINEAR, name: "Linear", status: "untested" },
  { id: SENTRY, name: "Sentry", status: "ok" },
  { id: BROKEN, name: "Broken", status: "failed" },
];

function resolver(servers?: McpServerInfo[]): WorkflowResolver {
  return {
    profiles: (): readonly ProfileInfo[] => [
      {
        name: "implementer",
        versions: [1],
        facts: { 1: { canPush: true, environmentId: "env-node" } },
      },
      {
        name: "reviewer",
        versions: [1],
        facts: { 1: { canPush: false, environmentId: "env-node" } },
      },
    ],
    environments: () => [{ id: "env-node", name: "node" }],
    connectors: () => BUILT_IN_CONNECTORS,
    ...(servers === undefined ? {} : { mcpServers: () => servers }),
  };
}

function lane(
  laneMcp: unknown,
  implementMcp?: unknown,
  reviewMcp?: unknown,
): Json {
  return {
    version: 1,
    name: "With MCP",
    trigger: { kind: "github.issueLabeled", label: "ready" },
    budgetUsd: 5,
    ...(laneMcp === undefined ? {} : { mcp: laneMcp }),
    steps: [
      {
        id: "implement",
        kind: "agent",
        profile: "implementer",
        instruction: "Do it.",
        ...(implementMcp === undefined ? {} : { mcp: implementMcp }),
      },
      {
        id: "review",
        kind: "agent",
        profile: "reviewer",
        instruction: "Review it.",
        ...(reviewMcp === undefined ? {} : { mcp: reviewMcp }),
      },
    ],
  };
}

const check = (document: unknown, servers: McpServerInfo[] = SERVERS) =>
  validateWorkflow(document, resolver(servers));

const codes = (document: unknown, servers: McpServerInfo[] = SERVERS) =>
  check(document, servers).errors.map((e) => [e.path, e.code]);

describe("a lane that names MCP servers", () => {
  // #1052-T01
  it("validates with two servers and a step narrowed to one, and the step's effective list is that one", () => {
    const document = lane([GITHUB, LINEAR], [GITHUB], undefined);

    const result = check(document);

    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(laneMcpServers(document)).toEqual([GITHUB, LINEAR]);
    expect(effectiveMcpServers(document, "implement")).toEqual([GITHUB]);
    // A step that says nothing gets all of the lane's.
    expect(effectiveMcpServers(document, "review")).toEqual([GITHUB, LINEAR]);
  });

  // #1052-T01
  it("gives a step with an empty list no server at all", () => {
    const document = lane([GITHUB, LINEAR], [], undefined);

    expect(check(document).valid).toBe(true);
    expect(effectiveMcpServers(document, "implement")).toEqual([]);
    expect(effectiveMcpServers(document, "review")).toEqual([GITHUB, LINEAR]);
  });

  // #1052-T01
  it("narrows by the order of the lane's list and drops nothing the lane has", () => {
    const document = lane([GITHUB, LINEAR, SENTRY], [SENTRY, GITHUB]);

    expect(check(document).valid).toBe(true);
    expect(effectiveMcpServers(document, "implement")).toEqual([
      GITHUB,
      SENTRY,
    ]);
  });

  it("finds a step in the pre-steps of a trigger, in a loop body and in a branch", () => {
    const document = {
      version: 1,
      name: "Deep",
      triggers: [
        {
          id: "label",
          kind: "ticket.labeled",
          label: "go",
          steps: [
            {
              id: "pre",
              kind: "agent",
              profile: "reviewer",
              instruction: "Look.",
              mcp: [LINEAR],
            },
          ],
        },
      ],
      mcp: [GITHUB, LINEAR],
      steps: [
        {
          id: "again",
          kind: "loop",
          maxRounds: 2,
          body: [
            {
              id: "inner",
              kind: "agent",
              profile: "reviewer",
              instruction: "Look again.",
              mcp: [GITHUB],
              result: {
                type: "object",
                required: ["items"],
                properties: {
                  items: { type: "array", items: { type: "string" } },
                },
              },
            },
          ],
          until: { empty: "{{inner.items}}" },
        },
      ],
    };

    expect(check(document).errors).toEqual([]);
    expect(effectiveMcpServers(document, "pre")).toEqual([LINEAR]);
    expect(effectiveMcpServers(document, "inner")).toEqual([GITHUB]);
  });

  // #1052-T02
  it("refuses a server the workspace does not have, where it is written, and lists the ones it has", () => {
    const result = check(lane([GITHUB, "no-such-server"]));

    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({
      path: "/mcp/1",
      code: "mcp_server_unknown",
    });
    expect(result.errors[0]?.available).toEqual(SERVERS.map((s) => s.id));
    // The message names the servers by name, so a person can act on it.
    expect(result.errors[0]?.message).toContain("'GitHub'");
  });

  // #1052-T02
  it("refuses the server of another workspace with the same code as one that does not exist, and says nothing of the other workspace", () => {
    const foreign = check(lane([FOREIGN]));
    const absent = check(lane(["00000000-0000-4000-8000-000000000000"]));

    expect(foreign.errors.map((e) => [e.path, e.code])).toEqual([
      ["/mcp/0", "mcp_server_unknown"],
    ]);
    expect(foreign.errors[0]?.message.replace(FOREIGN, "")).toEqual(
      absent.errors[0]?.message.replace(
        "00000000-0000-4000-8000-000000000000",
        "",
      ),
    );
  });

  // #1052-T02
  it("refuses every server when the resolver knows none (a lane cannot name a server that is not there)", () => {
    expect(codes(lane([GITHUB]), [])).toEqual([
      ["/mcp/0", "mcp_server_unknown"],
    ]);
    // A resolver that does not know servers at all is the same: fail closed.
    expect(
      validateWorkflow(lane([GITHUB]), resolver(undefined)).errors.map((e) => [
        e.path,
        e.code,
      ]),
    ).toEqual([["/mcp/0", "mcp_server_unknown"]]);
  });

  // #1052-T02
  it("refuses a step that names a server the lane does not have, also one the workspace does have", () => {
    expect(codes(lane([GITHUB], [LINEAR]))).toEqual([
      ["/steps/0/mcp/0", "mcp_server_not_in_lane"],
    ]);
    expect(codes(lane([GITHUB], [GITHUB, SENTRY]))).toEqual([
      ["/steps/0/mcp/1", "mcp_server_not_in_lane"],
    ]);
  });

  // #1052-T02
  it("refuses a step's list when the lane names no server: absent is none, never everything", () => {
    expect(codes(lane(undefined, [GITHUB]))).toEqual([
      ["/steps/0/mcp/0", "mcp_server_not_in_lane"],
    ]);
    expect(codes(lane([], [GITHUB]))).toEqual([
      ["/steps/0/mcp/0", "mcp_server_not_in_lane"],
    ]);
    // An empty list needs nothing from the lane.
    expect(codes(lane(undefined, []))).toEqual([]);
  });

  // #1052-T02
  it("reports a server that is neither the lane's nor the workspace's once, as not in the lane", () => {
    expect(codes(lane([GITHUB], ["nope"]))).toEqual([
      ["/steps/0/mcp/0", "mcp_server_not_in_lane"],
    ]);
  });

  // #1052-T02
  it("holds the form: a list of texts, once each, a step's field only on an agent step", () => {
    expect(codes(lane("github"))).toEqual([["/mcp", "wrong_type"]]);
    expect(codes(lane([GITHUB, 7]))).toEqual([["/mcp/1", "wrong_type"]]);
    expect(codes(lane([GITHUB, GITHUB]))).toEqual([
      ["/mcp/1", "invalid_value"],
    ]);
    expect(codes(lane([GITHUB], GITHUB))).toEqual([
      ["/steps/0/mcp", "wrong_type"],
    ]);
    expect(codes(lane([GITHUB], [GITHUB, GITHUB]))).toEqual([
      ["/steps/0/mcp/1", "invalid_value"],
    ]);
    expect(codes(lane([""]))).toEqual([["/mcp/0", "invalid_value"]]);
    expect(
      codes({
        ...lane([GITHUB]),
        steps: [
          {
            id: "comment",
            kind: "action",
            connector: "github.issue.comment",
            issue: "{{trigger.issue}}",
            body: "x",
            mcp: [GITHUB],
          },
        ],
      }).map(([path, code]) => [path, code]),
    ).toContainEqual(["/steps/0/mcp", "unknown_field"]);
  });

  // #1052-T02
  it("holds a bound on how many servers a list names", () => {
    const many = Array.from({ length: MCP_REFS_MAX + 1 }, (_, i) => `s${i}`);

    const result = check(lane(many));

    expect(result.errors.map((e) => e.code)).toContain("limit_exceeded");
    expect(result.errors.length).toBeLessThanOrEqual(2);
  });

  // #1052-T02
  it("says a broken server is broken as a warning that does not stop a save, at the place it is named", () => {
    const result = check(lane([GITHUB, BROKEN], undefined, [BROKEN]));

    expect(result.valid).toBe(true);
    expect(result.warnings?.map((w) => [w.path, w.code])).toEqual([
      ["/mcp/1", "mcp_server_broken"],
    ]);
  });

  // #1051-T02
  it("warns about an OAuth server whose grant ended or that nobody connected, not about a connected one", () => {
    const oauth = (id: string, name: string, state: McpServerInfo["oauth"]) =>
      ({ id, name, status: "untested", oauth: state }) as McpServerInfo;
    const servers = [
      oauth(GITHUB, "Ended", "broken"),
      oauth(LINEAR, "Waiting", "unconnected"),
      oauth(SENTRY, "Fine", "connected"),
    ];

    const result = check(lane([GITHUB, LINEAR, SENTRY]), servers);

    expect(result.valid).toBe(true);
    expect(result.warnings?.map((w) => [w.path, w.code])).toEqual([
      ["/mcp/0", "mcp_server_broken"],
      ["/mcp/1", "mcp_server_broken"],
    ]);
    expect(result.warnings?.[0]?.message).toContain("Reconnect");
    expect(result.warnings?.[1]?.message).toContain("not connected");
  });

  // #1052-T02
  it("does not call a server broken that was never tested", () => {
    expect(check(lane([LINEAR])).warnings).toBeUndefined();
  });

  // #1052-T02
  it("reports every code of this check as a semantic one, and the shape errors as form errors the JSON Schema states too", () => {
    const semantic = check(lane([GITHUB, "x"], [SENTRY])).errors;
    const form = check(lane("github")).errors;

    expect(semantic.map((e) => isFormIssue(e))).toEqual([false, false]);
    expect(form.every((e) => isFormIssue(e))).toBe(true);
  });
});

describe("a lane without MCP", () => {
  // #1052-T03
  it("validates without a word about MCP, with or without the servers being listed, and gives every step none", () => {
    const document = lane(undefined);

    for (const servers of [SERVERS, [], undefined]) {
      const result = validateWorkflow(document, resolver(servers));
      expect(result.errors).toEqual([]);
      expect(result.valid).toBe(true);
      expect(result.warnings).toBeUndefined();
    }
    expect(laneMcpServers(document)).toEqual([]);
    expect(effectiveMcpServers(document, "implement")).toEqual([]);
    expect(effectiveMcpServers(document, "unknown-step")).toEqual([]);
  });

  // #1052-T03
  it("is what every built-in lane is: none of them names a server", () => {
    for (const key of BUILT_IN_LANE_KEYS) {
      const document = builtInLaneDocument(key, EXAMPLE_BUILT_IN_AGENTS);

      expect(JSON.stringify(document)).not.toContain('"mcp"');
      expect(laneMcpServers(document)).toEqual([]);
    }
  });
});

describe("the effective list of a step", () => {
  // #1052-T01
  it("is a pure function of the lane's list and the step", () => {
    expect(effectiveMcpServersOfStep([GITHUB, LINEAR], {})).toEqual([
      GITHUB,
      LINEAR,
    ]);
    expect(effectiveMcpServersOfStep([GITHUB, LINEAR], { mcp: [] })).toEqual(
      [],
    );
    expect(
      effectiveMcpServersOfStep([GITHUB, LINEAR], { mcp: [LINEAR] }),
    ).toEqual([LINEAR]);
    expect(effectiveMcpServersOfStep([], { mcp: [LINEAR] })).toEqual([]);
  });

  // #1052-T01
  it("never grants a server the lane does not have, whatever a stored document says", () => {
    expect(
      effectiveMcpServersOfStep([GITHUB], { mcp: [SENTRY, GITHUB] }),
    ).toEqual([GITHUB]);
  });

  // #1052-T01
  it("reads a document that is not what the validator saved as naming nothing", () => {
    expect(laneMcpServers(null)).toEqual([]);
    expect(laneMcpServers({ mcp: "github" })).toEqual([]);
    expect(laneMcpServers({ mcp: [GITHUB, 7, null] })).toEqual([GITHUB]);
    // A step list that is no list grants nothing: fail closed.
    expect(effectiveMcpServersOfStep([GITHUB], { mcp: "github" })).toEqual([]);
  });
});

describe("the servers a document names", () => {
  // #1052 (follow-up of #1050)
  it("are the lane's and every agent step's, once each, and only from the field `mcp` of the lane and of agent steps", () => {
    const document = {
      mcp: [GITHUB, LINEAR],
      steps: [
        {
          id: "a",
          kind: "agent",
          mcp: [LINEAR, SENTRY],
          // A property that happens to be called `mcp` in a result schema is no list of servers.
          result: {
            type: "object",
            properties: { mcp: { type: "string", description: "x" } },
          },
        },
        { id: "b", kind: "action", mcp: ["not-an-agent"] },
        {
          id: "c",
          kind: "if",
          when: {},
          then: [{ id: "d", kind: "agent", mcp: [BROKEN] }],
        },
      ],
    };

    expect(mcpServersNamedBy(document).sort()).toEqual(
      [GITHUB, LINEAR, SENTRY, BROKEN].sort(),
    );
    expect(mcpServersNamedBy(null)).toEqual([]);
    expect(mcpServersNamedBy(lane(undefined))).toEqual([]);
  });
});
