// SPDX-License-Identifier: LicenseRef-Proprietary

// `json_or_null(text)` (#973): the text as `jsonb`, or null when it is none. The claim and the pairing of the rings read `implementer_turns.model_choice`
// and the manifest migration reads `runners.manifest` in the database, as JSON text that the app wrote; one row that is not JSON must not make the
// statement fail for every other job (a bare `::jsonb` cast raises). The function is the guard in front of the cast.
//
// Expand only: a new function nothing of the previous release calls. `down` drops it.
import { sql } from "kysely";
import type { Migration } from "kysely/migration";

export const migration: Migration = {
  async up(db) {
    await sql`create function json_or_null(input text) returns jsonb
      language plpgsql immutable as $$
      begin
        return input::jsonb;
      exception when others then
        return null;
      end;
      $$`.execute(db);
  },

  async down(db) {
    await sql`drop function if exists json_or_null(text)`.execute(db);
  },
};
