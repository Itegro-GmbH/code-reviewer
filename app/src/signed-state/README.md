# Signed state

The `state` value of a round trip through the browser and GitHub: the manifest flow that creates the GitHub
App (`src/github-config/`) and the authorization that links a GitHub identity to an account
(`src/github-signin/`). The decision is in `docs/decisions/0001-editions-setup-and-accounts.md`, sections
2.4 and 2.9.

| File       | Role                                                                                                                                                                                            |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `state.ts` | `createSignedStates`: `issue` (a signed value and its row), `consume` (verify and use up, once) and `peek` (the same checks, not used up); `purposeOfState` tells which flow a value belongs to |

- The value is `<base64url JSON of purpose, nonce, expiry, user, session hash and, for a flow of a workspace, the workspace>.<mac>`, signed with HMAC-SHA256 under a key
  derived from `APP_SECRET` for the purpose `state-signing` (`src/crypto/sign.ts`, constant time
  comparison). It is integrity protected, not secret; it contains no credential.
- The nonce is also the id of a row in `signed_states`. `consume` accepts a state only when the signature
  matches, the purpose is the expected one, it has not expired, the person and the session that present it are
  the ones that started it, and the row exists and has not been used. The row is used up by one guarded
  statement (`update ... where used_at is null and expires_at > now`), so a state works once on every
  instance, whatever the timing of two requests.
- The refusal is a stable code (`state_invalid`) that does not say which of the checks failed, so a forged
  value learns nothing.
- Rows are removed by the clean-up of `src/maintenance/` once they have expired.
- The purposes are `github-manifest`, `github-link` and, for the binding of installations to workspaces
  (`src/installation-binding/`), `github-install`, `github-authorize` and `github-picker`; `jira-connect` for the round trip through Atlassian's consent page when a workspace connects a Jira Cloud site (`src/jira/`, #1037); `mcp-connect` for the round trip through an MCP server's authorization server (`src/mcp/oauth/`, #1051; it keeps the PKCE verifier). A flow of a workspace puts the
  workspace into the signed value (`workspaceId`), so a callback can only act for the workspace the state was made for.
