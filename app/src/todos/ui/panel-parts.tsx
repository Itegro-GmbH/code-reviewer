// SPDX-License-Identifier: LicenseRef-Proprietary

// Small pieces the ToDo list and the panels share (#925): a link to an address from GitHub (only an http(s) one is a link; what GitHub
// sent is never put into a link otherwise) and a time as the server and the browser render it the same.
import type { ReactNode } from "react";
import { formatUtc } from "../../ui/format-time.ts";
import { webAddress } from "../../ui/web-address.ts";

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
