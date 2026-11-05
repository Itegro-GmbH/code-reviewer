# fakes/github

The fake GitHub: one HTTP server that speaks every part of GitHub that Code Reviewer talks to, so the
sign in tests and the GitHub integration tests share one fake and one address. The app is pointed at
it with `GITHUB_OAUTH_BASE_URL` (GitHub's web pages: the authorization and the creation of an App) and
`GITHUB_API_BASE_URL` (both set to the fake's address; they default to the real GitHub). The app refuses both unless `ALLOW_TEST_GITHUB_ENDPOINTS=true` is set as
well, because the client secret, the App JWT and the tokens are sent to that address. State is in
memory. Dummy values only.

| File                                | Part                                                                                                               |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `server.ts`                         | The server (`startGithubFake`), the request log, failure injection, the control endpoints.                         |
| `oauth.ts`                          | Sign in: OAuth authorize and token endpoints, the user, e-mail and organization membership.                        |
| `manifest.ts`                       | The GitHub App manifest flow: the creation page, the one-time code, the conversion.                                |
| `registry.ts`                       | The Apps the fake knows (the one registered at start and the ones the manifest flow created), shared by the parts. |
| `app-api.ts`                        | The REST API as the GitHub App uses it: installations, tokens, repositories, pull requests.                        |
| `git-http.ts`                       | Git over smart HTTP: fetch (`git-upload-pack`) and push (`git-receive-pack`) of a registered repository.           |
| `git-fixture.ts`, `git-branches.ts` | The Git repository a test registers, and its branches as the branch endpoints report them.                         |
| `review-api.ts`                     | What a reviewer reads and writes: diff, commits, file contents and comments of a pull request.                     |
| `actions-api.ts`                    | What the workflow actions write (#844): open a pull request, issues with their comments, and labels.               |
| `webhooks.ts`                       | Signed webhook deliveries, `webhookFixture(name)` loads a payload from `../fixtures`.                              |
| `http.ts`                           | Small helpers for answering and reading HTTP messages.                                                             |
| `main.ts`                           | Starts the sign in part as its own process (Playwright).                                                           |

A part is switched on by its options. `clientId` and `clientSecret` give the sign in; `appId` and
`publicKeyPem` give the GitHub App API (give both options of a part or neither); `manifestFlow: true`
(`GITHUB_FAKE_MANIFEST_FLOW=true`) lets apps be created through the manifest flow and switches the sign in and
the GitHub App API on for them even without a first app. A part that is not
switched on answers 404, and its controls (`addUser`, `addInstallation`, ...) are not there. In the
app's tests `startTestGithub()` (`app/src/test-support/github-fake.ts`) starts it with all three parts.

## Sign in

| Endpoint                                                                                     | Behavior                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /login/oauth/authorize`                                                                 | An HTML page with one "Authorize `<login>`" button per account and a "Cancel" button. Needs the registered `client_id` and a `redirect_uri`.                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `POST /login/oauth/authorize/confirm`                                                        | What the buttons post. Redirects to `redirect_uri` with `code` and `state`, or with `error=access_denied` after "Cancel".                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `POST /login/oauth/access_token`                                                             | Exchanges the code (single use, bound to `redirect_uri` and to the PKCE challenge) for an access token. Like GitHub, a refused code is answered with status 200 and an `error` field; answers JSON when asked for it, form encoded otherwise.                                                                                                                                                                                                                                                                                                                                  |
| `GET /user`                                                                                  | The profile for a bearer token: `id`, `login`, `name`, `email` (may be `null`), `avatar_url`. 401 `Bad credentials` for an unknown token.                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `GET /user/emails`                                                                           | The email list; needs the `user:email` scope, else 404 as on GitHub.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `GET /user/memberships/orgs/:org`                                                            | The signed in account's own membership in an organization, like GitHub: an OAuth token needs the `read:org` scope, the user token of a GitHub App needs the App's organization permission "Members" (`DEFAULT_ACCOUNT_PERMISSIONS`; else 403, also for an organization made unreadable with `makeMembershipUnreadable`), 401 for an unknown or revoked token, 404 when not a member, otherwise 200 with `state` (`active` or `pending`), `role` (`admin` is an owner, `member`, `billing_manager`; set with `addOrgMember(org, login, state, role)`) and `organization.login`. |
| `GET /user/installations`                                                                    | The installations of the App the token's user can use (`per_page`, `page`): the personal account's, those of organizations the user is an active member of (any role), and those granted with `grantInstallationAccess`.                                                                                                                                                                                                                                                                                                                                                       |
| `GET /__fake/health`, `POST /__fake/users`, `POST /__fake/org-members`, `POST /__fake/reset` | Control endpoints for tests that run the fake as its own process (Playwright). `POST /__fake/users` takes a JSON `FakeGithubUser`; `POST /__fake/org-members` takes `{ org, login, state? }`.                                                                                                                                                                                                                                                                                                                                                                                  |

The app reads `/user/emails` to get the verified primary address (the account permission "Email addresses"): like
GitHub, the endpoint answers for the user token of a GitHub App only when the app holds that permission (the app
registered at start holds it unless a test calls `setAppAccountPermissions({})`), or, for an OAuth app, with the
`user:email` scope. A client id that was created by the manifest flow only accepts the callback addresses of its
manifest as `redirect_uri`, like GitHub.

| Endpoint                              | Behavior                                                                                                                                                                                                                      |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /applications/:client_id/token` | "Check a token" with the client credentials as basic authentication: 404 for a token that does not exist when the pair is right, 401 when it is not. This is how the app asks whether a client id and secret belong together. |

## The installation page

`GET /apps/:slug/installations/new?state=` shows one pair of buttons per installation the fake holds ("Install on `<account>`", "Ask `<account>` to approve"; a test adds the installation first, which stands for the account the person chooses). The buttons post to `/apps/:slug/installations/confirm`, which redirects to the App's setup URL with `installation_id`, `setup_action` (`install` or `request`, without an installation id) and the `state`, like GitHub. The setup URL is the one in the manifest of an App created through the manifest flow; for the App registered at start a test says it (`setAppSetupUrl(url)`, `POST /__fake/app-setup-url` `{ url }`). Control endpoints: `POST /__fake/org-members` takes `{ org, login, state?, role? }`, `POST /__fake/org-unreadable` takes `{ org }` (the roles in that organization cannot be read), `POST /__fake/installation-access` takes `{ installationId, login }`, and `POST /__fake/tokens` takes `{ login, scope?, clientId? }` and answers `{ token }`: an access token issued without the browser round trip, which is what an installation that signed people in before accounts holds in its database (the update's organization check uses it; in a Vitest test `github.issueAccessToken(login, { scope, clientId })`). `GET /app` reports the owner with `id` (`ownerIdFor(login)`), which the single-tenant auto-attach compares an installation's account with.

## The manifest flow

| Endpoint                                                                              | Behavior                                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /settings/apps/new?state=`, `POST /organizations/:org/settings/apps/new?state=` | The creation page GitHub shows after the browser posts a `manifest` form field: the manifest's name and a "Create GitHub App" button. 422 for a manifest that is not JSON with a `redirect_url`.                                                                                                     |
| `POST /settings/apps/new/confirm`                                                     | What the button posts. Remembers the manifest under a one-time `code` and redirects to the manifest's `redirect_url` with `code` and the `state` it was given.                                                                                                                                       |
| `POST /app-manifests/:code/conversions`                                               | Trades the code for the new App's credentials, once (404 afterwards): id, slug, `client_id`, `client_secret`, `webhook_secret` and `pem`, a real RSA key pair made for the App. The App is registered: its JWTs are accepted by the GitHub App API part, its client credentials by the sign in part. |
| `GET /app`                                                                            | The App named by a valid App JWT: id, slug, owner, permissions and events (the permissions the manifest asked for; the app registered at start reports `setAppPermissions` and its account permissions).                                                                                             |

`github.confirmManifest(postUrl, manifest)` does what the person does (posts the form, presses the button) and resolves
to the address the browser is sent back to; `postedManifests()`, `conversionCodes()` and `registeredApps()` read what
happened. Failures are injected like everywhere (`fail({ pathIncludes: "/app-manifests/", status: 404 })`, `delayMs`).

## The GitHub App API

| Endpoint                                                  | Behavior                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /app/installations`, `GET /app/installations/:id`    | Needs an App JWT: RS256 signature checked against the configured public key, `iss` is the app id, not expired. Each installation reports its `permissions` (#749): the app's, cut down to what `setInstallationPermissions(id, ...)` says the installation accepted. Paged (`per_page`, `page`).                                                                                                                                                                                                                                                                                          |
| `POST /app/installations/:id/access_tokens`               | App JWT. Issues a random installation token (valid one hour of the fake's clock), optionally narrowed by `repository_ids` or `repositories` (names) and by `permissions`. 422 for a repository the installation does not have and for a permission above what the app holds (`setAppPermissions`, default: pull requests and issues write, contents and metadata read) or above what the installation accepted (`setInstallationPermissions`, #749: an App raised to contents write that the installation has not approved yet), 403 for a suspended installation, 404 for a removed one. |
| `DELETE /installation/token`                              | Installation token. Switches that token off (204); later use of it gets 401. `revokedInstallationTokens()` lists them.                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `GET /installation/repositories`                          | Installation token. `{ total_count, repositories }`, paged; only the repositories the token is narrowed to.                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `GET /repos/:owner/:repo/pulls`, `.../pulls/:n`           | Installation token with pull requests read. Open pull requests (`state` supported), one pull request or 404 (also for a repository the token is not narrowed to); 403 without the permission.                                                                                                                                                                                                                                                                                                                                                                                             |
| `GET /repos/:owner/:repo/collaborators/:login/permission` | Installation token with metadata read. `{ permission }`, `none` for a user without an entry.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `POST /__fake/pull-requests`                              | Control endpoint for the fake as its own process: body `{ repository: "owner/name", pullRequest }` (a `FakePullRequest`: `number`, `title`, `state`, `headSha`, `headRef`, `baseRef`, `author`) adds the pull request, replacing one with the same number. 400 for a body that is not one.                                                                                                                                                                                                                                                                                                |
| `POST /__fake/installations`                              | Control endpoint for the fake as its own process: body `{ installation, repositories }` installs the app for the account (or replaces the repositories of an installation that exists). Needs the GitHub App part (`GITHUB_FAKE_APP_ID`, `GITHUB_FAKE_APP_PUBLIC_KEY`).                                                                                                                                                                                                                                                                                                                   |

## What a reviewer reads and writes

The calls the GitHub provider of PR-Agent makes (through PyGithub, with the `token` scheme of the
`Authorization` header), so the runner's real PR-Agent can review a pull request here. They need an
installation token with the permission GitHub asks for (`pull_requests`, `issues`, `contents`,
`metadata`) and a repository the token reaches.

| Endpoint                                                                                  | Behavior                                                                                                                                                                                                      |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /repos/:o/:r`, `.../languages`                                                       | The repository (`default_branch` follows the Git fixture, see below), a language list.                                                                                                                        |
| `GET .../branches?per_page=&page=`, `.../branches/:b`                                     | The branches (see below) and one branch with its commit; `:b` may be percent encoded (`feature%2Fx`). Both need `contents: read`.                                                                             |
| `GET/PATCH /repos/:o/:r/pulls/:n`                                                         | The pull request (head, base, changed files); `PATCH` changes title and body.                                                                                                                                 |
| `GET .../pulls/:n/files`, `.../pulls/:n/commits`, `.../commits/:sha`, `.../compare/:spec` | The diff (`patch`, `additions`, `deletions`) and the commit of the pull request. A `FakePullRequest` carries `files` (`filename`, `baseContent`, `headContent`, `patch`); a small Python change when omitted. |
| `GET .../contents/:path?ref=`                                                             | The file at the head of the pull request (by sha or branch) or at the base (default branch); 404 for anything else, like `AGENTS.md`.                                                                         |
| `GET/POST .../issues/:n/comments`, `GET/PATCH/DELETE .../issues/comments/:id`             | Comments below a pull request, written as `<slug>[bot]` (`appSlug`, default `fake-app`), refused above 65,536 characters with a 422. `revision` counts the writes of a comment, so an edit in place shows.    |
| `GET /rate_limit`, `POST /graphql`                                                        | An answer that lets PR-Agent go on (no review threads).                                                                                                                                                       |
| `GET /__fake/comments?repository=owner/name&number=7`                                     | Control endpoint: the comments below a pull request (`id`, `body`, `login`, `htmlUrl`, `revision`).                                                                                                           |
| `GET /__fake/installation-tokens`                                                         | Control endpoint: every installation token issued so far, to search outputs for them.                                                                                                                         |

Branches (#750): where a test registered a Git repository (`addGitRepository`, `git-fixture.ts`), the branches are its
`refs/heads/*`, read on every call (a branch a test creates afterwards is there at once; the sha is the commit it points
to), and the default branch is the one `createGitRepository(dir, { defaultBranch })` made it with (`main` unless said
otherwise; stored as `init.defaultBranch` in the repository), in the repository endpoints, in the installation
repository listings and in the token answer alike. Where no Git repository is registered, a repository has its default
branch (at `BASE_SHA`) and the branches its pull requests name (the head at the head commit, the base at `BASE_SHA`).
Any other name is a 404 (`Branch not found`). The list is ordered by name and paged like GitHub (`per_page` up to 100,
default 30, and `page`); the GitHub App client puts the default branch first.

Git over HTTP (`git-http.ts`), for the repositories a test registered with `addGitRepository`: the real `git upload-pack`
and `git receive-pack` behind the smart HTTP framing, with the installation token as the Basic password (user
`x-access-token`). Without a valid token the answer is 401, for a repository the token does not reach or nobody
registered 404.

| Endpoint                                                                         | Behavior                                                                                                                                                                                                                             |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /:o/:r.git/info/refs?service=git-upload-pack`, `POST .../git-upload-pack`   | Fetch and clone, as the runner's checkout does. The token needs `contents: read` (403 without).                                                                                                                                      |
| `GET /:o/:r.git/info/refs?service=git-receive-pack`, `POST .../git-receive-pack` | Push (#766), as the Implementer's turn does. The token must have been minted with `contents: write` for the repository (403 for `contents: read`, so for a token minted without a permission list from an app that holds read only). |
| `GET /__fake/pushes?repository=owner/name`                                       | Control endpoint: every push received, `{ pushes: [{ repository, refs }] }` (the `repository` filter is optional). The same list is `github.pushes()`.                                                                               |

A push is judged by Git itself, **stricter than GitHub on purpose**: a new branch is accepted, and so is a push that moves
a branch forward (a fast-forward); a history that is not a fast-forward of the branch (which stops `git push --force` as
well) and the deletion of a branch are refused per ref (`[remote rejected]`, HTTP 200 like GitHub), although GitHub accepts
both on a branch without protection. A test cannot learn from the fake that a client never forces a push: it asserts the
client's own command. The fake accepts whatever else is pushed: a tag, `refs/notes/*` and a fast-forward of the default
branch, so a test asserts that `pushes()` lists only the refs it expects. No hook runs. The repository is a fixture, so a
push to its checked out branch is accepted too and leaves its working tree alone. The pushed branch is there at once for
the branch endpoints above and for a fetch. `github.requests()` has the push as
`{ method: "POST", path: ".../git-receive-pack", refs: ["refs/heads/..."] }`: the names of the refs the client asked
to update (whether or not Git accepted them; the branch endpoints tell what is there), never a token or an object. Only a
request that carries a command is a push: the 4-byte probe a client sends first for a request over 1 MB names no ref and
is neither listed in `pushes()` nor given `refs`. The Git routes answer 401 with `WWW-Authenticate: Basic realm="GitHub"`
like GitHub, so a client with URL credentials or a credential helper retries with them.

Links (`html_url`) point to `https://github.test` unless the fake is started with `selfLinks`
(`GITHUB_FAKE_SELF_LINKS=true` as its own process): then they point to the fake itself, which is what
the runner needs, because it demands that the pull request and the API address of a job are on one
host. Routes that name a commit or a ref (`commits`, `compare`, `contents`) serve the pull request
with that head. A ref that is no head (the default branch, the base commit) is answered only when it
is unambiguous: with one pull request in the repository it is that one's, with several a file is
served when all pull requests that have it agree on its text; everything else is a 404, the fake never
guesses. Not modelled: inline review comments, reviews, the labels of the review part (see the actions above for those of the workflow actions),
check runs and paging (the engine suite's own fake, `runner/tests/engine/fake_github.py`, has the same
limits and stays: it serves the job entry point on its own, with `/api/v3` in its address).

## What the workflow actions write

The calls behind `github.pullRequest.open`, `github.issue.comment` and `github.issue.labels` (#844, `actions-api.ts`). Issues and pull requests
share the numbers of a repository.

| Endpoint                                                             | Behavior                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /repos/:o/:r/pulls`                                            | Opens a pull request from `head` into `base` (both must be branches of the repository: the default branch, the heads of added pull requests, branches added with `addBranch`, or the Git fixture's). Needs `pull_requests: write`, else 403. 422 for a missing title, an unknown branch, `A pull request already exists for <owner>:<head>.` and `No commits between <base> and <head>` (head and base at the same commit). The author is the bot of the app. |
| `GET .../pulls?state=&head=owner:branch&base=`                       | As before, now narrowed by `head` and `base` like GitHub.                                                                                                                                                                                                                                                                                                                                                                                                     |
| `GET/POST .../issues/:n/labels`, `DELETE .../issues/:n/labels/:name` | The labels of an issue added with `addIssue` or of a pull request: list (paged), add (a new label is created, one that is there stays), remove (404 `Label does not exist` for one that is not on it). Need `issues` or `pull_requests` (read for the list, write for the others); 404 for a number that is neither an issue nor a pull request.                                                                                                              |
| `POST/GET .../issues/:n/comments` (issue that is no pull request)    | A comment below an issue, written as the bot (`POST`, needs `issues: write`), and the list of them, paged (`GET`, needs `issues: read`). The comments of a pull request are `review-api.ts`'s.                                                                                                                                                                                                                                                                |

In a test: `addIssue(repo, { number, title, labels? })`, `addBranch(repo, name, sha)`, `issueLabels(repo, n)`, `issueComments(repo, n)` and `pullRequests(repo)`.

## In a Vitest test (same process)

```ts
const github = await startGithubFake({
  clientId: "id",
  clientSecret: "secret",
  appId: "424242",
  publicKeyPem, // SPKI PEM; App JWTs are checked against it
  now: clock.now, // optional: the fake's clock for tokens and JWTs
});

// sign in
github.addUser({
  id: 1,
  login: "octocat",
  name: "The Octocat",
  email: null,
  emails: [],
});
// ... point the app at github.baseUrl ...
const callback = await github.authorize(authorizeUrl, "octocat"); // what the "Authorize" button does
github.failTokenEndpoint({ kind: "status", status: 500 }); // or { kind: "delay", delayMs: 5000 }
github.addOrgMember("my-org", "octocat"); // or (…, "pending"); removeOrgMember undoes it
github.failMembershipEndpoint({ kind: "status", status: 503 }); // or a delay; null is normal again
github.revokeToken(github.issuedAccessTokens()[0]); // the token stops working (401)
github.authorize(authorizeUrl, 2002); // a number is the account id: two accounts can share a login
github.holdTokenRequests(2); // the next two token exchanges are answered together (concurrent sign ins)

// GitHub App API
github.addInstallation({
  id: 4242,
  account: { login: "acme", id: 5001, type: "Organization" },
});
github.setRepositories(4242, [{ id: 7001, fullName: "acme/widgets" }]);
github.omitFromListings(4242, [7002]); // a page boundary that skipped a repository (total_count still counts it)
github.rejectAppJwts(true); // every JWT answered with 401
github.setAppPermissions({ metadata: "read", pull_requests: "read" }); // token requests above this get 422
github.setInstallationPermissions(4242, { metadata: "read", contents: "read" }); // what installation 4242 accepted (#749)
github.answerTokensWith({ repository_selection: "all" }); // a token answer that claims to be broader than asked
github.pullRequestComments("acme/widgets", 7); // the comments below a pull request: id, body, login, htmlUrl, revision
github.addPullRequestComment("acme/widgets", 7, "text"); // written as <slug>[bot] unless a login is given
github.tokenRequests(); // per access token request: repositories, repositoryIds, permissions (null when not sent)
github.revokedInstallationTokens(); // tokens switched off with DELETE /installation/token

// both parts
github.fail({
  pathIncludes: "/installation/repositories",
  status: 503,
  times: 1,
}); // or delayMs, headers; any path except the /__fake/* control endpoints
github.fail({
  method: "POST",
  pathIncludes: "/issues/",
  status: 403,
  message: "You have exceeded a secondary rate limit.",
}); // only POSTs (method), or `body` for an answer of your own (a 200 with a list); a 403 with no Retry-After / x-ratelimit-remaining header is GitHub's secondary limit when the message says so (#844)
github.fail({
  pathIncludes: "/app/installations",
  responseDelayMs: 300,
  times: 1,
}); // a slow answer that reflects the state when the request arrived (GitHub App API answers)
github.fail({ pathIncludes: "/pulls/", hang: true }); // never answers; stays open until the client gives up
github.fail({ pathIncludes: "/pulls/", hangBody: true }); // sends the headers and the first byte of the answer, then stalls
github.abortedRequests(); // requests the client closed before an answer was complete (an aborted request, not one merely no longer waited for)
github.requests(); // method and path of every request (a push also its ref names), no credentials
github.pushes(); // every push received: the repository and the ref names (#766)
github.seenCredentials(); // every JWT or token received, to search outputs for leaks
github.reset(); // all state, the request log and the injected failures (not failTokenEndpoint / failMembershipEndpoint)
await github.close();
```

`app/src/test-support/auth-harness.ts` wraps the sign in side together with a real database and the
app's real Better Auth instance. `app/src/test-support/github-app-harness.ts` builds the environment
that points the app's GitHub App settings at the fake. Both start the fake with
`startTestGithub()` unless a test hands them an instance, so a test can use one fake for both.

## Webhooks

`webhooks.ts` signs and builds deliveries like GitHub (`X-Hub-Signature-256`, `X-GitHub-Event`,
`X-GitHub-Delivery`): `webhookDelivery({ event, payload, secret })`. `webhookFixture(name)` loads a
payload from `fakes/fixtures/github-webhooks/<name>.json`: payloads reduced to the fields Code Reviewer
reads, with dummy data, named `<event>.<action>[.<variant>].json`.

## As its own process (Playwright, later the Docker test stack)

```sh
GITHUB_FAKE_CLIENT_ID=id GITHUB_FAKE_CLIENT_SECRET=secret GITHUB_FAKE_PORT=4010 node fakes/github/main.ts
```

`app/playwright.config.ts` starts it next to the app with fixed dummy credentials, including the
public half of the throwaway GitHub App key (`GITHUB_FAKE_APP_ID`, `GITHUB_FAKE_APP_PUBLIC_KEY`; the run enters
the App with its private half in the admin portal of the apps, `e2e/setup/prepare-apps.e2e.ts`) and
`GITHUB_FAKE_MANIFEST_FLOW=true`, so the process serves the sign in, the GitHub App API and the manifest flow. Each journey
adds the accounts and installations it needs (`app/e2e/helpers/github-fake.ts`: `POST /__fake/users`,
`POST /__fake/installations` with `{ installation, repositories }`) and never resets the fake, because
other spec files run at the same time.

## Not covered yet

Inline review comments and reviews, and delivering webhooks over HTTP to a running app (the
journeys sign and send them themselves, `app/e2e/helpers/webhooks.ts`).
