// SPDX-License-Identifier: LicenseRef-Proprietary

// Invitations by mail in a real browser against a production build and the fake SMTP server, in a
// multi-tenant instance: a person signs up, confirms the address from the mail, creates a workspace and
// invites a colleague by mail; the colleague (two browser contexts) confirms an account of their own and
// finds the invitation listed after signing in, accepts it and sees the workspace in the switcher; a third
// person comes from the link in the mail, which leads through the sign-up and the sign-in back to the
// invitation. Nothing of a link is shown to the person who invites. The rules behind are proven as
// integration tests (src/workspaces/). The app is the fifth one; the journeys without a mail server come
// first (playwright.config.ts).
import { randomUUID } from "node:crypto";
import { expect, test, type Browser, type Page } from "@playwright/test";
import {
  changeAdminSetting,
  configureFakeMailServer,
  removeMailServer,
} from "../helpers/admin-api";
import { e2eEnv } from "../helpers/e2e-env";
import { messageTo, readInbox } from "../helpers/mail";

const RUN = randomUUID().slice(0, 8);
const OWNER = `owner-${RUN}@e2e.test`;
const COLLEAGUE = `colleague-${RUN}@e2e.test`;
const NEWCOMER = `newcomer-${RUN}@e2e.test`;
const PASSWORD = "e2e-mail-passphrase-quartz-lake-58";
const WORKSPACE = "Mail Team";
const CONFIRM_SUBJECT = "Confirm your email address";
const INVITATION_SUBJECT = `Join "${WORKSPACE}" at code-review.com`;

const linkOf = (text: string) => /https?:\/\/\S+/.exec(text)?.[0] ?? "";

async function newPerson(browser: Browser): Promise<Page> {
  const context = await browser.newContext({ baseURL: e2eEnv.multiAppUrl });
  return context.newPage();
}

/** Signs up and confirms the address from the mail, the way a person does. */
async function signUpAndConfirm(
  page: Page,
  address: string,
  from = "/sign-up",
): Promise<void> {
  await page.goto(from);
  const form = page.getByRole("form", { name: "Sign-up form" });
  await form.getByLabel("Email address").fill(address);
  await form.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await form.getByLabel("Repeat the password").fill(PASSWORD);
  await form.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("status")).toContainText("Check your inbox");
  const mail = await messageTo(address, CONFIRM_SUBJECT);
  await page.goto(linkOf(mail.text));
  const confirm = page.getByRole("form", { name: "Confirm email address" });
  await confirm.getByLabel("Password").fill(PASSWORD);
  await confirm.getByRole("button", { name: "Confirm email address" }).click();
  await expect(page.getByRole("status")).toContainText("confirmed");
}

async function signIn(page: Page, address: string, via = "/login") {
  await page.goto(via);
  await page.getByLabel("Email address").fill(address);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).not.toHaveURL(/\/login/);
}

test.describe.configure({ mode: "serial" });

test.describe("invitations by mail", () => {
  test.beforeAll(async () => {
    await configureFakeMailServer(e2eEnv.multiAppUrl);
    // The earlier journey of this app left the limit at one workspace per person.
    await changeAdminSetting(e2eEnv.multiAppUrl, {
      limits: { maxWorkspacesPerUser: 10 },
    });
  });

  test.afterAll(async () => {
    await removeMailServer(e2eEnv.multiAppUrl);
  });

  // #101-WM-26, #101-WM-12
  test("@smoke an Owner invites a colleague by mail, who finds the invitation listed after signing in and accepts it", async ({
    browser,
  }) => {
    const owner = await newPerson(browser);
    await signUpAndConfirm(owner, OWNER);
    await signIn(owner, OWNER);
    await expect(owner).toHaveURL(/\/no-access$/);
    const create = owner.getByRole("form", { name: "Create a workspace" });
    await create.getByLabel("Name of the workspace").fill(WORKSPACE);
    await create.getByRole("button", { name: "Create workspace" }).click();
    await expect(owner).toHaveURL(/\/w\/mail-team\/projects$/);

    await owner.goto("/w/mail-team/members");
    const form = owner.getByRole("form", { name: "Invite a person" });
    await form.getByLabel("Email address").fill(COLLEAGUE);
    await form.getByRole("button", { name: "Send invitation" }).click();
    await expect(
      owner.getByText(`The invitation was sent to ${COLLEAGUE}`),
    ).toBeVisible();
    // The link was mailed: it is nowhere in the page of the person who invited.
    await expect(owner.getByLabel("Invitation link")).toHaveCount(0);
    const mail = await messageTo(COLLEAGUE, INVITATION_SUBJECT);
    expect(linkOf(mail.text)).toMatch(
      new RegExp(
        `^${e2eEnv.multiAppUrl}/invitation\\?token=[A-Za-z0-9_-]{43}$`,
      ),
    );
    expect(mail.subject).not.toMatch(/[\r\n]/);
    expect(mail.text).toContain(WORKSPACE);
    expect(await owner.content()).not.toContain(
      linkOf(mail.text).split("token=")[1],
    );

    // The colleague makes an account of their own and signs in: the invitation waits in the list.
    const colleague = await newPerson(browser);
    await signUpAndConfirm(colleague, COLLEAGUE);
    await signIn(colleague, COLLEAGUE);
    await expect(colleague).toHaveURL(/\/no-access$/);
    const waiting = colleague.getByRole("list", {
      name: "Invitations",
    });
    await expect(waiting.getByText(WORKSPACE)).toBeVisible();
    await waiting.getByRole("button", { name: /Accept/ }).click();
    await expect(colleague).toHaveURL(/\/w\/mail-team\/projects$/);
    await colleague.getByRole("button", { name: /Workspace/ }).click();
    await expect(
      colleague
        .getByRole("group", { name: "Your workspaces" })
        .getByText(WORKSPACE),
    ).toBeVisible();

    // The Owner sees the colleague as a Member, and the invitation gone.
    await owner.goto("/w/mail-team/members");
    await expect(
      owner.getByRole("list", { name: "Members" }).getByText(COLLEAGUE),
    ).toBeVisible();
    await expect(owner.getByRole("list", { name: "Invitations" })).toHaveCount(
      0,
    );
    await owner.context().close();
    await colleague.context().close();
  });

  // #101-WM-21, #101-WM-19
  test("a person who comes from the link in the mail signs up, confirms and signs in, and is offered the invitation", async ({
    browser,
  }) => {
    const owner = await newPerson(browser);
    await signIn(owner, OWNER);
    await owner.goto("/w/mail-team/members");
    const form = owner.getByRole("form", { name: "Invite a person" });
    await form.getByLabel("Email address").fill(NEWCOMER);
    await form.getByRole("button", { name: "Send invitation" }).click();
    await expect(
      owner.getByText(`The invitation was sent to ${NEWCOMER}`),
    ).toBeVisible();
    const link = linkOf((await messageTo(NEWCOMER, INVITATION_SUBJECT)).text);

    const newcomer = await newPerson(browser);
    const response = await newcomer.goto(link);
    expect(response?.headers()["referrer-policy"]).toBe("no-referrer");
    await expect(newcomer.getByText(NEWCOMER).first()).toBeVisible();
    await newcomer.getByRole("link", { name: "Create an account" }).click();
    await expect(newcomer).toHaveURL(/\/sign-up\?invitation=/);
    await signUpAndConfirm(newcomer, NEWCOMER, newcomer.url());
    // With a mail server the invitations of a verified address are listed after the sign-in.
    await signIn(newcomer, NEWCOMER);
    await expect(newcomer).toHaveURL(/\/no-access$/);
    await newcomer
      .getByRole("list", { name: "Invitations" })
      .getByRole("button", { name: /Accept/ })
      .click();
    await expect(newcomer).toHaveURL(/\/w\/mail-team\/projects$/);
    await owner.context().close();
    await newcomer.context().close();
  });

  // #101-WM-19
  test("the invitation of a person is never offered to somebody else, and the inbox holds only mails to the invited addresses", async ({
    browser,
  }) => {
    const owner = await newPerson(browser);
    const stranger = `stranger-${RUN}@e2e.test`;
    await signUpAndConfirm(owner, stranger);
    await signIn(owner, stranger);

    await expect(owner).toHaveURL(/\/no-access$/);
    await expect(owner.getByRole("list", { name: "Invitations" })).toHaveCount(
      0,
    );
    const mails = await readInbox(stranger);
    expect(mails.map((mail) => mail.subject)).toEqual([CONFIRM_SUBJECT]);
    await owner.context().close();
  });
});
