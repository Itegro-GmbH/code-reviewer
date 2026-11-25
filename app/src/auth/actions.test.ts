// SPDX-License-Identifier: LicenseRef-Proprietary

// Pins down the gates of the login form's Server Functions: a way to sign in that the admin switched off
// is refused here too, before Better Auth is asked, because the form calls Better Auth directly and never
// passes the HTTP interface (src/auth/http.ts) that has the same gate.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SignInMethods } from "../admin/sign-in-methods.ts";

const mocks = vi.hoisted(() => ({
  methods: vi.fn<() => Promise<SignInMethods>>(),
  signInEmail: vi.fn(() => Promise.resolve({})),
  signInSocial: vi.fn(() =>
    Promise.resolve({ url: "https://github.example/authorize" }),
  ),
  limiterCheck: vi.fn(() => Promise.resolve({ allowed: true as const })),
}));
vi.mock("next/headers", () => ({
  headers: () => Promise.resolve(new Headers()),
}));
vi.mock("./auth.ts", () => ({
  getAuth: () => ({
    api: { signInEmail: mocks.signInEmail, signInSocial: mocks.signInSocial },
  }),
}));
vi.mock("./github-auth.ts", () => ({
  getGithubAuth: () =>
    Promise.resolve({ api: { signInSocial: mocks.signInSocial } }),
}));
vi.mock("./sign-in-runtime.ts", () => ({
  getSignInMethods: mocks.methods,
  getSignInLimiter: () => ({
    check: mocks.limiterCheck,
    succeeded: () => Promise.resolve(),
  }),
}));

import { signInWithGithub, signInWithPassword } from "./actions.ts";

function redirectedTo(error: unknown): string | null {
  const digest = (error as { digest?: string } | null)?.digest ?? "";
  return /^NEXT_REDIRECT;[a-z]+;([^;]+);/.exec(digest)?.[1] ?? null;
}

async function run(action: () => Promise<void>): Promise<string | null> {
  return redirectedTo(
    await action().then(
      () => null,
      (thrown: unknown) => thrown,
    ),
  );
}

function form(): FormData {
  const data = new FormData();
  data.set("email", "admin@example.com");
  data.set("password", "a-long-password-1234");
  return data;
}

function formWith(values: Record<string, string>): FormData {
  const data = new FormData();
  for (const [name, value] of Object.entries(values)) data.set(name, value);
  return data;
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("the email and password form", () => {
  // #98-SIGN-IN-METHODS
  it("is refused with the reason, without counting an attempt or asking Better Auth, when the way is off", async () => {
    mocks.methods.mockResolvedValue({ emailPassword: false, github: true });

    const target = await run(() => signInWithPassword(form()));

    expect(target).toBe("/login?error=sign_in_method_disabled");
    expect(mocks.limiterCheck).not.toHaveBeenCalled();
    expect(mocks.signInEmail).not.toHaveBeenCalled();
  });

  it("signs in when the way is on", async () => {
    mocks.methods.mockResolvedValue({ emailPassword: true, github: false });

    const target = await run(() => signInWithPassword(form()));

    expect(target).toBe("/");
    expect(mocks.signInEmail).toHaveBeenCalledTimes(1);
  });
});

describe("the GitHub button", () => {
  // #98-SIGN-IN-METHODS
  it("is refused with the reason, without asking Better Auth, when the way is off", async () => {
    mocks.methods.mockResolvedValue({ emailPassword: true, github: false });

    const target = await run(signInWithGithub);

    expect(target).toBe("/login?error=sign_in_method_disabled");
    expect(mocks.signInSocial).not.toHaveBeenCalled();
  });

  it("goes to GitHub when the way is on", async () => {
    mocks.methods.mockResolvedValue({ emailPassword: true, github: true });

    const target = await run(signInWithGithub);

    expect(target).toBe("https://github.example/authorize");
    expect(mocks.signInSocial).toHaveBeenCalledWith(
      expect.objectContaining({
        body: { provider: "github", callbackURL: "/" },
      }),
    );
  });

  // #101-follow-up: the invitation travels through GitHub
  it("brings an invitee back to the page of the invitation, and only to that page", async () => {
    mocks.methods.mockResolvedValue({ emailPassword: true, github: true });
    const token = "A".repeat(43);

    await run(() => signInWithGithub(formWith({ invitation: token })));

    expect(mocks.signInSocial).toHaveBeenCalledWith(
      expect.objectContaining({
        body: {
          provider: "github",
          callbackURL: `/invitation?token=${token}`,
        },
      }),
    );
  });

  // #1144-T193: a pending authorization request of an AI app travels through GitHub the same way
  it("brings a person who came from an AI app back to the consent page, and an invitation still wins", async () => {
    mocks.methods.mockResolvedValue({ emailPassword: true, github: true });
    const request = "B".repeat(32);

    await run(() => signInWithGithub(formWith({ oauth: request })));
    expect(mocks.signInSocial).toHaveBeenLastCalledWith(
      expect.objectContaining({
        body: {
          provider: "github",
          callbackURL: `/oauth/consent?request=${request}`,
        },
      }),
    );

    const token = "A".repeat(43);
    await run(() =>
      signInWithGithub(formWith({ oauth: request, invitation: token })),
    );
    expect(mocks.signInSocial).toHaveBeenLastCalledWith(
      expect.objectContaining({
        body: {
          provider: "github",
          callbackURL: `/invitation?token=${token}`,
        },
      }),
    );
  });

  // #1144-T194
  it("keeps the request on the login page when the sign in cannot start, and carries only a request id", async () => {
    mocks.methods.mockResolvedValue({ emailPassword: true, github: false });
    const request = "C".repeat(32);

    expect(
      await run(() => signInWithGithub(formWith({ oauth: request }))),
    ).toBe(`/login?error=sign_in_method_disabled&oauth=${request}`);
    expect(
      await run(() =>
        signInWithGithub(formWith({ oauth: "https://evil.example" })),
      ),
    ).toBe("/login?error=sign_in_method_disabled");
  });

  it.each([
    "https://evil.example/phish",
    "//evil.example",
    "/admin",
    "short",
    `${"A".repeat(43)}&next=https://evil.example`,
  ])("ignores a value that is not an invitation token: %s", async (value) => {
    mocks.methods.mockResolvedValue({ emailPassword: true, github: true });

    await run(() => signInWithGithub(formWith({ invitation: value })));

    expect(mocks.signInSocial).toHaveBeenCalledWith(
      expect.objectContaining({
        body: { provider: "github", callbackURL: "/" },
      }),
    );
  });

  it("keeps the invitation on the login page when the sign in cannot start", async () => {
    mocks.methods.mockResolvedValue({ emailPassword: true, github: false });
    const token = "A".repeat(43);

    const target = await run(() =>
      signInWithGithub(formWith({ invitation: token })),
    );

    expect(target).toBe(
      `/login?error=sign_in_method_disabled&invitation=${token}`,
    );
  });
});
