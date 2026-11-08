// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";
// How the fields of the inspector ask for the values they can reach (#927): the builder provides one lookup, bound to its current
// document and lane, and every field that can hold a reference reads it. Without a provider a field has no values to offer.
import { createContext, useContext, type ReactNode } from "react";
import type { ReachLookup } from "./api.ts";

const NONE: ReachLookup = () =>
  Promise.resolve({
    ok: false,
    status: null,
    code: "NETWORK_ERROR",
    issues: [],
  });

const ReachContext = createContext<ReachLookup>(NONE);

export function ReachProvider({
  lookup,
  children,
}: {
  lookup: ReachLookup;
  children: ReactNode;
}) {
  return (
    <ReachContext.Provider value={lookup}>{children}</ReachContext.Provider>
  );
}

export function useReachLookup(): ReachLookup {
  return useContext(ReachContext);
}
