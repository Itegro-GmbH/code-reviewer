// SPDX-License-Identifier: LicenseRef-Proprietary

// The list of the AI apps connected to a workspace (#1144), one row per connection, with a revoke button that posts a form (no script). A
// server component's markup: the page reads the list from the service.
import { Button } from "@/components/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatUtc } from "@/ui/format-time";
import type { ConnectedApp } from "../apps/service.ts";
import { AI_APPS_COPY, SCOPE_LABEL } from "./messages.ts";
import type { FactoryScope } from "../scopes.ts";

export function ConnectedAppsList({
  workspaceSlug,
  apps,
}: {
  workspaceSlug: string;
  apps: ConnectedApp[];
}) {
  if (apps.length === 0)
    return (
      <p className="text-sm text-muted-foreground">{AI_APPS_COPY.empty}</p>
    );
  return (
    <Table aria-label="Connected AI apps">
      <TableHeader>
        <TableRow>
          <TableHead>App</TableHead>
          <TableHead>Connected by</TableHead>
          <TableHead>Access</TableHead>
          <TableHead>Connected</TableHead>
          <TableHead>Last used</TableHead>
          <TableHead>
            <span className="sr-only">Revoke</span>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {apps.map((app) => (
          <TableRow key={app.id}>
            <TableCell>{app.clientName}</TableCell>
            <TableCell>{app.own ? "You" : app.userName}</TableCell>
            <TableCell>
              {SCOPE_LABEL[app.scope as FactoryScope] ?? app.scope}
            </TableCell>
            <TableCell>{formatUtc(app.connectedAt)}</TableCell>
            <TableCell>
              {app.lastUsedAt === null ? "Never" : formatUtc(app.lastUsedAt)}
            </TableCell>
            <TableCell>
              <form
                method="post"
                action={`/api/w/${encodeURIComponent(workspaceSlug)}/ai-apps/${encodeURIComponent(app.id)}/revoke`}
              >
                <Button
                  type="submit"
                  variant="destructive"
                  size="sm"
                  aria-label={`Revoke ${app.clientName} of ${app.own ? "yours" : app.userName}`}
                >
                  Revoke
                </Button>
              </form>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
