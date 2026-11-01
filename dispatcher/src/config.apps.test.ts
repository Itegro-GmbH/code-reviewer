// SPDX-License-Identifier: LicenseRef-Proprietary

// The registry of several apps (#730): DISPATCHER_APPS, the secrets named after each app, the operator token and every
// refusal at start. A refusal names the variable (and the app), never a value.
import { describe, expect, it } from "vitest";
import { ConfigError, loadSettings } from "./config.ts";

const SECRET = "a-signing-secret-of-at-least-32-characters";
const TOKEN = "a-dispatcher-token-for-the-tests";
const FACTORY_TOKEN = "factory-dispatcher-token-for-tests-0001";
const FACTORY_SECRET = "factory-signing-secret-for-tests-000001";
const OTHER_TOKEN = "other-dispatcher-token-for-tests-00001";
const OTHER_SECRET = "other-signing-secret-for-tests-0000001";
const OPERATOR = "operator-token-for-the-tests-0000000001";

const legacy: Record<string, string> = {
  RUNNER_API_URL: "https://app.example.test",
  RUNNER_TOKEN: TOKEN,
  DISPATCHER_MAX_RUNNING: "4",
  DISPATCHER_SIGNING_KEY_ID: "k1",
  DISPATCHER_SIGNING_SECRET: SECRET,
};

const factory = {
  id: "factory",
  url: "https://factory.example.test",
  kinds: ["diff", "dynamic"],
  keyId: "factory-k1",
  maxRunning: 2,
  poolId: "factory",
};
const factorySecrets: Record<string, string> = {
  DISPATCHER_APP_FACTORY_TOKEN: FACTORY_TOKEN,
  DISPATCHER_APP_FACTORY_SIGNING_SECRET: FACTORY_SECRET,
};
const other = {
  id: "second-app",
  url: "https://second.example.test",
  kinds: ["diff"],
  keyId: "second-k1",
  maxRunning: 1,
};
const otherSecrets: Record<string, string> = {
  DISPATCHER_APP_SECOND_APP_TOKEN: OTHER_TOKEN,
  DISPATCHER_APP_SECOND_APP_SIGNING_SECRET: OTHER_SECRET,
};

function env(
  apps: unknown,
  extra: Record<string, string> = factorySecrets,
): Record<string, string> {
  // With several apps the operator token is required (the canary's route is never opened by an app's credential).
  return {
    ...legacy,
    DISPATCHER_APPS: JSON.stringify(apps),
    DISPATCHER_OPERATOR_TOKEN: OPERATOR,
    ...extra,
  };
}

function failure(variables: Record<string, string>): ConfigError {
  try {
    loadSettings(variables);
  } catch (error) {
    if (error instanceof ConfigError) return error;
    throw error;
  }
  throw new Error("expected the settings to be refused");
}

describe("the registry of apps", () => {
  // #730-T02
  it("reads two apps next to the legacy one, each with its own credential, key and pool", () => {
    const settings = loadSettings(
      env([factory, other], { ...factorySecrets, ...otherSecrets }),
    );

    expect(settings.core.apps).toStrictEqual([
      {
        id: "reviewer",
        url: "https://app.example.test",
        token: TOKEN,
        poolId: "dispatcher",
        maxRunning: 4,
        kinds: ["diff", "dynamic"],
      },
      {
        id: "factory",
        url: "https://factory.example.test",
        token: FACTORY_TOKEN,
        poolId: "factory",
        maxRunning: 2,
        kinds: ["diff", "dynamic"],
      },
      {
        id: "second-app",
        url: "https://second.example.test",
        token: OTHER_TOKEN,
        // No `poolId`: the id.
        poolId: "second-app",
        maxRunning: 1,
        kinds: ["diff"],
      },
    ]);
    expect(settings.signingKeys).toStrictEqual([
      { kid: "k1", secret: SECRET, appId: "reviewer" },
      { kid: "factory-k1", secret: FACTORY_SECRET, appId: "factory" },
      { kid: "second-k1", secret: OTHER_SECRET, appId: "second-app" },
    ]);
  });

  // #730-T02
  it("reads the previous key of an app next to its current one, for that app", () => {
    const settings = loadSettings(
      env([factory], {
        ...factorySecrets,
        DISPATCHER_APP_FACTORY_SIGNING_SECRET_PREVIOUS:
          "factory-previous-signing-secret-000000",
        DISPATCHER_APP_FACTORY_SIGNING_SECRET_PREVIOUS_KEY_ID: "factory-k0",
      }),
    );

    expect(
      settings.signingKeys.map((key) => [key.kid, key.appId]),
    ).toStrictEqual([
      ["k1", "reviewer"],
      ["factory-k1", "factory"],
      ["factory-k0", "factory"],
    ]);
  });

  // #730-T01
  it("serves the kinds of DISPATCHER_ENGINES for the legacy app and the operator token is absent", () => {
    const diffOnly = loadSettings({
      ...legacy,
      DISPATCHER_ENGINES: "pr-agent",
    });

    expect(diffOnly.core.apps).toHaveLength(1);
    expect(diffOnly.core.apps[0]?.kinds).toStrictEqual(["diff"]);
    expect(diffOnly.operatorToken).toBeUndefined();
  });

  // #730-T02
  it.each<[string, unknown, Record<string, string>, string, string]>([
    ["is not JSON", "{nope", factorySecrets, "DISPATCHER_APPS", "invalid"],
    [
      "is not an array",
      { id: "factory" },
      factorySecrets,
      "DISPATCHER_APPS",
      "invalid",
    ],
    ["is an empty array", [], factorySecrets, "DISPATCHER_APPS", "invalid"],
    [
      "has an entry with a field it does not know",
      [{ ...factory, snapshotId: "x" }],
      factorySecrets,
      "DISPATCHER_APPS",
      "invalid",
    ],
    [
      "has an id of the wrong shape",
      [{ ...factory, id: "Factory_1" }],
      factorySecrets,
      "DISPATCHER_APPS",
      "invalid",
    ],
    [
      "repeats an id",
      [factory, { ...factory, url: "https://again.example.test", keyId: "f2" }],
      factorySecrets,
      "DISPATCHER_APPS",
      "duplicate",
    ],
    [
      "uses the reserved id of the legacy app",
      [{ ...factory, id: "reviewer" }],
      factorySecrets,
      "DISPATCHER_APPS",
      "duplicate",
    ],
    [
      "repeats a key id of another app",
      [factory, { ...other, keyId: "factory-k1" }],
      { ...factorySecrets, ...otherSecrets },
      "DISPATCHER_APPS",
      "duplicate",
    ],
    [
      "uses the key id of the legacy app",
      [{ ...factory, keyId: "k1" }],
      factorySecrets,
      "DISPATCHER_APPS",
      "duplicate",
    ],
    [
      "uses the address of the legacy app",
      [{ ...factory, url: "https://app.example.test/" }],
      factorySecrets,
      "DISPATCHER_APPS",
      "duplicate",
    ],
    [
      "uses the address of the legacy app in another spelling (upper case host, default port)",
      [{ ...factory, url: "https://APP.example.test:443" }],
      factorySecrets,
      "DISPATCHER_APPS",
      "duplicate",
    ],
    [
      "names a kind that does not exist",
      [{ ...factory, kinds: ["diff", "review"] }],
      factorySecrets,
      "DISPATCHER_APPS",
      "invalid",
    ],
    [
      "names no kind",
      [{ ...factory, kinds: [] }],
      factorySecrets,
      "DISPATCHER_APPS",
      "invalid",
    ],
    [
      "has an address with credentials",
      [{ ...factory, url: "https://user:pass@factory.example.test" }],
      factorySecrets,
      "DISPATCHER_APPS",
      "invalid",
    ],
    [
      "has an address with a query",
      [{ ...factory, url: "https://factory.example.test/?a=1" }],
      factorySecrets,
      "DISPATCHER_APPS",
      "invalid",
    ],
    [
      "has an address that is not http(s)",
      [{ ...factory, url: "ftp://factory.example.test" }],
      factorySecrets,
      "DISPATCHER_APPS",
      "invalid",
    ],
    [
      "has a cap of zero",
      [{ ...factory, maxRunning: 0 }],
      factorySecrets,
      "DISPATCHER_APPS",
      "invalid",
    ],
    [
      "has no token variable",
      [factory],
      { DISPATCHER_APP_FACTORY_SIGNING_SECRET: FACTORY_SECRET },
      "DISPATCHER_APP_FACTORY_TOKEN",
      "required",
    ],
    [
      "has no signing secret variable",
      [factory],
      { DISPATCHER_APP_FACTORY_TOKEN: FACTORY_TOKEN },
      "DISPATCHER_APP_FACTORY_SIGNING_SECRET",
      "required",
    ],
    [
      "has a signing secret that is too short",
      [factory],
      { ...factorySecrets, DISPATCHER_APP_FACTORY_SIGNING_SECRET: "short" },
      "DISPATCHER_APP_FACTORY_SIGNING_SECRET",
      "too_short",
    ],
    [
      "has a token with a space",
      [factory],
      {
        ...factorySecrets,
        DISPATCHER_APP_FACTORY_TOKEN: "a token with spaces in it, 32 chars",
      },
      "DISPATCHER_APP_FACTORY_TOKEN",
      "invalid",
    ],
    [
      "has half a previous key",
      [factory],
      {
        ...factorySecrets,
        DISPATCHER_APP_FACTORY_SIGNING_SECRET_PREVIOUS:
          "factory-previous-signing-secret-000000",
      },
      "DISPATCHER_APP_FACTORY_SIGNING_SECRET_PREVIOUS_KEY_ID",
      "required",
    ],
    [
      "reuses the token of another app as a signing secret",
      [factory],
      { ...factorySecrets, DISPATCHER_APP_FACTORY_SIGNING_SECRET: TOKEN },
      "DISPATCHER_APP_FACTORY_SIGNING_SECRET",
      "not_distinct",
    ],
    [
      "reuses the signing secret of the legacy app",
      [factory],
      { ...factorySecrets, DISPATCHER_APP_FACTORY_SIGNING_SECRET: SECRET },
      "DISPATCHER_APP_FACTORY_SIGNING_SECRET",
      "not_distinct",
    ],
    [
      "reuses the legacy token as its own",
      [factory],
      { ...factorySecrets, DISPATCHER_APP_FACTORY_TOKEN: TOKEN },
      "DISPATCHER_APP_FACTORY_TOKEN",
      "not_distinct",
    ],
    [
      "reuses its own token as its signing secret",
      [factory],
      {
        ...factorySecrets,
        DISPATCHER_APP_FACTORY_SIGNING_SECRET: FACTORY_TOKEN,
      },
      "DISPATCHER_APP_FACTORY_SIGNING_SECRET",
      "not_distinct",
    ],
    [
      "reuses the secret of another app",
      [factory, other],
      {
        ...factorySecrets,
        ...otherSecrets,
        DISPATCHER_APP_SECOND_APP_SIGNING_SECRET: FACTORY_SECRET,
      },
      "DISPATCHER_APP_SECOND_APP_SIGNING_SECRET",
      "not_distinct",
    ],
  ])(
    "refuses a DISPATCHER_APPS that %s and names the variable",
    (_name, apps, extra, variable, reason) => {
      const variables =
        typeof apps === "string"
          ? { ...legacy, DISPATCHER_APPS: apps, ...extra }
          : env(apps, extra);

      const error = failure(variables);

      expect(error.variable).toBe(variable);
      expect(error.reason).toBe(reason);
      for (const secret of [
        SECRET,
        TOKEN,
        FACTORY_TOKEN,
        FACTORY_SECRET,
        OTHER_TOKEN,
        OTHER_SECRET,
        "pass",
      ])
        expect(error.message).not.toContain(secret);
    },
  );

  // #730-T23
  it("compares the addresses of two apps as the platform reads them, not as they are spelled", () => {
    for (const spelling of [
      "https://FACTORY.example.test",
      "https://factory.example.test:443/",
      "https://factory.example.test//",
    ])
      expect(
        failure(
          env([factory, { ...other, url: spelling, keyId: "second-k2" }], {
            ...factorySecrets,
            ...otherSecrets,
          }),
        ),
        spelling,
      ).toMatchObject({ variable: "DISPATCHER_APPS", reason: "duplicate" });
    // Another path or port is another address.
    expect(() =>
      loadSettings(
        env([factory, { ...other, url: "https://factory.example.test:8443" }], {
          ...factorySecrets,
          ...otherSecrets,
        }),
      ),
    ).not.toThrow();
  });

  // #730-T25
  it("requires the operator token as soon as DISPATCHER_APPS names an app, and not before", () => {
    const withoutOperator = env([factory]);
    delete withoutOperator.DISPATCHER_OPERATOR_TOKEN;

    expect(failure(withoutOperator)).toMatchObject({
      variable: "DISPATCHER_OPERATOR_TOKEN",
      reason: "required",
    });
    // Without DISPATCHER_APPS the legacy environment is untouched.
    expect(() => loadSettings(legacy)).not.toThrow();
  });

  // #730-T02
  it("tells which app and which field a refusal of DISPATCHER_APPS is about", () => {
    const error = failure(env([{ ...factory, kinds: ["review"] }]));

    expect(error.message).toBe("DISPATCHER_APPS is invalid (factory: kinds)");
  });

  // #730-T02
  it("takes a secret equal to the operator token, or an operator token that is short, for what it is", () => {
    expect(
      failure({ ...env([factory]), DISPATCHER_OPERATOR_TOKEN: FACTORY_TOKEN })
        .variable,
    ).toBe("DISPATCHER_OPERATOR_TOKEN");
    expect(
      failure({ ...legacy, DISPATCHER_OPERATOR_TOKEN: TOKEN }).variable,
    ).toBe("DISPATCHER_OPERATOR_TOKEN");
    expect(
      failure({ ...legacy, DISPATCHER_OPERATOR_TOKEN: "short" }),
    ).toMatchObject({
      variable: "DISPATCHER_OPERATOR_TOKEN",
      reason: "too_short",
    });
    expect(
      loadSettings({ ...env([factory]), DISPATCHER_OPERATOR_TOKEN: OPERATOR })
        .operatorToken,
    ).toBe(OPERATOR);
  });

  // #730-T02
  it("keeps CRON_SECRET distinct from every credential of every app and from the operator token", () => {
    for (const reused of [FACTORY_TOKEN, FACTORY_SECRET, OPERATOR]) {
      const settings = loadSettings({
        ...env([factory]),
        DISPATCHER_OPERATOR_TOKEN: OPERATOR,
        CRON_SECRET: reused,
      });

      expect(settings.cronSecret).toBeUndefined();
      expect(settings.cronSecretProblem).toMatchObject({
        variable: "CRON_SECRET",
        reason: "not_distinct",
      });
    }
  });

  // #730-T11
  it("allows no kind that is not on the list in code: not for an app of the registry, not through DISPATCHER_ENGINES, and `reviewer` cannot be redeclared", () => {
    for (const kind of ["review", "Diff", "implementer "])
      expect(
        failure(env([{ ...factory, kinds: ["diff", kind] }])),
      ).toMatchObject({ variable: "DISPATCHER_APPS", reason: "invalid" });
    expect(
      failure({ ...legacy, DISPATCHER_ENGINES: "pr-agent,review" }).variable,
    ).toBe("DISPATCHER_ENGINES");
    expect(
      failure(env([{ ...factory, id: "reviewer", kinds: ["diff"] }])),
    ).toMatchObject({ variable: "DISPATCHER_APPS", reason: "duplicate" });
    // The kinds of `reviewer` are not read from anywhere but DISPATCHER_ENGINES.
    expect(
      loadSettings({
        ...legacy,
        DISPATCHER_APP_REVIEWER_KINDS: "implementer",
      }).core.apps[0]?.kinds,
    ).toStrictEqual(["diff", "dynamic"]);
  });
});

// #759: the kind `implementer` exists for the apps of the registry and never for `reviewer`.
describe("the implementer kind in the configuration (#759)", () => {
  const implementing = {
    ...factory,
    kinds: ["diff", "dynamic", "implementer"],
  };

  // #759-T02
  it("never gives `reviewer` the kind: not with the default engines, not with DISPATCHER_ENGINES naming it", () => {
    const variants: Array<[Record<string, string>, string[]]> = [
      [legacy, ["diff", "dynamic"]],
      [env([implementing]), ["diff", "dynamic"]],
      [
        { ...env([implementing]), DISPATCHER_ENGINES: "pr-agent,implementer" },
        ["diff"],
      ],
      [
        {
          ...env([implementing]),
          DISPATCHER_ENGINES: "pr-agent,opencode,implementer",
        },
        ["diff", "dynamic"],
      ],
      [{ ...legacy, DISPATCHER_ENGINES: "opencode,implementer" }, ["dynamic"]],
    ];
    for (const [variables, kinds] of variants)
      expect(loadSettings(variables).core.apps[0]).toMatchObject({
        id: "reviewer",
        kinds,
      });
  });

  // #759-T02
  it("refuses an engine list that leaves `reviewer` no kind, naming DISPATCHER_ENGINES", () => {
    expect(
      failure({ ...env([implementing]), DISPATCHER_ENGINES: "implementer" }),
    ).toMatchObject({ variable: "DISPATCHER_ENGINES", reason: "invalid" });
  });

  // #759-T02
  it("adds the engine `implementer` to the default engines only when an app of DISPATCHER_APPS names the kind", () => {
    expect(loadSettings(legacy).core.engines).toStrictEqual([
      "pr-agent",
      "opencode",
    ]);
    expect(loadSettings(env([factory])).core.engines).toStrictEqual([
      "pr-agent",
      "opencode",
    ]);
    expect(loadSettings(env([implementing])).core.engines).toStrictEqual([
      "pr-agent",
      "opencode",
      "implementer",
    ]);
    // An operator who names the engines decides: the kind is not served unless the list has its engine.
    expect(
      loadSettings({ ...env([implementing]), DISPATCHER_ENGINES: "pr-agent" })
        .core.engines,
    ).toStrictEqual(["pr-agent"]);
  });

  // #759-T03
  it("accepts a registry entry for `factory` with the kind and keeps it, and still refuses an unknown kind naming the entry", () => {
    const { core } = loadSettings(env([implementing]));

    expect(core.apps.map((app) => [app.id, app.kinds])).toStrictEqual([
      ["reviewer", ["diff", "dynamic"]],
      ["factory", ["diff", "dynamic", "implementer"]],
    ]);
    expect(
      failure(env([{ ...implementing, kinds: ["diff", "implementor"] }]))
        .message,
    ).toBe("DISPATCHER_APPS is invalid (factory: kinds)");
  });

  // #759-T03
  it("accepts the kind for an entry that names it alone", () => {
    const { core } = loadSettings(
      env([{ ...factory, kinds: ["implementer"] }]),
    );

    expect(core.apps[1]?.kinds).toStrictEqual(["implementer"]);
  });
});
