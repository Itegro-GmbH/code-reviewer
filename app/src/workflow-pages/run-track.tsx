// SPDX-License-Identifier: LicenseRef-Proprietary

// The compact step track of a lane run (#1078): one small segment for each top-level node of the lane, filled by how the node stands,
// and the name of the step the run is at as text. The state is never told by colour alone: the segment of the current step is ringed,
// a node that was not reached is an empty outline and a skipped one a dashed outline, and the whole track has a text alternative
// ("Step 2 of 4: Review, running"). The names are words of the lane's author and are rendered as text.
import { cn } from "../lib/utils.ts";
import { TRACK_COPY } from "./messages.ts";
import {
  trackDescription,
  trackStepTitle,
  type RunTrack,
  type TrackState,
} from "./run-track.ts";

const SEGMENT: Record<TrackState, string> = {
  done: "border-success bg-success",
  running: "border-foreground bg-foreground motion-safe:animate-pulse",
  waiting: "border-warning bg-warning",
  failed: "border-danger bg-danger",
  skipped: "border-dashed border-muted-foreground bg-transparent",
  not_reached: "border-border bg-transparent",
};

export function RunTrackView({
  track,
  className,
}: {
  track: RunTrack;
  className?: string;
}) {
  const current =
    track.current === null ? undefined : track.steps[track.current];
  return (
    <div className={cn("flex min-w-0 flex-col gap-1", className)}>
      <span
        role="img"
        aria-label={trackDescription(track)}
        className="flex items-center gap-1"
      >
        {track.steps.map((step, index) => (
          <span
            key={`${step.id}:${String(index)}`}
            aria-hidden="true"
            data-state={step.state}
            data-current={index === track.current ? "true" : undefined}
            title={`${trackStepTitle(step)}: ${TRACK_COPY.state[step.state]}`}
            className={cn(
              "h-2 min-w-3 max-w-6 flex-1 rounded-full border",
              SEGMENT[step.state],
              index === track.current &&
                "ring-2 ring-foreground ring-offset-1 ring-offset-background",
            )}
          />
        ))}
      </span>
      {current === undefined ? null : (
        // The same words are in the text alternative above; read twice, they would only be noise.
        <span
          aria-hidden="true"
          className="truncate text-xs text-muted-foreground"
        >
          {trackStepTitle(current)}
        </span>
      )}
    </div>
  );
}
