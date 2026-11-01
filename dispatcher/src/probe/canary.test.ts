// SPDX-License-Identifier: LicenseRef-Proprietary

import { describe, expect, it } from "vitest";
import type { Clock } from "../core/types.ts";
import { DISPATCHER_TOKEN } from "../test-support/harness.ts";
import { parseCanaryArguments, runCanary } from "./canary.ts";

type Seen = {
  url: string;
  method: string;
  headers: Headers;
  redirect: Request["redirect"];
};

function script(handler: (request: Seen) => Response | Promise<Response>): {
  fetch: typeof fetch;
  seen: Seen[];
} {
  const seen: Seen[] = [];
  return {
    seen,
    fetch: async (input, init) => {
      const request = new Request(input, init);
      const entry = {
        url: request.url,
        method: request.method,
        headers: request.headers,
        redirect: request.redirect,
      };
      seen.push(entry);
      return handler(entry);
    },
  };
}

/** Time does not pass in a test: every wait ends at once, the number of tries is what counts. */
const instantClock: Clock = { sleep: () => Promise.resolve() };

const REPORT = {
  version: 1,
  status: "passed",
  ok: true,
  engines: ["pr-agent", "opencode"],
  reasons: [],
  checkedAt: "2026-10-15T12:00:00.000Z",
};

function respond(report: unknown, status = 200): Response {
  return new Response(JSON.stringify(report), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Answers /health with 200 and /probe with the given response. */
function deployment(probe: () => Response | Promise<Response>) {
  return script((request) =>
    request.url.endsWith("/health") ? respond({ status: "ok" }) : probe(),
  );
}

function options(
  fetchImplementation: typeof fetch,
  extra: Partial<Parameters<typeof runCanary>[0]> = {},
) {
  const lines: string[] = [];
  return {
    lines,
    run: () =>
      runCanary({
        url: "https://dispatcher.example",
        token: DISPATCHER_TOKEN,
        fetch: fetchImplementation,
        clock: instantClock,
        write: (line) => lines.push(line),
        ...extra,
      }),
  };
}

describe("the deploy canary", () => {
  // #331-T01
  it("passes when the deployment's canary passed and advertises both engines", async () => {
    const { fetch, seen } = deployment(() => respond(REPORT));
    const { run, lines } = options(fetch);

    expect(await run()).toBe(0);

    const probe = seen.find((request) => request.url.endsWith("/probe"));
    expect(probe?.method).toBe("POST");
    expect(probe?.url).toBe("https://dispatcher.example/probe");
    expect(probe?.headers.get("authorization")).toBe(
      `Bearer ${DISPATCHER_TOKEN}`,
    );
    expect(lines.join("\n")).toContain("passed");
    expect(lines.join("\n")).not.toContain(DISPATCHER_TOKEN);
  });

  // #331-T02
  it("blocks the release when the canary was denied, and names the stable reasons only", async () => {
    const denied = {
      ...REPORT,
      status: "denied",
      ok: false,
      engines: ["pr-agent"],
      reasons: [
        "ipv6_not_disabled",
        "ghp_" + "0123456789abcdef0123456789abcdef0123",
      ],
      detail: "text the Dispatcher would never send",
    };
    const { fetch } = deployment(() => respond(denied, 503));
    const { run, lines } = options(fetch);

    expect(await run()).toBe(1);

    const text = lines.join("\n");
    expect(text).toContain("denied");
    expect(text).toContain("ipv6_not_disabled");
    expect(text).not.toContain("ghp_");
    expect(text).not.toContain("never send");
  });

  // #331-T02
  it("blocks the release when the canary could not run, with the failure code", async () => {
    const failed = {
      ...REPORT,
      status: "failed",
      ok: false,
      engines: ["pr-agent"],
      failure: "probe_timeout",
    };
    const { fetch } = deployment(() => respond(failed, 503));
    const { run, lines } = options(fetch);

    expect(await run()).toBe(1);
    expect(lines.join("\n")).toContain("probe_timeout");
  });

  // #331-T02
  it("blocks the release when a deployment that is not configured for Dynamic is asked to prove it", async () => {
    const diffOnly = {
      ...REPORT,
      engines: ["pr-agent"],
      status: "denied",
      ok: true,
      reasons: ["not_a_dynamic_runner"],
    };
    const { fetch } = deployment(() => respond(diffOnly));

    expect(await options(fetch).run()).toBe(1);
  });

  // #331-T01
  it("passes a Diff-only deployment when only PR-Agent is required", async () => {
    const diffOnly = {
      ...REPORT,
      engines: ["pr-agent"],
      status: "denied",
      ok: true,
      reasons: ["not_a_dynamic_runner"],
    };
    const { fetch } = deployment(() => respond(diffOnly));

    expect(await options(fetch, { requiredEngines: ["pr-agent"] }).run()).toBe(
      0,
    );
  });

  // #759-T20
  it("says which engine the route required and the report lacks when it blocks", async () => {
    const { fetch } = deployment(() =>
      respond(
        {
          ...REPORT,
          ok: false,
          engines: ["pr-agent"],
          required: ["pr-agent", "opencode", "implementer"],
        },
        503,
      ),
    );
    const { run, lines } = options(fetch, { requiredEngines: ["pr-agent"] });

    expect(await run()).toBe(1);
    expect(lines.join("\n")).toContain("missing=opencode,implementer");
  });

  // #759-T20
  it("prints only engines it knows from the required list of the answer", async () => {
    const { fetch } = deployment(() =>
      respond(
        {
          ...REPORT,
          ok: false,
          required: ["implementer", "dummy-token-1234567890"],
        },
        503,
      ),
    );
    const { run, lines } = options(fetch);

    expect(await run()).toBe(1);
    const output = lines.join("\n");
    expect(output).toContain("missing=implementer");
    expect(output).not.toContain("dummy-token-1234567890");
  });

  // #331-T05
  it("blocks the release on a refused credential without saying more than the status", async () => {
    const { fetch } = deployment(() =>
      respond(
        {
          error: {
            code: "RUNNER_UNAUTHORIZED",
            message: "The request could not be verified.",
          },
        },
        401,
      ),
    );
    const { run, lines } = options(fetch);

    expect(await run()).toBe(1);
    expect(lines.join("\n")).toContain("401");
  });

  // #331-T08
  it.each([
    [
      "an answer that is not JSON",
      () => new Response("<html>login</html>", { status: 200 }),
    ],
    ["JSON of another shape", () => respond({ hello: "world" })],
    [
      "a report that says ok and advertises nothing",
      () => respond({ ...REPORT, engines: [] }),
    ],
    [
      "a redirect",
      () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://elsewhere.example/probe" },
        }),
    ],
  ])("blocks the release on %s", async (_name, answer) => {
    const { fetch, seen } = deployment(answer);

    expect(await options(fetch).run()).toBe(1);
    expect(seen.map((request) => new URL(request.url).host)).toStrictEqual([
      "dispatcher.example",
      "dispatcher.example",
    ]);
  });

  // #331-T02
  it("blocks the release when the deployment cannot be reached", async () => {
    const { run, lines } = options(() =>
      Promise.reject(new Error("connect ECONNREFUSED 10.0.0.1:443")),
    );

    expect(await run()).toBe(1);
    expect(lines.join("\n")).toContain("deployment_not_ready");
    expect(lines.join("\n")).not.toContain("10.0.0.1");
  });

  // #331-T02
  it("waits for the new deployment to answer before it sends the credential, and never sends it to /health", async () => {
    let health = 0;
    const { fetch, seen } = script((request) => {
      if (request.url.endsWith("/health")) {
        health += 1;
        return health < 3
          ? new Response("not yet", { status: 404 })
          : respond({ status: "ok" });
      }
      return respond(REPORT);
    });
    const { run } = options(fetch, { healthWaitSeconds: 60 });

    expect(await run()).toBe(0);

    expect(health).toBe(3);
    for (const request of seen.filter((entry) => entry.url.endsWith("/health")))
      expect(request.headers.get("authorization")).toBeNull();
  });

  // #331-T05
  it("sends no credential when the deployment never answers", async () => {
    const { fetch, seen } = script(() => new Response("no", { status: 404 }));

    expect(await options(fetch, { healthWaitSeconds: 20 }).run()).toBe(1);

    expect(
      seen.every((request) => request.headers.get("authorization") === null),
    ).toBe(true);
    expect(seen.some((request) => request.url.endsWith("/probe"))).toBe(false);
  });

  // #331-T05
  it("does not send the credential over plain http, except to this machine", async () => {
    const { fetch, seen } = deployment(() => respond(REPORT));

    expect(
      await options(fetch, { url: "http://dispatcher.example" }).run(),
    ).toBe(2);
    expect(seen).toStrictEqual([]);
    expect(await options(fetch, { url: "http://127.0.0.1:8080" }).run()).toBe(
      0,
    );
  });

  // #331-T02
  it("passes the deployment-protection bypass secret as a header and never prints it", async () => {
    const { fetch, seen } = deployment(() => respond(REPORT));
    const { run, lines } = options(fetch, {
      bypassSecret: "dummy-bypass-secret-value",
    });

    await run();

    expect(
      seen.every(
        (request) =>
          request.headers.get("x-vercel-protection-bypass") ===
          "dummy-bypass-secret-value",
      ),
    ).toBe(true);
    expect(lines.join("\n")).not.toContain("dummy-bypass-secret-value");
  });
});

describe("the host allow-list of the deploy canary", () => {
  // #331-R01
  it("sends nothing to a host that is not on the list, not even to /health", async () => {
    const { fetch, seen } = deployment(() => respond(REPORT));
    const { run, lines } = options(fetch, {
      url: "https://evil.example",
      allowedHosts: ["dispatcher.example"],
    });

    expect(await run()).toBe(2);

    expect(seen).toStrictEqual([]);
    expect(lines.join("\n")).toContain("canary_host_not_allowed");
    expect(lines.join("\n")).not.toContain(DISPATCHER_TOKEN);
  });

  // #331-R01
  it("sends to a host on the list, whatever its letter case or port", async () => {
    const { fetch, seen } = deployment(() => respond(REPORT));

    expect(
      await options(fetch, {
        url: "https://Dispatcher.Example:8443",
        allowedHosts: ["dispatcher.example"],
      }).run(),
    ).toBe(0);
    expect(seen.length).toBeGreaterThan(0);
  });

  // #331-R01
  it.each([
    "https://dispatcher.example.evil.example",
    "https://evil.example/dispatcher.example",
    "https://sub.dispatcher.example",
    "https://dispatcher.example@evil.example",
    "https://evil.example#dispatcher.example",
  ])("does not take %s for a listed host", async (url) => {
    const { fetch, seen } = deployment(() => respond(REPORT));

    expect(
      await options(fetch, { url, allowedHosts: ["dispatcher.example"] }).run(),
    ).toBe(2);
    expect(seen).toStrictEqual([]);
  });

  // #331-R01
  it("also holds this machine to the list when there is one", async () => {
    const { fetch, seen } = deployment(() => respond(REPORT));

    expect(
      await options(fetch, {
        url: "http://127.0.0.1:8080",
        allowedHosts: ["dispatcher.example"],
      }).run(),
    ).toBe(2);
    expect(seen).toStrictEqual([]);
  });

  // #331-R01
  it("with an empty list refuses every host: a list that was meant and is empty is a mistake", async () => {
    const { fetch, seen } = deployment(() => respond(REPORT));

    expect(await options(fetch, { allowedHosts: [] }).run()).toBe(2);
    expect(seen).toStrictEqual([]);
  });

  // #331-R01
  it("checks the URL against the list without a credential and without a request", async () => {
    const { fetch, seen } = deployment(() => respond(REPORT));

    expect(
      await options(fetch, {
        token: "",
        checkOnly: true,
        allowedHosts: ["dispatcher.example"],
      }).run(),
    ).toBe(0);
    expect(
      await options(fetch, {
        token: "",
        checkOnly: true,
        url: "https://evil.example",
        allowedHosts: ["dispatcher.example"],
      }).run(),
    ).toBe(2);
    expect(seen).toStrictEqual([]);
  });

  // #331-R04
  it("prints a failure code only from the closed list", async () => {
    const failed = {
      ...REPORT,
      status: "failed",
      ok: false,
      engines: ["pr-agent"],
      failure: "a1b2c3d4e5f6a1b2c3d4",
    };
    const { fetch } = deployment(() => respond(failed, 503));
    const { run, lines } = options(fetch);

    expect(await run()).toBe(1);

    expect(lines.join("\n")).toContain("failure=probe_error");
    expect(lines.join("\n")).not.toContain("a1b2c3d4");
  });
});

const VERCEL_TOKEN = "vercel-token-not-a-real-one-0123456789";
const TEAM = "team_exampleTeam0001";
const PROJECT = "prj_exampleDispatcher0001";
const STAGED_HOST = "dispatcher-abc123-example-team.vercel.app";
const VERIFY = { token: VERCEL_TOKEN, teamId: TEAM, projectId: PROJECT };
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const DIGEST = `sha256:${"b".repeat(64)}`;

/** What the platform answers for a deployment of the Dispatcher project: the fields the check reads. */
function deploymentRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: "dpl_example0001",
    url: STAGED_HOST,
    projectId: PROJECT,
    ownerId: TEAM,
    readyState: "READY",
    target: "production",
    meta: { githubCommitSha: COMMIT },
    ...overrides,
  };
}

/** The platform answers `api`; the staged deployment answers like a healthy Dispatcher. */
function platformAndDeployment(api: () => Response | Promise<Response>) {
  return script((request) => {
    if (new URL(request.url).hostname === "api.vercel.com") return api();
    return request.url.endsWith("/health")
      ? respond({ status: "ok" })
      : respond(REPORT);
  });
}

function stagedOptions(
  fetchImplementation: typeof fetch,
  extra: Partial<Parameters<typeof runCanary>[0]> = {},
) {
  return options(fetchImplementation, {
    url: `https://${STAGED_HOST}`,
    verifyDeployment: VERIFY,
    ...extra,
  });
}

describe("the deployment check of the deploy canary", () => {
  // #403-T01
  it("sends the credential to a staged deployment the platform says belongs to the Dispatcher project and team", async () => {
    const { fetch, seen } = platformAndDeployment(() =>
      respond(deploymentRecord()),
    );
    const { run, lines } = stagedOptions(fetch);

    expect(await run()).toBe(0);

    // The platform is asked first, and before any request reaches the deployment.
    expect(new URL(seen[0]?.url ?? "").hostname).toBe("api.vercel.com");
    expect(new URL(seen[0]?.url ?? "").pathname).toBe(
      `/v13/deployments/${STAGED_HOST}`,
    );
    expect(new URL(seen[0]?.url ?? "").searchParams.get("teamId")).toBe(TEAM);
    expect(seen[0]?.method).toBe("GET");
    expect(seen[0]?.headers.get("authorization")).toBe(
      `Bearer ${VERCEL_TOKEN}`,
    );
    expect(
      seen.filter(
        (request) => new URL(request.url).hostname === "api.vercel.com",
      ),
    ).toHaveLength(1);
    const probe = seen.find((request) => request.url.endsWith("/probe"));
    expect(probe?.headers.get("authorization")).toBe(
      `Bearer ${DISPATCHER_TOKEN}`,
    );
    // No redirect is followed, whoever answers: a redirect would carry the bypass header to another origin.
    expect(seen.map((request) => request.redirect)).toEqual(
      seen.map(() => "manual"),
    );
    expect(seen.length).toBeGreaterThanOrEqual(3);
    // Each credential goes to its own host only.
    for (const request of seen) {
      const toPlatform = new URL(request.url).hostname === "api.vercel.com";
      const sent = [...request.headers.values()].join(" ");
      expect(sent.includes(VERCEL_TOKEN), request.url).toBe(toPlatform);
      expect(sent.includes(DISPATCHER_TOKEN), request.url).toBe(
        request.url.endsWith("/probe"),
      );
    }
    expect(lines.join("\n")).not.toContain(VERCEL_TOKEN);
    expect(lines.join("\n")).not.toContain(DISPATCHER_TOKEN);
  });

  // #403-T01
  it("compares the host case-insensitively", async () => {
    const { fetch } = platformAndDeployment(() =>
      respond(deploymentRecord({ url: STAGED_HOST.toUpperCase() })),
    );
    const { run } = stagedOptions(fetch);

    expect(await run()).toBe(0);
  });

  // #403-T02
  it.each([
    ["another project", { projectId: "prj_someoneElse" }],
    ["another team", { ownerId: "team_someoneElse" }],
    ["a record without a project", { projectId: undefined }],
    ["a record without an owner", { ownerId: undefined }],
    [
      "an alias, whose deployment has another host",
      { url: "other-abc.vercel.app" },
    ],
    ["a record without a host", { url: undefined }],
    ["a preview deployment", { target: null }],
    ["a staged deployment of no target", { target: undefined }],
    ["a deployment that is still building", { readyState: "BUILDING" }],
    ["a deployment that failed", { readyState: "ERROR" }],
  ])(
    "refuses a deployment of %s and sends nothing to it",
    async (_name, overrides) => {
      const { fetch, seen } = platformAndDeployment(() =>
        respond(deploymentRecord(overrides)),
      );
      const { run, lines } = stagedOptions(fetch);

      expect(await run()).toBe(2);

      expect(lines.join("\n")).toContain("canary_deployment_not_verified");
      expect(
        seen.filter(
          (request) => new URL(request.url).hostname !== "api.vercel.com",
        ),
      ).toEqual([]);
      expect(lines.join("\n")).not.toContain(VERCEL_TOKEN);
      expect(lines.join("\n")).not.toContain(PROJECT);
      expect(lines.join("\n")).not.toContain(TEAM);
    },
  );

  // #403-T02
  it.each([
    ["not found", () => respond({ error: { code: "not_found" } }, 404)],
    ["forbidden", () => respond({ error: { code: "forbidden" } }, 403)],
    [
      "a redirect",
      () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://elsewhere.example/" },
        }),
    ],
    ["not JSON", () => new Response("<html>", { status: 200 })],
    ["an array", () => respond([deploymentRecord()])],
  ])(
    "does not accept the host when the platform answers %s, and sends nothing to it",
    async (_name, answer) => {
      const { fetch, seen } = platformAndDeployment(answer);
      const { run, lines } = stagedOptions(fetch);

      expect(await run()).toBe(2);

      expect(lines.join("\n")).toContain("canary_deployment_not_verified");
      expect(
        seen.filter(
          (request) => new URL(request.url).hostname !== "api.vercel.com",
        ),
      ).toEqual([]);
    },
  );

  // #403-T02
  it("blocks, without a word of the error, when the platform cannot be reached, and sends nothing to the deployment", async () => {
    const { fetch, seen } = platformAndDeployment(() => {
      throw new Error(`connect ECONNREFUSED ${VERCEL_TOKEN}`);
    });
    const { run, lines } = stagedOptions(fetch);

    expect(await run()).toBe(1);

    expect(lines.join("\n")).toContain("canary_verification_unavailable");
    expect(lines.join("\n")).not.toContain("ECONNREFUSED");
    expect(lines.join("\n")).not.toContain(VERCEL_TOKEN);
    expect(
      seen.filter(
        (request) => new URL(request.url).hostname !== "api.vercel.com",
      ),
    ).toEqual([]);
  });

  // #403-T02
  it.each([
    ["http", `http://${STAGED_HOST}`],
    ["this machine", "http://localhost:3000"],
    ["a port", `https://${STAGED_HOST}:8443`],
    ["a path", `https://${STAGED_HOST}/probe`],
    ["credentials in the URL", `https://user:pw@${STAGED_HOST}`],
    ["not a URL", "dispatcher"],
  ])(
    "refuses a URL with %s before it asks the platform or sends anything",
    async (_name, url) => {
      const { fetch, seen } = platformAndDeployment(() =>
        respond(deploymentRecord()),
      );
      const { run } = stagedOptions(fetch, { url });

      expect(await run()).toBe(2);

      expect(seen).toEqual([]);
    },
  );

  // #403-T03
  it("holds a URL to the list of hosts and to the platform's answer when both are given", async () => {
    const { fetch, seen } = platformAndDeployment(() =>
      respond(deploymentRecord()),
    );
    const { run, lines } = stagedOptions(fetch, {
      allowedHosts: ["another.example"],
    });

    expect(await run()).toBe(2);

    expect(lines.join("\n")).toContain("canary_host_not_allowed");
    expect(seen).toEqual([]);
  });

  // #403-T03
  it("checks only: asks the platform, sends no credential to the deployment and needs no probe", async () => {
    const { fetch, seen } = platformAndDeployment(() =>
      respond(deploymentRecord()),
    );
    const { run, lines } = stagedOptions(fetch, { checkOnly: true, token: "" });

    expect(await run()).toBe(0);

    expect(lines.join("\n")).toContain("the URL is allowed");
    expect(seen).toHaveLength(1);
    expect(new URL(seen[0]?.url ?? "").hostname).toBe("api.vercel.com");
  });

  // #403-T03
  it("without the check keeps working as before for a person at a terminal", async () => {
    const { fetch, seen } = deployment(() => respond(REPORT));
    const { run } = options(fetch);

    expect(await run()).toBe(0);

    expect(
      seen.some(
        (request) => new URL(request.url).hostname === "api.vercel.com",
      ),
    ).toBe(false);
  });
});

describe("the commit and the retries of the deployment check", () => {
  // #403-T01
  it("accepts a deployment built from the commit this run expects", async () => {
    const { fetch } = platformAndDeployment(() => respond(deploymentRecord()));
    const { run } = stagedOptions(fetch, {
      verifyDeployment: { ...VERIFY, expectedCommit: COMMIT },
    });

    expect(await run()).toBe(0);
  });

  // #403-T02
  it.each([
    ["another commit", { meta: { githubCommitSha: "f".repeat(40) } }],
    ["no commit", { meta: {} }],
    ["no meta", { meta: undefined }],
  ])(
    "refuses a deployment with %s when a commit is expected, and sends nothing to it",
    async (_name, overrides) => {
      const { fetch, seen } = platformAndDeployment(() =>
        respond(deploymentRecord(overrides)),
      );
      const { run, lines } = stagedOptions(fetch, {
        verifyDeployment: { ...VERIFY, expectedCommit: COMMIT },
      });

      expect(await run()).toBe(2);

      expect(lines.join("\n")).toContain("canary_deployment_not_verified");
      expect(lines.join("\n")).not.toContain(COMMIT);
      expect(
        seen.filter(
          (request) => new URL(request.url).hostname !== "api.vercel.com",
        ),
      ).toEqual([]);
    },
  );

  // #403-T02
  it("asks again after a 429 or a 5xx of the platform, and goes on when it answers", async () => {
    const answers = [
      () => respond({}, 429),
      () => respond({}, 503),
      () => respond(deploymentRecord()),
    ];
    let call = 0;
    const { fetch, seen } = platformAndDeployment(() =>
      (answers[call++] ?? answers[2])!(),
    );
    const { run } = stagedOptions(fetch);

    expect(await run()).toBe(0);

    expect(
      seen.filter(
        (request) => new URL(request.url).hostname === "api.vercel.com",
      ),
    ).toHaveLength(3);
  });

  // #403-T02
  it.each([429, 500, 502, 503])(
    "reports a platform that keeps answering %s as unavailable (exit 1), not as a wrong deployment",
    async (status) => {
      const { fetch, seen } = platformAndDeployment(() => respond({}, status));
      const { run, lines } = stagedOptions(fetch);

      expect(await run()).toBe(1);

      expect(lines.join("\n")).toContain("canary_verification_unavailable");
      expect(lines.join("\n")).not.toContain("not_verified");
      expect(
        seen.filter(
          (request) => new URL(request.url).hostname !== "api.vercel.com",
        ),
      ).toEqual([]);
    },
  );

  // #403-T02
  it.each([401, 403, 404])(
    "does not ask again after a %s: that is an answer",
    async (status) => {
      const { fetch, seen } = platformAndDeployment(() => respond({}, status));
      const { run } = stagedOptions(fetch);

      expect(await run()).toBe(2);

      expect(
        seen.filter(
          (request) => new URL(request.url).hostname === "api.vercel.com",
        ),
      ).toHaveLength(1);
    },
  );
});

const SNAPSHOT = "snap_example01";

describe("the whole pair the canary proves", () => {
  function reporting(report: unknown) {
    return script((request) =>
      request.url.endsWith("/health")
        ? respond({ status: "ok" })
        : respond(report),
    );
  }
  const expected = {
    expectedImageDigest: DIGEST,
    expectedSnapshotId: SNAPSHOT,
  };

  // #403-T12
  it("passes when the report names both the snapshot and the image of the run", async () => {
    const { fetch } = reporting({
      ...REPORT,
      imageDigest: DIGEST,
      snapshotId: SNAPSHOT,
    });
    const { run, lines } = options(fetch, expected);

    expect(await run()).toBe(0);
    expect(lines.join("\n")).not.toContain(SNAPSHOT);
  });

  // #403-T12
  it.each([
    [
      "another snapshot with the same image (a rebuild of the same layers)",
      { imageDigest: DIGEST, snapshotId: "snap_other02" },
    ],
    ["no snapshot", { imageDigest: DIGEST }],
    [
      "the snapshot of the run on another image",
      { imageDigest: `sha256:${"c".repeat(64)}`, snapshotId: SNAPSHOT },
    ],
  ])(
    "blocks the release when the report names %s, without printing an id",
    async (_name, fields) => {
      const { fetch } = reporting({ ...REPORT, ...fields });
      const { run, lines } = options(fetch, expected);

      expect(await run()).toBe(1);

      const text = lines.join("\n");
      expect(text).toContain("canary_image_mismatch");
      expect(text).not.toContain(SNAPSHOT);
      expect(text).not.toContain("snap_other02");
    },
  );

  // #403-T12
  it("checks the snapshot alone when only that is expected", async () => {
    const { fetch } = reporting({ ...REPORT, snapshotId: SNAPSHOT });

    expect(await options(fetch, { expectedSnapshotId: SNAPSHOT }).run()).toBe(
      0,
    );
    expect(
      await options(fetch, { expectedSnapshotId: "snap_other02" }).run(),
    ).toBe(1);
  });
});

describe("the image id the canary proves", () => {
  function reporting(report: unknown) {
    return script((request) =>
      request.url.endsWith("/health")
        ? respond({ status: "ok" })
        : respond(report),
    );
  }

  // #403-T12
  it("passes when the deployment's report names the image the run built", async () => {
    const { fetch } = reporting({ ...REPORT, imageDigest: DIGEST });
    const { run, lines } = options(fetch, { expectedImageDigest: DIGEST });

    expect(await run()).toBe(0);

    expect(lines.join("\n")).not.toContain(DIGEST);
  });

  // #403-T12
  it.each([
    ["another image", { ...REPORT, imageDigest: `sha256:${"c".repeat(64)}` }],
    ["no image", REPORT],
  ])(
    "blocks the release when the report names %s, without printing either id",
    async (_name, report) => {
      const { fetch } = reporting(report);
      const { run, lines } = options(fetch, { expectedImageDigest: DIGEST });

      expect(await run()).toBe(1);

      const text = lines.join("\n");
      expect(text).toContain("canary_image_mismatch");
      expect(text).not.toContain(DIGEST);
      expect(text).not.toContain("c".repeat(64));
    },
  );

  // #403-T12
  it("does not look at the image when none is expected", async () => {
    const { fetch } = reporting({ ...REPORT, imageDigest: DIGEST });
    const { run } = options(fetch);

    expect(await run()).toBe(0);
  });

  // #403-T12
  it("blocks on a mismatch even when the probe itself passed", async () => {
    const { fetch } = reporting({ ...REPORT, imageDigest: "sha256:zz" });
    const { run } = options(fetch, { expectedImageDigest: DIGEST });

    expect(await run()).toBe(1);
  });
});

describe("the arguments of the deployment check", () => {
  const env = {
    RUNNER_TOKEN: "dummy-token-1234567890",
    VERCEL_TOKEN,
    VERCEL_TEAM_ID: TEAM,
    VERCEL_PROJECT_ID: PROJECT,
  };

  // #403-T03
  it("turns the check on with --verify-vercel and reads the three values from the environment", () => {
    expect(
      parseCanaryArguments(
        ["--url", `https://${STAGED_HOST}`, "--verify-vercel"],
        env,
      ).verifyDeployment,
    ).toStrictEqual(VERIFY);
    expect(
      parseCanaryArguments(["--url", `https://${STAGED_HOST}`], env)
        .verifyDeployment,
    ).toBeUndefined();
  });

  // #403-T03
  it.each(["VERCEL_TOKEN", "VERCEL_TEAM_ID", "VERCEL_PROJECT_ID"])(
    "refuses --verify-vercel without %s, naming it",
    (name) => {
      expect(() =>
        parseCanaryArguments(
          ["--url", `https://${STAGED_HOST}`, "--verify-vercel"],
          { ...env, [name]: "" },
        ),
      ).toThrow(new RegExp(name));
    },
  );

  // #403-T01
  it("takes the commit to expect from --expect-commit, and the image id from the environment", () => {
    const parsed = parseCanaryArguments(
      [
        "--url",
        `https://${STAGED_HOST}`,
        "--verify-vercel",
        "--expect-commit",
        COMMIT,
      ],
      { ...env, CANARY_EXPECT_IMAGE_DIGEST: DIGEST },
    );

    expect(parsed.verifyDeployment).toStrictEqual({
      ...VERIFY,
      expectedCommit: COMMIT,
    });
    expect(parsed.expectedImageDigest).toBe(DIGEST);
  });

  // #403-T01
  it.each(["not-a-sha", "ABCDEF", "g".repeat(40), ""])(
    "refuses %j as the commit to expect, without echoing it",
    (value) => {
      expect(() =>
        parseCanaryArguments(
          [
            "--url",
            `https://${STAGED_HOST}`,
            "--verify-vercel",
            "--expect-commit",
            value,
          ],
          env,
        ),
      ).toThrow(/expect-commit/);
    },
  );

  // #403-T12
  it("takes the snapshot id to expect from the environment, and refuses one that is not an id", () => {
    expect(
      parseCanaryArguments(["--url", `https://${STAGED_HOST}`], {
        ...env,
        CANARY_EXPECT_SNAPSHOT_ID: SNAPSHOT,
      }).expectedSnapshotId,
    ).toBe(SNAPSHOT);
    expect(() =>
      parseCanaryArguments(["--url", `https://${STAGED_HOST}`], {
        ...env,
        CANARY_EXPECT_SNAPSHOT_ID: "snap x",
      }),
    ).toThrow(/CANARY_EXPECT_SNAPSHOT_ID/);
  });

  // #403-T12
  it("refuses an image id that is not one", () => {
    expect(() =>
      parseCanaryArguments(["--url", `https://${STAGED_HOST}`], {
        ...env,
        CANARY_EXPECT_IMAGE_DIGEST: "latest",
      }),
    ).toThrow(/CANARY_EXPECT_IMAGE_DIGEST/);
  });

  // #403-T03
  it("takes no argument for the three values: they would show up in process lists and logs", () => {
    expect(() =>
      parseCanaryArguments(
        ["--url", `https://${STAGED_HOST}`, "--vercel-token", "x"],
        env,
      ),
    ).toThrow();
  });
});

describe("the arguments of the deploy canary", () => {
  it("takes the URL and reads the credential from the environment, never from an argument", () => {
    expect(
      parseCanaryArguments(["--url", "https://d.example"], {
        RUNNER_TOKEN: "dummy-token-1234567890",
      }),
    ).toMatchObject({
      url: "https://d.example",
      token: "dummy-token-1234567890",
      requiredEngines: ["pr-agent", "opencode"],
    });
    expect(() =>
      parseCanaryArguments(["--url", "https://d.example", "--token", "x"], {}),
    ).toThrow(/usage/i);
  });

  it("needs the URL and the credential", () => {
    expect(() =>
      parseCanaryArguments([], { RUNNER_TOKEN: "dummy-token-1234567890" }),
    ).toThrow(/--url/);
    expect(() =>
      parseCanaryArguments(["--url", "https://d.example"], {}),
    ).toThrow(/RUNNER_TOKEN/);
  });

  // #730-T15
  it("takes DISPATCHER_OPERATOR_TOKEN as the credential, and RUNNER_TOKEN only when there is none", () => {
    const argv = ["--url", "https://d.example"];

    expect(
      parseCanaryArguments(argv, {
        DISPATCHER_OPERATOR_TOKEN: "dummy-operator-token-123456",
        RUNNER_TOKEN: "dummy-token-1234567890",
      }).token,
    ).toBe("dummy-operator-token-123456");
    expect(
      parseCanaryArguments(argv, { RUNNER_TOKEN: "dummy-token-1234567890" })
        .token,
    ).toBe("dummy-token-1234567890");
    expect(() => parseCanaryArguments(argv, {})).toThrow(
      /DISPATCHER_OPERATOR_TOKEN/,
    );
  });

  it("accepts the engines to require and the time to wait", () => {
    const parsed = parseCanaryArguments(
      [
        "--url",
        "https://d.example",
        "--engines",
        "pr-agent",
        "--wait-seconds",
        "90",
      ],
      {
        RUNNER_TOKEN: "dummy-token-1234567890",
        VERCEL_AUTOMATION_BYPASS_SECRET: "dummy-bypass",
      },
    );

    expect(parsed).toMatchObject({
      requiredEngines: ["pr-agent"],
      healthWaitSeconds: 90,
      bypassSecret: "dummy-bypass",
    });
  });

  // #759-T11
  it("still requires `pr-agent,opencode` by default, and `--engines` may name the implementer (#765)", () => {
    const env = { RUNNER_TOKEN: "dummy-token-1234567890" };

    expect(
      parseCanaryArguments(["--url", "https://d.example"], env).requiredEngines,
    ).toStrictEqual(["pr-agent", "opencode"]);
    expect(
      parseCanaryArguments(
        [
          "--url",
          "https://d.example",
          "--engines",
          "pr-agent,opencode,implementer",
        ],
        env,
      ).requiredEngines,
    ).toStrictEqual(["pr-agent", "opencode", "implementer"]);
    expect(() =>
      parseCanaryArguments(
        ["--url", "https://d.example", "--engines", "nonsense"],
        env,
      ),
    ).toThrow(/pr-agent, opencode and implementer/);
  });

  // #331-R01
  it("takes the allowed hosts from the option or from CANARY_ALLOWED_HOSTS, and checks only with --check-only", () => {
    const env = { RUNNER_TOKEN: "dummy-token-1234567890" };

    expect(
      parseCanaryArguments(
        [
          "--url",
          "https://d.example",
          "--allowed-hosts",
          "d.example,E.example",
        ],
        env,
      ).allowedHosts,
    ).toStrictEqual(["d.example", "e.example"]);
    expect(
      parseCanaryArguments(["--url", "https://d.example"], {
        ...env,
        CANARY_ALLOWED_HOSTS: "d.example",
      }).allowedHosts,
    ).toStrictEqual(["d.example"]);
    expect(
      parseCanaryArguments(["--url", "https://d.example", "--check-only"], {
        CANARY_ALLOWED_HOSTS: "d.example",
      }),
    ).toMatchObject({ checkOnly: true });
    expect(() =>
      parseCanaryArguments(["--url", "https://d.example", "--check-only"], {}),
    ).not.toThrow();
  });

  // #331-R01
  it("refuses a list with something that is not a host name, without echoing it", () => {
    expect(() =>
      parseCanaryArguments(
        [
          "--url",
          "https://d.example",
          "--allowed-hosts",
          "d.example,https://x/y",
        ],
        { RUNNER_TOKEN: "dummy-token-1234567890" },
      ),
    ).toThrow(/allowed-hosts/);
    expect(() =>
      parseCanaryArguments(
        ["--url", "https://d.example", "--allowed-hosts", "https://secret-x/y"],
        { RUNNER_TOKEN: "dummy-token-1234567890" },
      ),
    ).not.toThrow(/secret-x/);
  });
});
