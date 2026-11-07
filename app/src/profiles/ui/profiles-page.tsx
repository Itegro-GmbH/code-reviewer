// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";
// The Profiles page (#925, prototype board "8 Profiles"): the list of the workspace's profiles with the harness, the runner and the rights,
// and a drawer per profile with the fields of the prototype. What the profile format has today is editable (harness, instructions, the push
// right) and saved as the next version; what it has no place for yet (key, runner, the question right, the model's picker) is disabled
// with a hint. The model of a version is carried over unchanged. Texts of a profile are free text of its author: rendered as text.
import { useCallback, useMemo, useState } from "react";
import { Button } from "../../components/button.tsx";
import { NativeSelect } from "../../components/native-select.tsx";
import { StatusRegion } from "../../components/status-region.tsx";
import { Alert, AlertDescription } from "../../components/ui/alert.tsx";
import { Checkbox } from "../../components/ui/checkbox.tsx";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "../../components/ui/empty.tsx";
import { Label } from "../../components/ui/label.tsx";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "../../components/ui/sheet.tsx";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../components/ui/table.tsx";
import { Textarea } from "../../components/ui/textarea.tsx";
import { useRequest } from "../../implementer/ui/use-request.ts";
import {
  PROFILE_HARNESSES,
  isProfileHarness,
  type ProfileHarness,
} from "../../runner-identity/harness.ts";
import type { ProfileView } from "../service.ts";
import { browserProfilesApi, type ProfilesApi } from "./api.ts";
import { DRAWER_COPY, HARNESS_LABEL, PROFILES_COPY } from "./messages.ts";

const loadProfile = (api: ProfilesApi, id: string) => api.get(id);

/** What the drawer saves: the document of the open version with the three fields the page edits replaced. */
export function nextVersionBody(
  profile: ProfileView,
  edit: { harness: ProfileHarness; instructions: string; canPush: boolean },
): Record<string, unknown> {
  const { document } = profile;
  return {
    name: document.name,
    description: document.description,
    model: document.model,
    instructions: edit.instructions,
    ...(document.costLimitCents === null
      ? {}
      : { costLimitCents: document.costLimitCents }),
    canPush: edit.canPush,
    ...(document.defaultResult === null
      ? {}
      : { defaultResult: document.defaultResult }),
    harness: edit.harness,
  };
}

/** What a row of the list shows of a profile: its name, its current version and what that version says. */
export type ProfileRowData = {
  id: string;
  name: string;
  version: number;
  harness: ProfileHarness;
  /** The model as one line: the catalog entry or `provider · model`. */
  model: string;
  canPush: boolean;
};

export function modelTextOf(model: ProfileView["document"]["model"]): string {
  return "entryId" in model
    ? model.entryId
    : `${model.provider} · ${model.model}`;
}

export function profileRowOf(view: ProfileView): ProfileRowData {
  return {
    id: view.id,
    name: view.name,
    version: view.version,
    harness: view.document.harness,
    model: modelTextOf(view.document.model),
    canPush: view.document.canPush,
  };
}

export function ProfilesPageContent({
  workspaceSlug,
  profiles,
  api: apiProp,
}: {
  workspaceSlug: string;
  profiles: readonly ProfileRowData[];
  /** Only tests pass this. */
  api?: ProfilesApi;
}) {
  const defaultApi = useMemo(
    () => browserProfilesApi(workspaceSlug),
    [workspaceSlug],
  );
  const api = apiProp ?? defaultApi;
  const [openId, setOpenId] = useState<string | null>(null);
  const [versions, setVersions] = useState<Record<string, number>>({});

  return (
    <section aria-labelledby="profiles-heading" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="profiles-heading" className="text-lg leading-7 font-semibold">
          {PROFILES_COPY.heading(profiles.length)}
        </h2>
        <p className="text-sm text-muted-foreground">
          {PROFILES_COPY.description}
        </p>
      </div>
      {profiles.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>{PROFILES_COPY.emptyTitle}</EmptyTitle>
            <EmptyDescription>
              {PROFILES_COPY.emptyDescription}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <Table aria-label="Profiles" className="min-w-[760px]">
          <TableHeader>
            <TableRow>
              <TableHead scope="col">{PROFILES_COPY.columns.profile}</TableHead>
              <TableHead scope="col">{PROFILES_COPY.columns.harness}</TableHead>
              <TableHead scope="col">{PROFILES_COPY.columns.runner}</TableHead>
              <TableHead scope="col">{PROFILES_COPY.columns.rights}</TableHead>
              <TableHead scope="col">{PROFILES_COPY.columns.used}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {profiles.map((profile) => (
              <ProfileRow
                key={profile.id}
                profile={profile}
                version={versions[profile.id] ?? profile.version}
                onOpen={() => setOpenId(profile.id)}
              />
            ))}
          </TableBody>
        </Table>
      )}
      <ProfileDrawer
        api={api}
        profileId={openId}
        onClose={() => setOpenId(null)}
        onSaved={(id, version) =>
          setVersions((current) => ({ ...current, [id]: version }))
        }
      />
    </section>
  );
}

function ProfileRow({
  profile,
  version,
  onOpen,
}: {
  profile: ProfileRowData;
  version: number;
  onOpen: () => void;
}) {
  return (
    <TableRow data-profile-id={profile.id}>
      <TableCell className="whitespace-normal">
        <button
          type="button"
          onClick={onOpen}
          className="flex cursor-pointer flex-col items-start gap-0.5 border-0 bg-transparent p-0 text-left text-foreground"
        >
          <span className="font-semibold break-words">{profile.name}</span>
          <span className="text-xs text-muted-foreground">
            {PROFILES_COPY.version(version)}
          </span>
        </button>
      </TableCell>
      <TableCell className="whitespace-normal break-words">
        {profile.harness} · {profile.model}
      </TableCell>
      {/* Where a profile runs is a choice per profile that comes later; every harness has its own place today. */}
      <TableCell>
        {profile.harness === "claude-code"
          ? PROFILES_COPY.runnerOwn
          : PROFILES_COPY.hostedSandbox}
      </TableCell>
      <TableCell className="text-muted-foreground">
        {profile.canPush ? PROFILES_COPY.mayPush : PROFILES_COPY.readOnly}
      </TableCell>
      {/* Which lane uses a profile comes with the lane rework (#922). */}
      <TableCell className="text-muted-foreground">
        {PROFILES_COPY.none}
      </TableCell>
    </TableRow>
  );
}

function ProfileDrawer({
  api,
  profileId,
  onClose,
  onSaved,
}: {
  api: ProfilesApi;
  profileId: string | null;
  onClose: () => void;
  onSaved: (id: string, version: number) => void;
}) {
  const [loaded, reload] = useRequest(api, profileId, loadProfile);
  return (
    <Sheet
      open={profileId !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <SheetContent className="w-full overflow-y-auto sm:max-w-lg">
        {loaded.state === "ready" ? (
          <DrawerBody
            // A new version of the same profile starts the form again from what was saved.
            key={`${loaded.data.profile.id}:${String(loaded.data.profile.version)}`}
            api={api}
            profile={loaded.data.profile}
            onSaved={onSaved}
            onReload={reload}
          />
        ) : (
          <>
            <SheetHeader>
              <SheetTitle>{PROFILES_COPY.title}</SheetTitle>
              <SheetDescription>
                {loaded.state === "failed"
                  ? DRAWER_COPY.loadFailed
                  : DRAWER_COPY.loading}
              </SheetDescription>
            </SheetHeader>
            {loaded.state === "failed" ? (
              <div className="px-4">
                <Button variant="secondary" onClick={reload}>
                  {DRAWER_COPY.tryAgain}
                </Button>
              </div>
            ) : null}
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

function DrawerBody({
  api,
  profile,
  onSaved,
  onReload,
}: {
  api: ProfilesApi;
  profile: ProfileView;
  onSaved: (id: string, version: number) => void;
  onReload: () => void;
}) {
  const { document } = profile;
  const [harness, setHarness] = useState<ProfileHarness>(document.harness);
  const [instructions, setInstructions] = useState(document.instructions);
  const [canPush, setCanPush] = useState(document.canPush);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const idPrefix = `profile-${profile.id}`;

  const save = useCallback(async () => {
    setPending(true);
    setNotice(null);
    setProblem(null);
    const result = await api.saveVersion(
      profile.id,
      nextVersionBody(profile, { harness, instructions, canPush }),
      profile.version,
    );
    setPending(false);
    if (!result.ok) {
      setProblem(
        result.code === "PROFILE_VERSION_CONFLICT"
          ? DRAWER_COPY.conflict
          : DRAWER_COPY.saveFailed,
      );
      return;
    }
    setNotice(DRAWER_COPY.saved(result.data.profile.version));
    onSaved(profile.id, result.data.profile.version);
    onReload();
  }, [api, profile, harness, instructions, canPush, onSaved, onReload]);

  const modelText = modelTextOf(document.model);
  return (
    <>
      <SheetHeader>
        <p className="text-xs font-semibold text-muted-foreground">
          {DRAWER_COPY.kind(profile.version)}
        </p>
        <SheetTitle className="break-words">{profile.name}</SheetTitle>
        <SheetDescription className="break-words">
          {document.description === ""
            ? DRAWER_COPY.footnote
            : document.description}
        </SheetDescription>
      </SheetHeader>
      <div className="flex flex-col gap-4 px-4 pb-6">
        <div className="flex flex-col gap-1">
          <Label htmlFor={`${idPrefix}-harness`}>{DRAWER_COPY.harness}</Label>
          <NativeSelect
            id={`${idPrefix}-harness`}
            value={harness}
            onChange={(event) => {
              if (isProfileHarness(event.target.value))
                setHarness(event.target.value);
            }}
          >
            {PROFILE_HARNESSES.map((name) => (
              <option key={name} value={name}>
                {HARNESS_LABEL[name]}
              </option>
            ))}
          </NativeSelect>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor={`${idPrefix}-model`}>{DRAWER_COPY.model}</Label>
          <NativeSelect
            id={`${idPrefix}-model`}
            disabled
            aria-describedby={`${idPrefix}-model-hint`}
            value={modelText}
            onChange={() => undefined}
          >
            <option value={modelText}>{modelText}</option>
          </NativeSelect>
          <p
            id={`${idPrefix}-model-hint`}
            className="text-xs text-muted-foreground"
          >
            {DRAWER_COPY.modelHint}
          </p>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor={`${idPrefix}-key`}>{DRAWER_COPY.key}</Label>
          <NativeSelect
            id={`${idPrefix}-key`}
            disabled
            aria-describedby={`${idPrefix}-key-hint`}
            value=""
            onChange={() => undefined}
          >
            <option value="">{DRAWER_COPY.keyValue}</option>
          </NativeSelect>
          <p
            id={`${idPrefix}-key-hint`}
            className="text-xs text-muted-foreground"
          >
            {DRAWER_COPY.keyHint}
          </p>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor={`${idPrefix}-instructions`}>
            {DRAWER_COPY.instructions}
          </Label>
          <Textarea
            id={`${idPrefix}-instructions`}
            rows={6}
            value={instructions}
            onChange={(event) => setInstructions(event.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor={`${idPrefix}-runs-on`}>{DRAWER_COPY.runsOn}</Label>
          <NativeSelect
            id={`${idPrefix}-runs-on`}
            disabled
            aria-describedby={`${idPrefix}-runs-on-hint`}
            value=""
            onChange={() => undefined}
          >
            <option value="">{PROFILES_COPY.hostedSandbox}</option>
          </NativeSelect>
          <p
            id={`${idPrefix}-runs-on-hint`}
            className="text-xs text-muted-foreground"
          >
            {DRAWER_COPY.runsOnHint}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Checkbox
            id={`${idPrefix}-push`}
            checked={canPush}
            onCheckedChange={(checked) => setCanPush(checked === true)}
          />
          <Label htmlFor={`${idPrefix}-push`}>{DRAWER_COPY.mayPush}</Label>
        </div>
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <Checkbox
              id={`${idPrefix}-ask`}
              checked
              disabled
              aria-describedby={`${idPrefix}-ask-hint`}
            />
            <Label htmlFor={`${idPrefix}-ask`}>{DRAWER_COPY.mayAsk}</Label>
          </div>
          <p
            id={`${idPrefix}-ask-hint`}
            className="text-xs text-muted-foreground"
          >
            {DRAWER_COPY.mayAskHint}
          </p>
        </div>
        {problem !== null ? (
          <Alert variant="destructive">
            <AlertDescription>{problem}</AlertDescription>
          </Alert>
        ) : null}
        <StatusRegion>{notice ?? ""}</StatusRegion>
        <div className="flex flex-wrap gap-2">
          <Button
            loading={pending}
            loadingLabel={DRAWER_COPY.saving}
            onClick={() => void save()}
          >
            {DRAWER_COPY.save}
          </Button>
          <Button
            variant="secondary"
            disabled
            aria-describedby={`${idPrefix}-duplicate-hint`}
          >
            {DRAWER_COPY.duplicate}
          </Button>
        </div>
        <p
          id={`${idPrefix}-duplicate-hint`}
          className="text-xs text-muted-foreground"
        >
          {DRAWER_COPY.duplicateHint} {DRAWER_COPY.footnote}
        </p>
      </div>
    </>
  );
}
