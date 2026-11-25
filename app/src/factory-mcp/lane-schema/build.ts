// SPDX-License-Identifier: LicenseRef-Proprietary

// What `get_lane_schema` answers: everything an AI needs to write a lane (workflow) document that the validator accepts. Built from the
// validator's own constants (limits, triggers, connectors) and from `docs/workflows.md` and the JSON Schemas (`guide.generated.json`, which a
// test holds equal to them). The overview is small and says what to read next; a section is one chapter of the document, or the schema.
import { BUILT_IN_CONNECTORS } from "../../workflows/connectors.ts";
import * as limits from "../../workflows/limits.ts";
import { TRIGGER_KINDS } from "../../workflows/triggers.ts";
import { chapterMarkdown, type GuideSection } from "./guide.ts";
import guideData from "./guide.generated.json" with { type: "json" };

type Data = {
  intro: string;
  sections: GuideSection[];
  workflowSchema: unknown;
  resultSchema: unknown;
  example: unknown;
};
const data: Data = guideData;

/** The chapters an AI writing a lane reads, in the order to read them. */
export const AUTHORING_SECTIONS = [
  "the-document",
  "five-kinds-of-node",
  "references-and-data-flow",
  "conditions",
  "result-schemas",
  "error-codes",
] as const;

/** The parts of the answer that are not a chapter of the document. */
export const SPECIAL_SECTIONS = {
  schema: "The JSON Schema of a lane document (contracts/workflow.v1.json).",
  result_schema: "The JSON Schema of a result schema of an agent step (contracts/result-schema.v1.json).",
  example: "A complete lane document that validates clean.",
} as const;

const chapter = (id: string): string => {
  const found = data.sections.find((section) => section.id === id);
  if (found === undefined) throw new Error(`docs/workflows.md has no chapter "${id}"`);
  return chapterMarkdown(found);
};

/** The limits of the format, as the validator holds them. */
function limitsOfTheFormat() {
  return {
    stepsPerDocument: limits.STEPS_MAX,
    triggersPerDocument: limits.TRIGGERS_MAX,
    nameMaxCharacters: limits.NAME_MAX_LENGTH,
    descriptionMaxCharacters: limits.DESCRIPTION_MAX_LENGTH,
    changeDescriptionMaxCharacters: limits.CHANGE_DESCRIPTION_MAX_LENGTH,
    documentMaxBytes: limits.DOCUMENT_MAX_BYTES,
    loopRoundsMax: limits.LOOP_ROUNDS_MAX,
    nestingDepthMax: limits.NESTING_DEPTH_MAX,
    budgetDefaultUsd: limits.BUDGET_DEFAULT_USD,
    budgetOperatorMaxUsd: limits.BUDGET_OPERATOR_MAX_USD,
    turnTimeLimitMinutes: {
      min: limits.TURN_TIME_LIMIT_MINUTES_MIN,
      max: limits.TURN_TIME_LIMIT_MINUTES_MAX,
      default: limits.TURN_TIME_LIMIT_MINUTES_DEFAULT,
    },
    lanesPerProject: limits.WORKFLOWS_PER_PROJECT_MAX,
    versionsPerLane: limits.VERSIONS_PER_WORKFLOW_MAX,
    errorsListed: limits.ERRORS_MAX,
    instructionsMaxCharacters: limits.INSTRUCTIONS_MAX_LENGTH,
  };
}

export function laneSchemaOverview() {
  return {
    formatVersion: 1,
    what: "A lane (the API calls it a workflow) is a JSON document: triggers that start it and steps that run in order (agent, action, if, loop). A strict validator checks it; saving runs the same validator.",
    howToWriteOne: [
      "1. Read this overview, then the chapters in `readNext` (call this tool again with `section`).",
      "2. Write the document (it is closed: a field the format does not name is an error). Start from `section: \"example\"`.",
      "3. Validate it (the tool validate_lane, when the tool list has it) and read EVERY error: each has a path, a stable code, a message and, where a name was wrong, `available` names. Fix them all, validate again.",
      "4. Save it with create_lane (a new lane belongs to one project and needs a description) or update_lane (a new version needs a change note). Saving is for Owners and Admins.",
    ],
    document: chapterWithoutHeading("the-document"),
    triggerKinds: TRIGGER_KINDS.filter((kind) => kind !== "github.issueLabeled"),
    connectors: BUILT_IN_CONNECTORS.map((connector) => ({
      name: connector.name,
      description: connector.description,
      inputs: Object.entries(connector.inputs).map(([name, spec]) => ({
        name,
        required: spec.required,
      })),
    })),
    limits: limitsOfTheFormat(),
    readNext: AUTHORING_SECTIONS.map((id) => ({
      section: id,
      title: data.sections.find((section) => section.id === id)?.title ?? id,
    })),
    sections: [
      ...Object.entries(SPECIAL_SECTIONS).map(([id, what]) => ({ section: id, what })),
      ...data.sections.map((section) => ({
        section: section.id,
        title: section.title,
        characters: chapterMarkdown(section).length,
        // A long chapter can be read in parts: `section: "<chapter>/<part>"`.
        ...(section.children.length === 0
          ? {}
          : {
              parts: section.children.map((child) => ({
                section: `${section.id}/${child.id}`,
                title: child.title,
                characters: child.markdown.length,
              })),
            }),
      })),
    ],
  };
}

function chapterWithoutHeading(id: string): string {
  return chapter(id).split("\n").slice(1).join("\n").trim();
}

export type LaneSchemaSection =
  | { section: string; format: "json"; content: unknown }
  | { section: string; format: "markdown"; title: string; content: string };

/** One part of the answer, or `undefined` for a name that is none. */
export function laneSchemaSection(id: string): LaneSchemaSection | undefined {
  if (id === "schema") return { section: id, format: "json", content: data.workflowSchema };
  if (id === "result_schema") return { section: id, format: "json", content: data.resultSchema };
  if (id === "example") return { section: id, format: "json", content: data.example };
  const [chapterId, partId] = id.split("/");
  const found = data.sections.find((section) => section.id === chapterId);
  if (found === undefined) return undefined;
  if (partId === undefined)
    return { section: id, format: "markdown", title: found.title, content: chapterMarkdown(found) };
  const part = found.children.find((child) => child.id === partId);
  if (part === undefined) return undefined;
  return { section: id, format: "markdown", title: part.title, content: part.markdown };
}

export function laneSchemaSectionNames(): string[] {
  return [
    ...Object.keys(SPECIAL_SECTIONS),
    ...data.sections.flatMap((section) => [
      section.id,
      ...section.children.map((child) => `${section.id}/${child.id}`),
    ]),
  ];
}
