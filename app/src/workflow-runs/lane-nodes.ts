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
  /**
   * A loop: its direct body, in document order, each with what is inside it; empty for any other node. The rounds of a loop are read
   * from these (`workflow-pages/run-track.ts`): a row of a step counts over the whole run, so only the direct children say how often
   * the body has begun.
   */
  body: LaneBodyChild[];
};

export type LaneBodyChild = {
  id: string;
  kind: LaneNodeView["kind"];
  /** The ids of every node inside the child, depth first. */
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

const kindOf = (kind: string): LaneNodeView["kind"] =>
  NODE_KINDS.has(kind) ? (kind as LaneNodeView["kind"]) : "unsupported";

/** The nodes of a document as a run started by `trigger` walks them. */
export function laneNodesOf(document: RunDocument): LaneNodeView[] {
  return document.steps.map((node) => ({
    id: node.id,
    kind: kindOf(node.kind),
    note: noteOf(node.description),
    connector:
      node.kind === "action" &&
      isRecord(node) &&
      typeof node.connector === "string"
        ? node.connector.slice(0, 80)
        : null,
    innerIds: innerIdsOf(node),
    body:
      node.kind === "loop"
        ? childrenOf(node).map((child) => ({
            id: child.id,
            kind: kindOf(child.kind),
            innerIds: innerIdsOf(child),
          }))
        : [],
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

/**
 * The nodes of the lane versions a response mentions, once for each (#1087): a board or a list with many runs of one lane would
 * otherwise repeat the same nodes with every run. A run holds the key of its entry (`nodesKey`) and a view looks the nodes up by it
 * (`laneNodesFor`). A version that cannot be read has no entry (and no key): the run shows no track.
 */
export type LaneNodesByKey = Record<string, LaneNodeView[]>;

/**
 * The key of the nodes a run walks: the lane, its version and the trigger that started the run. The trigger belongs to the key because
 * the pre-steps of a trigger are part of the nodes (`forTrigger`), so two runs of one version can walk different nodes.
 */
export function laneNodesKey(run: {
  workflowId: string;
  workflowVersion: number;
  triggerKind: string;
  triggerId: string | null;
}): string {
  return `${run.workflowId}@${String(run.workflowVersion)}|${run.triggerKind}|${run.triggerId ?? ""}`;
}

/** What a view does with a run's `nodesKey`: the nodes of its entry, none for a run without a key (or for a key the response lacks). */
export function laneNodesFor(
  byKey: LaneNodesByKey,
  nodesKey: string | null,
): readonly LaneNodeView[] {
  return nodesKey === null ? [] : (byKey[nodesKey] ?? []);
}

export type LaneNodesIndex = {
  /** The entries collected so far: what the response carries as `laneNodes`. */
  byKey: LaneNodesByKey;
  /**
   * The key for the nodes of `run`, or null when there are none. `read` is called only the first time a key is seen, so a response reads
   * (and holds) the nodes of a lane version once, however many runs it has.
   */
  refer(
    run: Parameters<typeof laneNodesKey>[0],
    read: () => LaneNodeView[],
  ): string | null;
};

export function createLaneNodesIndex(): LaneNodesIndex {
  const byKey: LaneNodesByKey = {};
  const unreadable = new Set<string>();
  return {
    byKey,
    refer(run, read) {
      const key = laneNodesKey(run);
      if (key in byKey) return key;
      if (unreadable.has(key)) return null;
      const nodes = read();
      if (nodes.length === 0) {
        unreadable.add(key);
        return null;
      }
      byKey[key] = nodes;
      return key;
    },
  };
}
