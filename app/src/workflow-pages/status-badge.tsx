// SPDX-License-Identifier: LicenseRef-Proprietary

// The status of a workflow run or of one of its steps as a quiet badge: the label as text, a symbol and a soft tone, so the status is
// never told by colour alone (the same rule as the badge of an Implementer run). The symbol is hidden from assistive technology: the
// label is the accessible name.
import {
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
  "pending" | "running" | "succeeded" | "failed" | "skipped" | "cancelled";

const ICON: Record<Status, Icon> = {
  pending: HourglassIcon,
  running: PlayIcon,
  succeeded: CheckIcon,
  failed: XIcon,
  skipped: MinusIcon,
  cancelled: ProhibitIcon,
};
const TONE: Record<Status, "neutral" | "running" | "success" | "danger"> = {
  pending: "neutral",
  running: "running",
  succeeded: "success",
  failed: "danger",
  skipped: "neutral",
  cancelled: "neutral",
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
  const StatusIcon = ICON[status];
  const badge = (
    <Badge variant={TONE[status]} icon={false} data-status={status}>
      <StatusIcon aria-hidden="true" weight="bold" />
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
  const copy = RUN_STATUS_COPY[status];
  return (
    <StatusBadge
      status={status}
      label={copy.label}
      hint={hint ? copy.description : undefined}
    />
  );
}

export function StepStatusBadge({
  status,
}: {
  status: keyof typeof STEP_STATUS_COPY;
}) {
  return <StatusBadge status={status} label={STEP_STATUS_COPY[status].label} />;
}
