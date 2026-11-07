// SPDX-License-Identifier: LicenseRef-Proprietary

// A native `<select>` in the look of the kit's inputs (#925): a dialog or a drawer with two or three fixed choices does not need the
// popover of the Radix select, and a native one is read and operated by every assistive technology as it is.
import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

export function NativeSelect({
  className,
  ...props
}: ComponentProps<"select">) {
  return (
    <select
      data-slot="native-select"
      className={cn(
        "h-10 w-full min-w-0 rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground transition-all hover:border-muted-foreground disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}
