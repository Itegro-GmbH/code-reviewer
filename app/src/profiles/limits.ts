// SPDX-License-Identifier: LicenseRef-Proprietary

// The bounds of a profile (#843, agent workflows, milestone 2). Documented in `docs/profiles.md`.

/**
 * A profile name is what a workflow writes in a step (`"profile": "implementer@2"`, `PROFILE_REF` in `../workflows/resolver.ts`), so it has
 * the same shape: lower case letters, digits, `_` and `-`, starting with a letter or digit, 64 characters at most.
 */
export const PROFILE_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export const DESCRIPTION_MAX_LENGTH = 1000;
/**
 * The system-level text a profile gives the agent, in characters. It travels with every turn of the profile, so it is bounded; the
 * task's own instruction has the same bound (`INSTRUCTION_MAX_LENGTH` of the Implementer form).
 */
export const INSTRUCTIONS_MAX_LENGTH = 20_000;
/** A provider, a model or an entry id inside a model choice. */
export const MODEL_FIELD_MAX_LENGTH = 200;

/** Per workspace, not counting the archived. */
export const PROFILES_PER_WORKSPACE_MAX = 100;
/**
 * Per workspace: archived profiles stay (their versions are history and a turn may have run with one), but not without bound. At the
 * maximum an archive is refused (`PROFILE_ARCHIVE_LIMIT_REACHED`).
 */
export const ARCHIVED_PROFILES_PER_WORKSPACE_MAX = 1000;
export const VERSIONS_PER_PROFILE_MAX = 500;
/** A request body: the profile with its default result schema, far below this. */
export const PROFILE_BODY_MAX_BYTES = 128 * 1024;
/** A profile id as the routes take it; longer is "not found". */
export const PROFILE_ID_MAX_LENGTH = 64;
