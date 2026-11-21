// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";
// The review skill of a project (#200): the shipped default is shown read-only with its identity (id,
// version, SHA-256), "Edit skill" starts an override from that text, and "Reset review skill to default"
// stages the shipped skill again (stored by the next Save, never before). The size limit is in UTF-8
// bytes, so the counter counts bytes, not characters. The text is rendered as the value of a textarea:
// a skill is untrusted data and never becomes markup.
import { useContext, useId, useRef } from "react";
import { Badge } from "../../components/ui/badge.tsx";
import { Button } from "../../components/button.tsx";
import { FieldDescription, FieldLabel } from "../../components/ui/field.tsx";
import { Textarea } from "../../components/ui/textarea.tsx";
import { FieldsDisabledContext } from "./settings-fields.tsx";
import type { ProjectDynamicView } from "../service.ts";
import {
  skillByteLength,
  type DynamicFormValues,
} from "./dynamic-form-state.ts";

export const EDIT_SKILL_LABEL = "Edit skill";
export const RESET_SKILL_LABEL = "Reset review skill to default";

function bytes(value: number): string {
  return value.toLocaleString("en-US");
}

export function SkillEditor({
  view,
  values,
  error,
  onEdit,
  onChange,
  onReset,
}: {
  view: ProjectDynamicView;
  values: DynamicFormValues;
  error: string | undefined;
  onEdit: () => void;
  onChange: (text: string) => void;
  onReset: () => void;
}) {
  // Read only (or busy): the card is disabled, and neither button starts or drops an override.
  const disabled = useContext(FieldsDisabledContext);
  const id = useId();
  const area = useRef<HTMLTextAreaElement>(null);
  const metaId = `${id}-meta`;
  const countId = `${id}-count`;
  const errorId = `${id}-error`;
  const custom = values.skillMode === "custom";
  const size = skillByteLength(values.skillText);
  const limit = view.limits.reviewSkillMaxBytes;
  const over = size - limit;
  const describedBy = [metaId, countId, error === undefined ? null : errorId]
    .filter(Boolean)
    .join(" ");
  const buttonClass = "min-h-8 pointer-coarse:min-h-11";
  return (
    <div data-field="reviewSkill" className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <FieldLabel htmlFor={id}>Review skill</FieldLabel>
        <span className="flex flex-wrap items-center gap-2">
          <Badge variant="neutral">
            {custom ? "Custom skill" : "Shipped default"}
          </Badge>
          {custom ? (
            <Button
              variant="ghost"
              size="sm"
              className={buttonClass}
              disabled={disabled}
              onClick={() => {
                if (disabled) return;
                onReset();
                area.current?.focus();
              }}
            >
              {RESET_SKILL_LABEL}
            </Button>
          ) : (
            <Button
              variant="secondary"
              size="sm"
              className={buttonClass}
              disabled={disabled}
              onClick={() => {
                if (disabled) return;
                onEdit();
                area.current?.focus();
              }}
            >
              {EDIT_SKILL_LABEL}
            </Button>
          )}
        </span>
      </div>
      <Textarea
        id={id}
        ref={area}
        rows={14}
        readOnly={!custom || disabled}
        spellCheck={false}
        value={values.skillText}
        aria-invalid={error !== undefined}
        aria-describedby={describedBy}
        onChange={(event) => onChange(event.target.value)}
        // The skill has long unbroken lines (source URLs); the shared Textarea sizes itself to its
        // content (#200), which would push the whole page sideways on a narrow window.
        className="field-sizing-fixed max-w-full font-mono text-xs"
      />
      <FieldDescription id={metaId}>
        {custom ? (
          <>
            Replaces the shipped skill for this project once you save. The fixed
            rules of the review cannot be changed here.
          </>
        ) : (
          <>
            Shipped skill{" "}
            <code className="font-mono">{view.defaultSkill.id}</code>, version{" "}
            {view.defaultSkill.version}, SHA-256{" "}
            <code className="font-mono break-all">
              {view.defaultSkill.hash}
            </code>
            .
            {values.draft !== null
              ? " Your edited text comes back with Edit skill until you save."
              : ""}
          </>
        )}
      </FieldDescription>
      <p id={countId} className="text-sm text-muted-foreground">
        {bytes(size)} of {bytes(limit)} bytes
        {over > 0 ? `, ${bytes(over)} over the limit` : ""}
      </p>
      {error !== undefined ? (
        <p id={errorId} className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
