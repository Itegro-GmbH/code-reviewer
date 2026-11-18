// SPDX-License-Identifier: LicenseRef-Proprietary

// The top-level nodes of the lane a run walks (#1078, epic #1077), as a view can draw them: one entry for each node of the document
// of the run's `workflowVersion` as `forTrigger` lists them (the pre-steps of the trigger that started the run, then the shared steps),
// with the ids of everything inside the node (the two branches of an `if`, the body of a `loop`, however deep). The step rows of a run
// are written under the id of the node they run, so these ids tie a row to the top-level node it belongs to
// (`workflow-pages/run-track.ts`). Pure, and free of the database and of the engine, so a run page can use it too.
import { isRecord } from "../workflows/json.ts";
import {
  childrenOf,
  forTrigger,
  readRunDocument,
  type RunDocument,
} from "./document.ts";

/** The longest note of a node taken over: what a person wrote as the node's `description`, cut for a one-line label. */
export const LANE_NODE_NOTE_MAX_CHARS = 80;

export type LaneNodeView = {
  id: string;
  /** What the engine would run it as; a kind it does not run is `unsupported`. */
  kind: "agent" | "action" | "if" | "loop" | "unsupported";
  /** The note a person gave the node (`description`), whitespace folded and cut; null when there is none. The words are the author's: text only. */
  note: string | null;
  /** For an action, the connector it calls (`github.comment`); null for any other node. The words of the document: text only. */
  connector: string | null;
  /** The ids of every node inside this one (branches and bodies), in document order; empty for an agent step and an action. */
  innerIds: string[];
};

const NODE_KINDS: ReadonlySet<string> = new Set([
  "agent",
  "action",
  "if",
  "loop",
]);

function noteOf(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const line = value.replace(/\s+/g, " ").trim();
  if (line === "") return null;
  const characters = Array.from(line);
  return characters.length > LANE_NODE_NOTE_MAX_CHARS
    ? `${characters.slice(0, LANE_NODE_NOTE_MAX_CHARS).join("")}…`
    : line;
}

/** Every id inside `node`, depth first. A document nests a few levels at most; the walk still stops at a depth no saved document reaches. */
function innerIdsOf(node: RunDocument["steps"][number], depth = 0): string[] {
  if (depth > 32) return [];
  return childrenOf(node).flatMap((child) => [
    child.id,
    ...innerIdsOf(child, depth + 1),
  ]);
}

/** The nodes of a document as a run started by `trigger` walks them. */
export function laneNodesOf(document: RunDocument): LaneNodeView[] {
  return document.steps.map((node) => ({
    id: node.id,
    kind: NODE_KINDS.has(node.kind)
      ? (node.kind as LaneNodeView["kind"])
      : "unsupported",
    note: noteOf(node.description),
    connector:
      node.kind === "action" &&
      isRecord(node) &&
      typeof node.connector === "string"
        ? node.connector.slice(0, 80)
        : null,
    innerIds: innerIdsOf(node),
  }));
}

/**
 * The top-level nodes of the lane version a run started with, from the stored text of that version's document. Empty when the text is
 * no document the engine can read, or when the document has no longer a trigger like the one that started the run: the run then shows
 * no track (and still shows everything else).
 */
export function laneNodesOfRun(
  documentText: string | undefined,
  trigger: { id: string | null; kind: string },
): LaneNodeView[] {
  if (documentText === undefined) return [];
  const document = readRunDocument(documentText);
  if (document === undefined) return [];
  const walked = forTrigger(document, trigger);
  return walked === undefined ? [] : laneNodesOf(walked);
}
