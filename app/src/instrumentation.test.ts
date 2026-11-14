// SPDX-License-Identifier: LicenseRef-Proprietary

// Pins down the start of an instance (#319): the settings are checked, and none of the work of a long-lived server
// happens (no timer, no database access). A bad setting aborts the start with a thrown error, never with
// `process.exit`.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const forbidden: string[] = [];
vi.mock("./db/startup.ts", () => ({
  getDatabase: () => {
    forbidden.push("getDatabase");
    return {};
  },
}));

import { register } from "./instrumentation.ts";

beforeEach(() => {
  forbidden.length = 0;
  vi.stubEnv("NEXT_RUNTIME", "nodejs");
  vi.stubEnv("APP_SECRET", "a-test-secret-of-at-least-32-characters-long");
  vi.stubEnv("BETTER_AUTH_URL", "https://reviews.example.test");
  vi.stubEnv("RUNNER_TOKEN", "dummy-runner-token-0123456789abcdef");
  vi.stubEnv("DATABASE_URL", "postgres://app:s3cr3t-pw@127.0.0.1:1/app");
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("starting an instance", () => {
  // #405-T32
  it("starts no check run timer: the sweep and the requests reconcile the check runs of a hosted deployment", async () => {
    vi.stubEnv("NODE_ENV", "production");

    await register();

    expect(forbidden).not.toContain("check-run-timer");
    expect(forbidden).toEqual([]);
  });

  // #1037
  it("says in one line whether the Jira connection is on, naming variables and never a value", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);

    await register();
    expect(info).toHaveBeenCalledWith(
      "[jira] off: ATLASSIAN_CLIENT_ID, ATLASSIAN_CLIENT_SECRET not set.",
    );

    vi.stubEnv("ATLASSIAN_CLIENT_ID", "client-id-value");
    vi.stubEnv("ATLASSIAN_CLIENT_SECRET", "client-secret-value");
    info.mockClear();
    await register();
    expect(info).toHaveBeenCalledWith("[jira] on.");
    expect(JSON.stringify(info.mock.calls)).not.toContain(
      "client-secret-value",
    );
  });

  // CR-26-T03
  it("warns about a wrong LLM option and still starts", async () => {
    vi.stubEnv("LLM_MODEL", "a model with spaces");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await register();

    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("LLM_MODEL_INVALID");
    expect(forbidden).toEqual([]);
  });

  it("says nothing about the LLM when its configuration is complete", async () => {
    vi.stubEnv("LLM_PROVIDER", "openrouter");
    vi.stubEnv("LLM_API_KEY", "dummy-llm-key-0123456789");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await register();

    expect(warn).not.toHaveBeenCalled();
  });

  // #319-T01
  it("starts no timer and does not even touch the database", async () => {
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    const exit = vi.spyOn(process, "exit");

    await register();

    expect(forbidden).toEqual([]);
    expect(setIntervalSpy).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });

  // #319-T04
  it("refuses a database URL that is not Postgres with a clear error that names no value, and does not exit the process", async () => {
    vi.stubEnv("DATABASE_URL", "sqlite:///data/secret-name.db");
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const exit = vi.spyOn(process, "exit");

    const failure = await register().then(
      () => undefined,
      (caught: unknown) => caught,
    );

    expect(failure).toBeInstanceOf(Error);
    const text = [
      String((failure as Error).message),
      ...error.mock.calls.map((call) => String(call[0])),
    ].join("\n");
    expect(text).toContain("DATABASE_CONFIG_INVALID");
    expect(text).not.toContain("secret-name");
    expect(exit).not.toHaveBeenCalled();
    expect(forbidden).toEqual([]);
  });

  // #319-T02
  it("aborts a start with an incomplete deployment by throwing, not by process.exit", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("RUNNER_TOKEN", "");
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const exit = vi.spyOn(process, "exit");

    await expect(register()).rejects.toThrow(/start was aborted/);

    expect(
      error.mock.calls.map((call) => String(call[0])).join("\n"),
    ).toContain("RUNNER_TOKEN");
    expect(exit).not.toHaveBeenCalled();
  });

  // #319-T02
  it("aborts a start with a missing master key by throwing, not by process.exit", async () => {
    vi.stubEnv("APP_SECRET", "");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const exit = vi.spyOn(process, "exit");

    await expect(register()).rejects.toThrow(/start was aborted/);

    expect(exit).not.toHaveBeenCalled();
  });
});
