// SPDX-License-Identifier: LicenseRef-Proprietary

// The status of a workflow run or of one of its steps as a quiet badge: the label as text, a symbol and a soft tone, so the status is
// never told by colour alone (the same rule as the badge of an Implementer run). The symbol is hidden from assistive technology: the
// label is the accessible name.
import {
  ChatCircleDotsIcon,
  CheckIcon,
  HourglassIcon,
  MinusIcon,
  PlayIcon,
  ProhibitIcon,
  XIcon,
} from "@phosphor-icons/react/dist/ssr";
import type { Icon } from "@phosphor-icons/react";
import { InfoHint } from "../components/info-hint.tsx";
import { Badge } from "../components/ui/badge.tsx";
import { RUN_STATUS_COPY, STEP_STATUS_COPY } from "./messages.ts";

type Status =
  | "pending"
  | "running"
  | "waiting"
  | "succeeded"
  | "failed"
  | "skipped"
  | "cancelled"
  | "discarded";

const ICON: Record<Status, Icon> = {
  pending: HourglassIcon,
  running: PlayIcon,
  waiting: ChatCircleDotsIcon,
  succeeded: CheckIcon,
  failed: XIcon,
  skipped: MinusIcon,
  cancelled: ProhibitIcon,
  discarded: ProhibitIcon,
};
const TONE: Record<
  Status,
  "neutral" | "running" | "success" | "danger" | "warning"
> = {
  pending: "neutral",
  running: "running",
  waiting: "warning",
  succeeded: "success",
  failed: "danger",
  skipped: "neutral",
  cancelled: "neutral",
  discarded: "neutral",
};

function StatusBadge({
  status,
  label,
  hint,
}: {
  status: Status;
  label: string;
  hint?: string | undefined;
}) {
  // A status a newer server wrote is none of these: a neutral symbol and tone, and the status as the label the caller found.
  const StatusIcon: Icon | undefined = ICON[status];
  const badge = (
    <Badge
      variant={TONE[status] ?? "neutral"}
      icon={false}
      data-status={status}
    >
      {StatusIcon === undefined ? (
        <MinusIcon aria-hidden="true" weight="bold" />
      ) : (
        <StatusIcon aria-hidden="true" weight="bold" />
      )}
      {label}
    </Badge>
  );
  if (hint === undefined) return badge;
  return (
    <span className="inline-flex items-center gap-1">
      {badge}
      <InfoHint label={`About the status ${label}`}>{hint}</InfoHint>
    </span>
  );
}

export function WorkflowRunStatusBadge({
  status,
  hint = false,
}: {
  status: keyof typeof RUN_STATUS_COPY;
  /** Add the focusable "?" that holds the description of the status. */
  hint?: boolean;
}) {
  const copy: (typeof RUN_STATUS_COPY)[typeof status] | undefined =
    RUN_STATUS_COPY[status];
  return (
    <StatusBadge
      status={status}
      label={copy?.label ?? status}
      hint={hint ? copy?.description : undefined}
    />
  );
}

export function StepStatusBadge({
  status,
}: {
  status: keyof typeof STEP_STATUS_COPY;
}) {
  const copy: (typeof STEP_STATUS_COPY)[typeof status] | undefined =
    STEP_STATUS_COPY[status];
  return <StatusBadge status={status} label={copy?.label ?? status} />;
}
