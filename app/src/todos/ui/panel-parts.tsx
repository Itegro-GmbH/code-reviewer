// SPDX-License-Identifier: LicenseRef-Proprietary

// Small pieces the ToDo list and the panels share (#925): a link to an address from GitHub (only an http(s) one is a link; what GitHub
// sent is never put into a link otherwise) and a time as the server and the browser render it the same.
import { useId, useState, type ReactNode } from "react";
import { Button } from "../../components/button.tsx";
import { formatUtc } from "../../ui/format-time.ts";
import { webAddress } from "../../ui/web-address.ts";
import { KEPT_COPY } from "./messages.ts";

export function Time({ iso }: { iso: string }) {
  return <time dateTime={iso}>{formatUtc(iso)}</time>;
}

/** A link that leaves the app: a new tab, no opener. Plain text when the address is not a web address (or none). */
export function ExternalLink({
  href,
  children,
}: {
  href: string | null;
  children: ReactNode;
}) {
  const address = href === null ? null : webAddress(href);
  if (address === null) return <>{children}</>;
  return (
    <a
      href={address}
      target="_blank"
      rel="noopener noreferrer"
      className="font-semibold text-foreground underline"
    >
      {children}
    </a>
  );
}

/**
 * What a person typed in a panel whose ToDo went away under their hands (answered elsewhere, no review asked any more): read-only, with a
 * way to copy it, so a long note is never lost with the form. The text is the person's own and is rendered as text.
 */
export function KeptText({ parts }: { parts: readonly string[] }) {
  const headingId = useId();
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(parts.join("\n\n"));
      setCopied(true);
    } catch {
      // Not allowed here: the text stays on screen to be selected.
    }
  }
  return (
    <section
      aria-labelledby={headingId}
      className="flex flex-col gap-2 rounded-lg border border-border p-3"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id={headingId} className="text-sm font-semibold">
          {KEPT_COPY.heading}
        </h3>
        <Button variant="secondary" size="sm" onClick={() => void copy()}>
          {KEPT_COPY.copy}
        </Button>
      </div>
      {parts.map((part, index) => (
        <p
          key={`${String(index)}-${part}`}
          className="break-words whitespace-pre-wrap"
        >
          {part}
        </p>
      ))}
      <p role="status" className="text-xs text-muted-foreground">
        {copied ? KEPT_COPY.copied : ""}
      </p>
    </section>
  );
}
