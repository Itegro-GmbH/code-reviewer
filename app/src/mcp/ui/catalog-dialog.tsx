// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";
// The catalog of presets (#1054): a list of the vendors' remote MCP servers. Choosing one only hands the entry to the add dialog, which is
// prefilled from it; nothing is saved here. A monogram stands in for a logo.
import { Button } from "../../components/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog.tsx";
import { MCP_CATALOG, type McpCatalogEntry } from "../catalog/entries.ts";
import { PAGE_COPY } from "./messages.ts";

function authText(entry: McpCatalogEntry): string {
  if (entry.auth.kind === "oauth") return PAGE_COPY.catalogOauth;
  if (entry.auth.kind === "header")
    return PAGE_COPY.catalogHeader(entry.auth.headerName);
  return "";
}

export function CatalogDialog({
  open,
  onChoose,
  onClose,
}: {
  open: boolean;
  onChoose: (entry: McpCatalogEntry) => void;
  onClose: () => void;
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent aria-label={PAGE_COPY.catalogTitle}>
        <DialogHeader>
          <DialogTitle>{PAGE_COPY.catalogTitle}</DialogTitle>
          <DialogDescription>{PAGE_COPY.catalogDescription}</DialogDescription>
        </DialogHeader>
        <ul className="m-0 flex max-h-[60vh] list-none flex-col gap-2 overflow-y-auto p-0">
          {MCP_CATALOG.map((entry) => (
            <li
              key={entry.id}
              className="flex items-start gap-3 rounded-lg border border-border bg-card p-3"
            >
              <span
                aria-hidden="true"
                className="flex size-10 shrink-0 items-center justify-center rounded-md bg-muted text-sm font-semibold"
              >
                {entry.monogram}
              </span>
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="font-semibold">{entry.name}</span>
                <span className="text-sm text-muted-foreground">
                  {entry.description}
                </span>
                <span className="text-xs text-muted-foreground">
                  {authText(entry)} ·{" "}
                  {PAGE_COPY.catalogChecked(entry.checkedOn)}
                </span>
              </div>
              <Button
                variant="secondary"
                size="sm"
                aria-label={`${PAGE_COPY.catalogOpen} ${entry.name}`}
                onClick={() => onChoose(entry)}
              >
                {PAGE_COPY.catalogOpen}
              </Button>
            </li>
          ))}
        </ul>
      </DialogContent>
    </Dialog>
  );
}
