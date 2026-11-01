// SPDX-License-Identifier: LicenseRef-Proprietary

import { describe, expect, it } from "vitest";
import { ConfigError, loadSettings } from "./config.ts";
import { jobTimeoutFor, launchConfigFor } from "./core/types.ts";

const SECRET = "a-signing-secret-of-at-least-32-characters";
const TOKEN = "a-dispatcher-token-for-the-tests";

const base: Record<string, string> = {
  RUNNER_API_URL: "https://app.example.test",
  RUNNER_TOKEN: TOKEN,
  DISPATCHER_MAX_RUNNING: "4",
  DISPATCHER_SIGNING_KEY_ID: "k1",
  DISPATCHER_SIGNING_SECRET: SECRET,
};

function failure(env: Record<string, string>): ConfigError {
  try {
    loadSettings(env);
  } catch (error) {
    if (error instanceof ConfigError) return error;
    throw error;
  }
  throw new Error("expected the settings to be refused");
}

describe("the settings of the Dispatcher", () => {
  // #327 (additional)
  it("reads the settings with their defaults", () => {
    const { core, signingKeys } = loadSettings(base);

    // The legacy variables define the app `reviewer`; nothing else exists without DISPATCHER_APPS (#730-T01).
    expect(core).toStrictEqual({
      apps: [
        {
          id: "reviewer",
          url: "https://app.example.test",
          token: TOKEN,
          poolId: "dispatcher",
          maxRunning: 4,
          kinds: ["diff", "dynamic"],
        },
      ],
      engines: ["pr-agent", "opencode"],
      jobTimeoutSeconds: 1200,
      launchDeadlineSeconds: 300,
      workerConfig: { diff: {}, dynamic: {} },
    });
    expect(signingKeys).toStrictEqual([
      { kid: "k1", secret: SECRET, appId: "reviewer" },
    ]);
  });

  // #327-T10
  it("reads a previous signing key next to the current one", () => {
    const { signingKeys } = loadSettings({
      ...base,
      DISPATCHER_SIGNING_KEY_ID_PREVIOUS: "k0",
      DISPATCHER_SIGNING_SECRET_PREVIOUS:
        "the-previous-signing-secret-32-characters",
    });

    expect(signingKeys.map((key) => key.kid)).toStrictEqual(["k1", "k0"]);
  });

  // #327 (additional)
  it("reads the engines, the pool id, the timeout and the configuration per kind", () => {
    const { core } = loadSettings({
      ...base,
      DISPATCHER_ENGINES: "pr-agent",
      DISPATCHER_POOL_ID: "staging-1",
      DISPATCHER_JOB_TIMEOUT_SECONDS: "600",
      DISPATCHER_WORKER_CONFIG: JSON.stringify({
        dynamic: {
          container: { memory: { limit: "1500m" } },
          launcher: { vcpus: 1 },
        },
      }),
    });

    expect(core.engines).toStrictEqual(["pr-agent"]);
    expect(core.apps[0]?.poolId).toBe("staging-1");
    expect(core.jobTimeoutSeconds).toBe(600);
    expect(core.workerConfig.dynamic).toStrictEqual({
      container: { memory: { limit: "1500m" } },
      launcher: { vcpus: 1 },
    });
    expect(core.workerConfig.diff).toStrictEqual({});
  });

  // #327-T07
  it.each([
    ["RUNNER_API_URL", { RUNNER_API_URL: undefined }],
    ["RUNNER_API_URL", { RUNNER_API_URL: "ftp://app.example.test" }],
    [
      "RUNNER_API_URL",
      { RUNNER_API_URL: "https://user:pass@app.example.test" },
    ],
    ["RUNNER_TOKEN", { RUNNER_TOKEN: undefined }],
    ["RUNNER_TOKEN", { RUNNER_TOKEN: "has a space" }],
    ["DISPATCHER_MAX_RUNNING", { DISPATCHER_MAX_RUNNING: undefined }],
    ["DISPATCHER_MAX_RUNNING", { DISPATCHER_MAX_RUNNING: "0" }],
    ["DISPATCHER_MAX_RUNNING", { DISPATCHER_MAX_RUNNING: "many" }],
    ["DISPATCHER_SIGNING_SECRET", { DISPATCHER_SIGNING_SECRET: "too-short" }],
    ["DISPATCHER_SIGNING_KEY_ID", { DISPATCHER_SIGNING_KEY_ID: "Bad Id" }],
    [
      "DISPATCHER_SIGNING_SECRET_PREVIOUS",
      { DISPATCHER_SIGNING_KEY_ID_PREVIOUS: "k0" },
    ],
    ["DISPATCHER_ENGINES", { DISPATCHER_ENGINES: "pr-agent,unknown" }],
    ["DISPATCHER_POOL_ID", { DISPATCHER_POOL_ID: "bad id!" }],
    ["DISPATCHER_WORKER_CONFIG", { DISPATCHER_WORKER_CONFIG: "{not json" }],
    [
      "DISPATCHER_WORKER_CONFIG",
      {
        DISPATCHER_WORKER_CONFIG: JSON.stringify({
          diff: { container: { privileged: true } },
        }),
      },
    ],
  ] as const)(
    "refuses a bad %s and names the variable, never a value",
    (variable, change) => {
      const env: Record<string, string> = { ...base };
      for (const [name, value] of Object.entries(change))
        if (value === undefined) delete env[name];
        else env[name] = value;

      const error = failure(env);

      expect(error.variable).toBe(variable);
      expect(error.message).toContain(variable);
      for (const secret of [SECRET, TOKEN, "pass"])
        expect(error.message).not.toContain(secret);
    },
  );

  // #327-T07
  it("refuses a signing secret equal to the dispatcher token (every secret is distinct)", () => {
    const error = failure({ ...base, RUNNER_TOKEN: SECRET });

    expect(error.variable).toBe("DISPATCHER_SIGNING_SECRET");
  });

  // #364-T16
  it("has no cron secret unless CRON_SECRET is set", () => {
    expect(loadSettings(base).cronSecret).toBeUndefined();
    expect(
      loadSettings({ ...base, CRON_SECRET: "   " }).cronSecret,
    ).toBeUndefined();
  });

  // #364-T17
  it("reads CRON_SECRET, the platform's own name for the secret its cron sends", () => {
    const secret = "a-cron-secret-of-at-least-32-characters";

    expect(loadSettings({ ...base, CRON_SECRET: secret }).cronSecret).toBe(
      secret,
    );
  });

  // #364-T17
  it.each<[string, Record<string, string>, string, string]>([
    [
      "is too short",
      { CRON_SECRET: "tiny-secret" },
      "CRON_SECRET",
      "too_short",
    ],
    [
      "has a space",
      { CRON_SECRET: "a cron secret with spaces in it 0123456789" },
      "CRON_SECRET",
      "invalid",
    ],
    [
      "has a control character",
      { CRON_SECRET: "a-cron-secret-with-a-tab\t-0123456789" },
      "CRON_SECRET",
      "invalid",
    ],
    [
      "equals the dispatcher credential",
      {
        CRON_SECRET: TOKEN.padEnd(32, "x"),
        RUNNER_TOKEN: TOKEN.padEnd(32, "x"),
      },
      "CRON_SECRET",
      "not_distinct",
    ],
    [
      "equals the signing secret",
      { CRON_SECRET: SECRET },
      "CRON_SECRET",
      "not_distinct",
    ],
    [
      "equals the previous signing secret",
      {
        CRON_SECRET: "the-previous-signing-secret-32-characters",
        DISPATCHER_SIGNING_KEY_ID_PREVIOUS: "k0",
        DISPATCHER_SIGNING_SECRET_PREVIOUS:
          "the-previous-signing-secret-32-characters",
      },
      "CRON_SECRET",
      "not_distinct",
    ],
  ])(
    "reports a CRON_SECRET that %s as a problem naming the variable, and never takes it",
    (_name, env, variable, reason) => {
      const settings = loadSettings({ ...base, ...env });

      // Whether it matters depends on whether the reaper's route is mounted (compose.ts): not here.
      expect(settings.cronSecret).toBeUndefined();
      expect(settings.cronSecretProblem).toBeInstanceOf(ConfigError);
      expect(settings.cronSecretProblem?.variable).toBe(variable);
      expect(settings.cronSecretProblem?.reason).toBe(reason);
      expect(settings.cronSecretProblem?.message).not.toContain(
        env.CRON_SECRET ?? "unreachable",
      );
    },
  );

  // #364-T17
  it("reports no problem for a good or an absent CRON_SECRET", () => {
    expect(loadSettings(base).cronSecretProblem).toBeUndefined();
    expect(
      loadSettings({
        ...base,
        CRON_SECRET: "a-cron-secret-of-at-least-32-characters",
      }).cronSecretProblem,
    ).toBeUndefined();
  });
});

// #759: the job timeout and the worker configuration per kind.
describe("the timeout and the configuration of the implementer kind (#759)", () => {
  const withConfig = (config: unknown) => ({
    ...base,
    DISPATCHER_WORKER_CONFIG: JSON.stringify(config),
  });

  // #759-T07
  it("gives Diff and Dynamic the job timeout of the variable (1200 unless set) and the implementer 3600, whatever that variable says", () => {
    for (const [variables, diffAndDynamic] of [
      [base, 1200],
      [{ ...base, DISPATCHER_JOB_TIMEOUT_SECONDS: "600" }, 600],
    ] as const) {
      const { core } = loadSettings(variables);
      expect(jobTimeoutFor(core, "diff")).toBe(diffAndDynamic);
      expect(jobTimeoutFor(core, "dynamic")).toBe(diffAndDynamic);
      expect(jobTimeoutFor(core, "implementer")).toBe(3600);
    }
  });

  // #759-T07
  it("reads the timeout of the implementer from its worker configuration, between 60 and 21 600 seconds", () => {
    const { core } = loadSettings(
      withConfig({ implementer: { timeoutSeconds: 21600 } }),
    );

    expect(jobTimeoutFor(core, "implementer")).toBe(21600);
    expect(jobTimeoutFor(core, "diff")).toBe(1200);
    expect(
      jobTimeoutFor(
        loadSettings(withConfig({ implementer: { timeoutSeconds: 60 } })).core,
        "implementer",
      ),
    ).toBe(60);
  });

  // #759-T08
  it("reads the container memory and the launcher options of the implementer next to the other kinds, and keeps the timeout out of what the launcher gets", () => {
    const { core } = loadSettings(
      withConfig({
        implementer: {
          timeoutSeconds: 7200,
          container: { memory: { limit: "3g", reservation: "2560m" } },
          launcher: { vcpus: 2 },
        },
      }),
    );

    expect(launchConfigFor(core, "implementer")).toStrictEqual({
      container: { memory: { limit: "3g", reservation: "2560m" } },
      launcher: { vcpus: 2 },
    });
    expect(launchConfigFor(core, "diff")).toStrictEqual({});
    expect(launchConfigFor(core, "dynamic")).toStrictEqual({});
  });

  // #759-T08
  it("behaves as before without an `implementer` key: the same settings as without the variable's new key", () => {
    const { core } = loadSettings(
      withConfig({ dynamic: { launcher: { vcpus: 1 } } }),
    );

    expect(core.workerConfig).toStrictEqual({
      diff: {},
      dynamic: { launcher: { vcpus: 1 } },
    });
    expect(launchConfigFor(core, "implementer")).toStrictEqual({});
    expect(jobTimeoutFor(core, "implementer")).toBe(3600);
  });

  // #759-T08
  it.each([
    ["a timeout above 21 600", { implementer: { timeoutSeconds: 21601 } }],
    ["a timeout below 60", { implementer: { timeoutSeconds: 59 } }],
    ["a fractional timeout", { implementer: { timeoutSeconds: 90.5 } }],
    ["a timeout that is text", { implementer: { timeoutSeconds: "3600" } }],
    ["an unknown key", { implementer: { privileged: true } }],
    [
      "a memory that is no size",
      { implementer: { container: { memory: { limit: "lots" } } } },
    ],
    ["a timeout for Diff", { diff: { timeoutSeconds: 600 } }],
    ["a timeout for Dynamic", { dynamic: { timeoutSeconds: 600 } }],
    ["an unknown kind", { reviewer: {} }],
  ])("refuses %s, naming the variable and no value", (_name, config) => {
    const error = failure(withConfig(config));

    expect(error.variable).toBe("DISPATCHER_WORKER_CONFIG");
    expect(error.message).toBe("DISPATCHER_WORKER_CONFIG is invalid");
  });
});
