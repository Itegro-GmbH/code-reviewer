// SPDX-License-Identifier: LicenseRef-Proprietary

// The catalog of MCP server presets (#1054): every entry has to be something the registry accepts as the form of a server, with no network.
import { describe, expect, it } from "vitest";
import { parseMcpServerInput } from "../input.ts";
import { checkMcpUrl } from "../url.ts";
import { CATALOG_VERSION, MCP_CATALOG } from "./entries.ts";
import { presetToForm } from "./preset.ts";

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

describe("the catalog of MCP server presets", () => {
  it("is versioned and not empty", () => {
    expect(Number.isInteger(CATALOG_VERSION)).toBe(true);
    expect(CATALOG_VERSION).toBeGreaterThanOrEqual(1);
    expect(MCP_CATALOG.length).toBeGreaterThan(0);
  });

  // #1054-T01
  it("holds only entries that the registry accepts: the address passes checkMcpUrl and the form passes the server schema", () => {
    for (const entry of MCP_CATALOG) {
      const url = checkMcpUrl(entry.url, { allowTestEndpoints: false });
      expect(url.ok, `${entry.id}: address`).toBe(true);
      const parsed = parseMcpServerInput(
        presetToForm(entry, "Bearer placeholder"),
        { allowKeep: false, allowTestEndpoints: false },
      );
      expect(parsed.ok, `${entry.id}: form`).toBe(true);
      if (!parsed.ok) continue;
      expect(parsed.value.name, entry.id).toBe(entry.name);
      expect(parsed.value.transport, entry.id).toBe(entry.transport);
      expect(parsed.value.auth.kind, entry.id).toBe(entry.auth.kind);
    }
  });

  // #1054-T01
  it("names a header for a header entry, and no entry needs a query string or a secret in its address", () => {
    for (const entry of MCP_CATALOG) {
      const url = new URL(entry.url);
      expect(url.search, entry.id).toBe("");
      expect(url.username + url.password, entry.id).toBe("");
      if (entry.auth.kind === "header")
        expect(entry.auth.headerName, entry.id).not.toBe("");
    }
  });

  it("has a unique id and a unique name per entry, and the id is a slug", () => {
    expect(new Set(MCP_CATALOG.map((entry) => entry.id)).size).toBe(
      MCP_CATALOG.length,
    );
    expect(
      new Set(MCP_CATALOG.map((entry) => entry.name.toLowerCase())).size,
    ).toBe(MCP_CATALOG.length);
    for (const entry of MCP_CATALOG) expect(entry.id).toMatch(/^[a-z0-9-]+$/);
  });

  it("records where each endpoint was verified and when: an https page of the vendor and a day", () => {
    for (const entry of MCP_CATALOG) {
      expect(new URL(entry.docsUrl).protocol, entry.id).toBe("https:");
      expect(entry.checkedOn, entry.id).toMatch(ISO_DAY);
      expect(Number.isNaN(Date.parse(entry.checkedOn)), entry.id).toBe(false);
    }
  });

  it("shows a monogram, not a logo: one to three letters", () => {
    for (const entry of MCP_CATALOG)
      expect(entry.monogram, entry.id).toMatch(/^[A-Za-z]{1,3}$/);
  });

  it("describes every entry in a sentence and says what access it gives", () => {
    for (const entry of MCP_CATALOG) {
      expect(entry.description.length, entry.id).toBeGreaterThan(10);
      expect(entry.scopeNote.length, entry.id).toBeGreaterThan(10);
    }
  });
});
