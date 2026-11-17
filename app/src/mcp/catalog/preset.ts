// SPDX-License-Identifier: LicenseRef-Proprietary

// A preset as the form of the add dialog (#1054). The dialog starts from `presetDefaults`; what it posts is the form of `ui/api.ts`
// (`McpServerForm`), and `presetToForm` builds that same form for a preset and the one value a person enters, so a test can hold the dialog
// to it (`ui/catalog.test.tsx`): a server added from the catalog is the row a server typed by hand with the same name, address and header would be.
import type { McpCatalogEntry } from "./entries.ts";

/** The first values of the dialog for a preset. */
export type PresetDefaults = {
  name: string;
  transport: string;
  url: string;
  auth: "none" | "header" | "oauth";
  /** The header to ask the value for (header entries only). */
  headerName: string | null;
};

export function presetDefaults(entry: McpCatalogEntry): PresetDefaults {
  return {
    name: entry.name,
    transport: entry.transport,
    url: entry.url,
    auth: entry.auth.kind,
    headerName: entry.auth.kind === "header" ? entry.auth.headerName : null,
  };
}

/** The JSON the route reads for this preset; `headerValue` is the secret a person entered (header entries only). */
export function presetToForm(entry: McpCatalogEntry, headerValue = "") {
  const base = {
    name: entry.name,
    transport: entry.transport,
    url: entry.url,
  };
  if (entry.auth.kind === "header")
    return {
      ...base,
      auth: {
        kind: "header" as const,
        headers: [{ name: entry.auth.headerName, value: headerValue }],
      },
    };
  if (entry.auth.kind === "oauth")
    return {
      ...base,
      auth: {
        kind: "oauth" as const,
        clientId: "",
        issuer: "",
        clientSecret: "",
      },
    };
  return { ...base, auth: { kind: "none" as const } };
}
