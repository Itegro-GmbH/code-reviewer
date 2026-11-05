# Setting up the GitHub App

Code Reviewer talks to GitHub as one **GitHub App** of its own. The same App does two jobs: it signs people
in ("Sign in with GitHub", the App's user authorization) and it reviews pull requests (GitHub sends it
webhooks, and it uses short-lived tokens of the App to read pull requests and post the reviews). You set it
up once, in the browser, in the admin portal under **Integrations**: no environment variable is needed.
Plan for about five minutes with the one-click way and about 30 minutes by hand.

What you need before you start:

- The instance runs and its first-run setup is done (you signed in as the instance admin and see `/admin`).
- The public https address of the instance, for example `https://reviews.example.com` (called `<domain>`
  below). It is the `BETTER_AUTH_URL` of the deployment. It must be reachable from the internet, because
  GitHub delivers webhooks to it.
- An owner (or app manager) role on the GitHub account or organization that will own the App.

## Which way

| | One click | By hand |
|---|---|---|
| What you do | Press **Create GitHub App** on the Integrations page, press the green button on GitHub | Fill in GitHub's form with the values below, copy six values into the portal |
| Credentials | Come back to the portal by themselves, never visible to you | You copy the private key and the secrets |
| When to use it | Almost always | An App that exists already, or when GitHub's manifest page is not an option |

Both end the same way: the App id, slug, private key, webhook secret, client id and client secret are in the
portal's encrypted secret store, and none of them is ever shown again.

## One click

1. Open **Integrations** in the admin portal, **Create the App with one click**.
2. Change the name if you like (GitHub names must be unique, at most 34 characters). To create the App under an
   organization instead of your own account, enter the organization.
3. Press **Create GitHub App**. GitHub opens with everything filled in; press **Create GitHub App** there.
4. GitHub sends you back to the portal, which saves the credentials. The tile shows **Configured**.
5. Install the App on your repositories (see [Install the App](#install-the-app)).

On a single-tenant instance the App is created **private** (only the account that owns it can install it); on a
multi-tenant instance it is created **public**. The portal remembers what it asked for.

The portal sends GitHub a signed, single-use, short-lived value with this step and checks it when GitHub
returns; a callback that does not carry it (a forged one, an old one, one from another session) stores nothing.

## By hand

Open the form: for a personal account `https://github.com/settings/apps/new`, for an organization
`https://github.com/organizations/<org>/settings/apps/new` (Settings > Developer settings > GitHub Apps > New
GitHub App). The portal shows the four addresses below under **Addresses to enter on GitHub**. Fill in
exactly this and leave every other field at its default:

| Field | Value |
|---|---|
| GitHub App name | A name that is unique on GitHub, for example `Code Reviewer <Team>`. The App's *slug* is derived from it (lower case, dashes), and the bot shows up in pull requests as `<slug>[bot]`. |
| Description | Optional, for example "Automatic pull request reviews". |
| Homepage URL | `https://<domain>` |
| Callback URL | `https://<domain>/api/auth/callback/github` (the sign in with GitHub) |
| Expire user authorization tokens | Leave as is. |
| Request user authorization (OAuth) during installation | **Unchecked.** |
| Enable Device Flow | **Unchecked.** |
| Setup URL | `https://<domain>/github/connected` |
| Redirect on update | **Checked.** |
| Webhook > Active | **Checked.** |
| Webhook URL | `https://<domain>/api/webhooks/github-app` (one URL for every installation and every event) |
| Webhook secret | A long random string (`openssl rand -hex 32`). Keep it at hand: you enter it in the portal. |
| SSL verification | **Enable SSL verification.** |
| Permissions | As in [Permissions](#permissions). |
| Subscribe to events | As in [Events](#events). |
| Where can this GitHub App be installed? | **Only on this account** for a single-tenant instance; **Any account** for a multi-tenant one. |

Then press **Create GitHub App**, and collect the values on the App's settings page
(`https://github.com/settings/apps/<slug>`, or the organization equivalent):

1. **App ID**: the number at the top of the page (*About*).
2. **Slug**: the last part of the App's public link `https://github.com/apps/<slug>`.
3. **Private key**: *Private keys* > **Generate a private key**. Your browser downloads a `.pem` file and
   GitHub keeps no copy.
4. **Webhook secret**: the string you entered in the form.
5. **Client ID** and a **client secret** (*Generate a new client secret*): these are what makes "Sign in with
   GitHub" work.

Enter them under **Integrations > Enter the values by hand** and press **Save and check**. Nothing is saved
before GitHub confirms that the values belong together: the key must be an RSA private key, a call with the
App's JWT must name your App id and slug, and GitHub must accept the client id and secret as a pair. A value
GitHub does not accept is named at its field. The check of the client secret is a call that GitHub answers the
same way for a client id it does not know, so a wrong client id shows at the first sign in.

Tick **This App can only be installed on its own account** if that is what you chose above: GitHub's API does
not report it, and the portal needs it to decide whether a new installation of a single-tenant instance may
be attached to its workspace without asking.

**Leaving a field empty keeps what is saved**, but only while it still belongs to the same App: if you change
the App id, enter the key and the webhook secret again; if you change the client id, enter the client secret
again. Otherwise one wrong click could send the saved secrets to another App.

## Permissions

The manifest of the one-click way asks for exactly this, and the form of the way by hand needs exactly this. A
test (`setup-doc.test.ts` next to the manifest code) fails when these tables and the code disagree, so change
both together.

### Repository permissions

Set these five and nothing else.

| Permission (API name) | Access | What the app uses it for |
|---|---|---|
| Pull requests (`pull_requests`) | Read and write | Read the pull request (head commit, state, draft); post the review and inline comments |
| Issues (`issues`) | Read and write | Pull request conversation comments are issue comments: the persistent review comment; labels and reactions on comments |
| Contents (`contents`) | Read-only | Read the changed files and the other repository files a review needs, such as `AGENTS.md`. The app never pushes, except in a deployment with the Implementer, where Contents is Read and write ("The Implementer" below) |
| Metadata (`metadata`) | Read-only | Mandatory for every app: list the installation's repositories and ask whether a commenter has write access |
| Checks (`checks`) | Read and write | The **check run** "Code Reviewer" in the checks area of the pull request (waiting, reviewing, finished). Only the App itself writes it, with a token of its own; a review job never gets this permission |

The code asks for the first four permissions when it creates the token of a review job, scoped to the single
repository of that job (`JOB_TOKEN_PERMISSIONS` in
`app/src/integrations/providers/github-app/job-access.ts`). `pull_requests` is also what the App uses to submit the
review verdict (`APPROVE` or `REQUEST_CHANGES`, see [Check runs and the review verdict](#check-runs-and-the-review-verdict)).

### Account permissions

| Permission (API name) | Access | What the app uses it for |
|---|---|---|
| Email addresses (`emails`) | Read-only | Read the verified primary email of a person who signs in with GitHub. The sign-up rule is applied to it, and it replaces the placeholder address of a user who was imported from an earlier version |

### Organization permissions

| Permission (API name) | Access | What the app uses it for |
|---|---|---|
| Members (`members`) | Read-only | Read a person's role in an organization with their user token, when a workspace connects an installation of that organization |

An App made by hand without these permissions still
reviews pull requests, but signing in with a GitHub account and binding organization installations need the
account and organization permissions, and the check run needs **Checks**.
The Integrations page lists them, and **Check the permissions** asks GitHub which of them the App really lacks.
After you add a permission in the App's settings, every installation has to accept the changed permissions on
GitHub (GitHub asks the installing account).

### Check runs and the review verdict

A review shows up in the checks area of its pull request as the check run **Code Reviewer**: *Waiting* when the
job is queued, *Reviewing* while a Worker runs it, and a conclusion when it ends. **It is never red**: a finished
review is `success` and everything else (a failure, a timeout, a cancel, a newer commit that replaced the run) is
`neutral` with the reason in words. The App writes it, not the Worker, so it also covers runs that end without a
Worker (a lost lease, the hard time limit, the cron sweep).

**An existing installation or an App made by hand has no Checks permission** until you add it in the App's settings
(*Repository permissions > Checks: Read and write*) and accept the changed permissions on each installation. Until
then nothing breaks: reviews run and are published as before, no check run appears, and the log says
`CHECK_RUN_PERMISSION_MISSING` (once per job, ids only). **Check the permissions** on the Integrations page lists
*Checks* as missing.

After a successful review the App also submits a pull request review as itself: `REQUEST_CHANGES` when the review
found blocking findings, otherwise `APPROVE`, with a one line body and a link to the review comment. A later run on a
new push submits a new review, which replaces the earlier verdict of the App on GitHub (a reviewer's latest review
counts). Human reviews are never touched, and a failed, cancelled or superseded run submits nothing. Which findings
block is a project setting, **Review verdict**, next to the review kind:

| Value | Dynamic Review | Diff Review (PR-Agent has no severities) |
|---|---|---|
| `off` | no review is submitted; the App's own earlier request for changes is dismissed on the next run | the same |
| `blocking` (default) | `REQUEST_CHANGES` while a P0 finding is open, otherwise `APPROVE` | no review is submitted: a review without severities cannot tell a blocker from a nit |
| `any` | `REQUEST_CHANGES` while any finding is open, otherwise `APPROVE` | `REQUEST_CHANGES` while a finding is active, otherwise `APPROVE` |

**When no verdict is submitted, an earlier one stays.** The App approves only a review that is whole: one that stopped
at its cost or time limit, dropped a finding its validation refused, left files out of the diff or failed a chunk,
made no model call or did not report its findings submits **no** review, and the check run says so and why. Such a
run does not dismiss an earlier `REQUEST_CHANGES` of the App (it fails closed): a complete review on a later push
replaces it. Only the setting `off` dismisses it, with a message, and only the App's own latest request, found by the
author and the marker in its body, and every such request that stands (not only the latest); a review of a person is
never dismissed, whatever its text says. The App asks GitHub about this only for a pull request on which its own record
shows a request for changes, so `off` costs nothing elsewhere; a request the record does not know of is dismissed by hand. A Diff project
under `blocking` never gets a verdict, so no later review replaces such a request (for example after a project
changed from Dynamic to Diff Review): choose `any` for it, or `off` to have it dismissed, or dismiss it by hand. The
check run says this.

**The verdict comes from the model and can be wrong or manipulated.** Text in the diff, the pull request or the
repository can try to talk a model into reporting no finding, and a review that fails in a way the runner does not
see can look clean. The App guards what it can (no approval without a model call, without a complete review or with
findings it dropped), but it is no gate. Treat the `APPROVE` as advice.

**Branch protection.** GitHub documents "Require approvals" as approvals from people with write permission, and does
not say whether the approval of a GitHub App counts (it does not for the Actions bot; reports on a dedicated App
disagree). Do not rely on the `APPROVE` of Code Reviewer in either direction. To require a human approval anyway,
turn on **Require review from Code Owners** with a `CODEOWNERS` file that names people or teams: the App cannot be a
code owner, so only a human approval satisfies that rule (or set the project's Review verdict to `off`). Because the
verdict can be manipulated (above), a human code owner is also the answer to a pull request that tries to approve
itself.

**Updating an existing installation.** Every project that exists now starts to submit verdicts with the first review
after the update (the default is `blocking`): a Dynamic project approves or requests changes, a Diff project does
not (it has no severities). To keep a project as it was, set its **Review verdict** to `off` under the project's
settings, before or after the update. The check run needs the Checks permission (above) and appears for new jobs only.

**When GitHub cannot be reached or refuses.** The App never fails a job over a check run or a review. A call that
cannot reach GitHub is repeated twice at once (after one and after three seconds), then the job is retried by the
sweep, the timer or the next request: at most five times, but about fifteen hours (the waits grow to an hour) while a
check run is open on GitHub, so an outage does not leave "Reviewing" on a pull request that ended long ago. A
hosted deployment retries from the sweep every two hours and from the requests that touch the database. What stays as
it is on GitHub, because it cannot be written any more, is logged by a stable code (ids only): a repository that was
archived (`CHECK_RUN_REPOSITORY_ARCHIVED`) or that left the installation (`CHECK_RUN_REPOSITORY_NOT_ACCESSIBLE`), an
installation that is gone, and a connection a person disconnected; a check run that was open then stays open until it
is removed on GitHub. A missing permission is told from these by what GitHub answers (`CHECK_RUN_PERMISSION_MISSING`
only for "Resource not accessible by integration"). The **Re-run** button of a check run does nothing: the App does
not subscribe to `check_run` events; a new push, or `/review`, runs the review again.

## The Implementer

This section applies only to a deployment whose capability set has `implementer` (the Software Factory, `PRODUCT_CAPABILITIES`).
The tables above are those of every deployment, including code-review.com, whose App never gets write access to code: its
manifest is unchanged. The Implementer pushes branches, so the App of such a deployment asks for one repository permission
more, or rather one level more:

| Permission (API name) | Access | What the app uses it for |
|---|---|---|
| Contents (`contents`) | Read and write | Push the branch of an Implementer task to the repository. Everything else stays as in the tables above (including **Checks**, `checks: write`) |

The manifest of the one-click way asks for it, and the form of the way by hand needs it (change Contents from Read-only to
**Read and write**). A test (`setup-doc.test.ts`) keeps this table and the manifest together.

**Order.** The manifest is built from the capability set of the running deployment, so the one click asks for Contents Read and
write only after the deploy that puts `implementer` into `PRODUCT_CAPABILITIES` is live. Click before it and the App is created
with Contents Read-only and has to be updated by hand, below. After the click, check on GitHub (the App's settings,
*Permissions*) that Contents reads Read and write, and that **Check the permissions** in the portal lists nothing missing.

The token of an Implementer turn is made for one repository and holds exactly `contents: write` and `metadata: read`
(`IMPLEMENTER_TOKEN_PERMISSIONS` in `app/src/integrations/providers/github-app/job-access.ts`): no pull requests, no issues, no
checks. A review job keeps its token (`JOB_TOKEN_PERMISSIONS`, Contents read-only).

**Workflow files cannot be pushed.** GitHub rejects a push that creates or changes anything under `.github/workflows/`
unless the App holds the `Workflows` permission. This App does not ask for it and never will for this purpose, so such a
push is rejected by GitHub and the task reports it; change workflow files by hand.

### Update an existing App

An App that was created from the earlier manifest holds Contents as read-only, and **nothing changes by itself**. Until it is
updated the Implementer refuses the repository: the form lists it as disabled with the note "approve the new GitHub permission", and a task for it is
answered `IMPLEMENTER_WRITE_NOT_GRANTED` (a job that gets that far ends `git_write_not_granted`):

1. In the App's settings on GitHub (*Permissions & events > Repository permissions*), set **Contents** to **Read and write**
   and save. **Check the permissions** on the Integrations page then no longer lists *Contents*.
2. Every installation has to accept the changed permissions: GitHub asks the account that installed the App (the user, or an
   owner of the organization). Until it does, the installation keeps Contents read-only. A token for it is refused by GitHub
   (HTTP 422), which the app reports with the stable code `INTEGRATION_ACCESS_PERMISSION_NOT_GRANTED` (not retried), and the
   installation shows as not granted before a task is accepted.
3. An App that is created after `implementer` was added to the capability set asks for the permission from the start and only
   needs to be installed as usual.

## Events

Under *Subscribe to events* tick **Pull request** and **Issue comment**, and **Issues** when workflows with the
[label trigger](workflows.md#the-label-trigger) are used (the `issues` row below). The other two events below have
no checkbox: GitHub sends them to every app that has a webhook.

| Event | Subscription | What the app does with it |
|---|---|---|
| `pull_request` | Tick "Pull request" | A pull request was opened, reopened, marked ready for review or got new commits: becomes a review trigger |
| `issue_comment` | Tick "Issue comment" | A comment on a pull request that starts with `/review` from somebody with write access becomes a command trigger (the removed `/ask`, `/improve` and `/describe` are ordinary comments) |
| `issues` | Tick "Issues" (only for the [label trigger](workflows.md#the-label-trigger) of a workflow; an App made from the manifest does not subscribe to it yet, tick it by hand) | A label put on an open issue by a user account (sender type `User`; a machine account with a personal access token is one) starts the workflows of the workspace that wait for that label, but only one running run of a workflow for one issue. Pull requests, bots, organizations, other actions (`opened`, `edited`, `unlabeled`, ...) and closed issues start nothing. **An issue created from a template or form with `labels:` gets them when it is created, and that starts a run: keep the trigger label out of every issue template, above all in a public repository** |
| `installation` | Always sent, nothing to tick | The app was installed, removed, suspended or unsuspended: creates or disables the installation in the app |
| `installation_repositories` | Always sent, nothing to tick | Repositories were added to or removed from an installation: keeps the repository list current |

Every other event (for example GitHub's `ping`, or `push`) is answered with `202` and ignored. The list is the
set of events the webhook code reads (`webhook-fields.ts` next to `job-access.ts`).

## Sign in with GitHub

The App's user authorization signs people in. The login page offers **Sign in with GitHub** exactly while the
integration is configured with a client id and secret and GitHub is switched on as a way to sign in (Setup).

- The sign-up rule (Setup) is applied to the **verified primary email address** that GitHub reports. An
  account without one is refused; nothing is created for it.
- A GitHub account is matched by its numeric GitHub id. Signing in again, after a rename too, is the same user.
- A GitHub account whose verified address is the address of an existing account is linked to it only when the
  existing account's address is verified too. An address alone never joins two accounts.
- You can also link a GitHub account from the account page ("Your account") while you are signed in: GitHub asks
  you to authorize the App, which proves the account is yours.

### An App made without the user authorization

The Integrations page then shows **Enable sign-in with GitHub**: it names the callback address
(`https://<domain>/api/auth/callback/github`) to add under *Callback URL* in the App's settings, and takes the
client id and a client secret.

Until the user authorization is configured, "Connect GitHub" in a workspace is unavailable on a multi-tenant
instance, and the page says so.

### Linking your own GitHub account as the admin

An instance that ran before accounts existed has your operator account twice: as an imported user (your GitHub
identity, no password) and as the instance admin you created in the setup (email and password). Under
**Integrations > Your GitHub account** press **Link GitHub account** and authorize on GitHub. If that GitHub
account belongs to an imported user without any other way to sign in, the two accounts are **merged**: its
memberships and history become yours, the higher role wins where you are both members, and the imported user
is retired. That is one irreversible transaction. It is available only to the instance admin and only for
users the import marked; a GitHub account of a user with a password is refused with a message, and nothing
moves. Afterwards you can make GitHub the only way to sign in (Setup).

### Placeholder addresses

An imported user has a placeholder address (`<id>@users.noreply.github.com`). At their next sign in with GitHub
it is replaced by GitHub's verified primary address. If another account has that address already, the
placeholder stays, nothing is taken over or merged, and a hint is shown on the user's account page and to the
instance admin.

## Install the App

Anybody can install a public App, so an installation is **not** reviewed until a workspace has linked it
(`docs/decisions/0001-editions-setup-and-accounts.md`, section 2.9). An Owner or Admin of the workspace does that:

1. Open the workspace's **Connections** page and press **Connect GitHub**. GitHub shows the App's installation page.
2. Pick the account or organization, and choose **Only select repositories**. Select the repositories the team
   wants reviewed. Granting "All repositories" is possible but not recommended. Confirm the permission list GitHub
   shows and press Install.
3. GitHub brings you back to the app (the Setup URL) and asks you to authorize the App. That proves two things with
   *your own* GitHub token, which is used once and never stored: that you can use the installation, and that you
   are the owner of the personal account, or an owner of the organization. A member of an organization who is not
   an owner cannot connect its installation, and neither can somebody who only has access to a repository.
   (If you are not allowed to install the App on an organization, GitHub asks its owners instead; once they
   approved, use **Link an existing installation** on the Connections page.)
4. The repositories of the installation appear under **Projects** of that workspace, and in no other. An
   installation belongs to one workspace only.

If GitHub does not let the App read your role in the organization (the App lacks the organization permission
*Members*, see [Permissions](#permissions)), nothing is linked: the request goes to the instance admin, who sees who
asked, the account and the evidence under **Approvals** in the admin portal and approves or denies it.

A single-tenant instance whose App is **private** (it can only be installed on its own account) attaches an
installation on that account to its one workspace by itself, without this round trip. Everything else needs
Connect GitHub. An installation made by somebody else is only listed under **Approvals** as "nobody has linked it".

The `installation` delivery GitHub sends shows **202** in the App's *Recent Deliveries*; the body says
`installation_unclaimed` while nobody has linked the installation, and `installation_changed` for a linked one.

Newly synced repositories are **inactive**: a repository is reviewed only after it was activated as a project in
the application. Open the workspace's **Projects** page, press **Sync from GitHub** (Owners and Admins see the button;
it reads the workspace's own connections) if the repository is missing, and switch the repository on. The API call
`PUT /api/w/:workspace/repositories/:repositoryId/project` of a signed-in user stays available for scripts (see
`app/src/projects/README.md`).

## Check the webhook

1. Open the App's settings page > **Advanced** > *Recent Deliveries*. If there is a `ping` delivery from when the
   App was created, open it and press **Redeliver**. If there is none, the `installation` delivery of the
   installation is the first check.
2. The delivery must show a green tick and the response **202** (`event_not_used`: a signed `ping` is genuine
   but not an event the app uses).

| Answer | Meaning |
|---|---|
| 202 | Signature correct. |
| 401 | The signature does not match the webhook secret in the portal (or no GitHub App is configured). |
| 400 / 413 | The delivery is malformed or larger than 1 MB. Not seen with GitHub's own deliveries. |
| Timeout, 502, 503 | The application is not reachable: check the domain, the proxy and that the container is healthy (`/api/health`). |

## Private key and secrets

- The `.pem` file is a credential: whoever has it can act as the app on every repository it is installed on. With
  the one-click way you never see it. With the way by hand, store it in the team's **password manager** and
  **delete the downloaded file** from the laptop and the Downloads folder. It does not belong in the repository
  (`*.pem` is in `.gitignore`, and a test scans every tracked file for key blocks and token patterns), in
  Confluence, in Jira, in a chat, in an e-mail, or in a screenshot.
- The private key, the webhook secret and the client secret are stored encrypted (AES-256-GCM, a key derived from
  `APP_SECRET`) and are never shown again, never logged and never part of an answer. **Back `APP_SECRET` up apart
  from the database:** a database restored without it loses every stored credential, and the portal then asks
  you to enter them again.
- A replaced webhook secret counts from the next delivery, on every app instance: nothing is cached.
- **Rotating the private key:** on the App's settings page generate a *second* key, enter it in the portal
  (**Enter the values by hand**, the other fields stay), check that a delivery or a review works, then delete the
  old key on GitHub. Update the password manager entry.
- **Rotating the webhook secret:** change it on GitHub and in the portal. Deliveries sent in between are answered
  with 401: redeliver them under *Recent Deliveries* (a redelivery uses the same delivery id and is handled
  normally).
- **Lost key:** generate a new one as above. There is no way to download the old one again.

## Checklist for whoever sets it up

- [ ] The App exists (one click, or by hand with the addresses and settings above), webhook active, SSL
      verification enabled
- [ ] Permissions: Pull requests Read and write, Issues Read and write, Contents Read-only (Contents Read and write for a
      deployment with the Implementer, see "The Implementer"), Metadata Read-only, Checks Read and write, Email addresses
      Read-only, Members Read-only, and nothing else
- [ ] Events: Pull request and Issue comment ticked
- [ ] The tile on Integrations shows **Configured**, and **Sign in with GitHub** is enabled
- [ ] Only for the way by hand: the `.pem` file is in the password manager and deleted from the laptop
- [ ] `ping` redelivered: 202
- [ ] Installed on the team's repositories (selected repositories), `installation` delivery shows 202
- [ ] `APP_SECRET` is backed up apart from the database

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| The tile shows **Problem** and names `github_app_private_key` or another secret | The secret was saved with another `APP_SECRET`, or the stored value was changed. Enter it again (**Enter the values by hand**). |
| "GitHub refused the key of the App" when saving | The private key does not belong to the App id you entered. |
| "GitHub knows this App under another slug" | The slug differs from the App's public link. |
| Every delivery is 401 | The webhook secret in the portal differs from the one in the App's settings (watch for a trailing space), or no App is configured. |
| Deliveries time out | The domain does not reach the application, or SSL verification fails because the certificate is not valid. |
| The `installation` delivery is 202 but no repositories show up | The installation has no repositories selected, or GitHub could not be asked: the delivery answer is 503 then, redeliver it. |
| A pull request or a command produces no review trigger | The repository is not an active project (the delivery answer says `project_not_active`), or the commenter has no write access (`ignored`). |
| `GITHUB_APP_AUTH_FAILED` in the logs | The private key does not belong to the app with that App id. |
| `GITHUB_APP_FORBIDDEN` in the logs | The installation is suspended, or a permission is missing: compare the app's permissions with the tables above and accept the new permissions on the installation page if GitHub asks. |
| "We could not read the email addresses of your GitHub account" on the login page | The App lacks the **Email addresses** permission (see **Check the permissions**), or GitHub failed. |
| "GitHub reports no verified primary email address" | The person has to verify a primary email address in their GitHub settings. |
