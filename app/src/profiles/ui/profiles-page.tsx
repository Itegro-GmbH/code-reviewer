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

/** An environment of the workspace as the page offers it: the name a profile names, and whether it is a hosted VM or a runner. */
export type EnvironmentOption = { name: string; kind: "hosted" | "runner" };

/** What the drawer saves: the document of the open version with the four fields the page edits replaced. It carries no cost limit (#918): the lane owns the limits. */
export function nextVersionBody(
  profile: ProfileView,
  edit: {
    harness: ProfileHarness;
    instructions: string;
    canPush: boolean;
    environment: string;
  },
): Record<string, unknown> {
  const { document } = profile;
  return {
    name: document.name,
    description: document.description,
    model: document.model,
    instructions: edit.instructions,
    canPush: edit.canPush,
    ...(document.defaultResult === null
      ? {}
      : { defaultResult: document.defaultResult }),
    harness: edit.harness,
    environment: edit.environment,
  };
}

/** Where the key comes from, read from the model of the profile and its harness. */
export function keySourceOf(
  model: ProfileView["document"]["model"],
  harness: ProfileHarness,
): string {
  if (harness === "claude-code") return DRAWER_COPY.keyRunnerLogin;
  return "entryId" in model
    ? DRAWER_COPY.keyManaged
    : DRAWER_COPY.keyOwn(model.provider);
}

/** Why a harness, a model and an environment do not fit together, or null when they do (the server checks the same). */
export function fitProblemOf(
  profile: ProfileView,
  harness: ProfileHarness,
  environment: EnvironmentOption | undefined,
): string | null {
  // A harness of a runner needs the runner's own key, and a managed model is not one: no environment fits both, so the problem is
  // one, and it is said without an environment chosen.
  if (harness !== "opencode" && "entryId" in profile.document.model)
    return DRAWER_COPY.runsOnNeedsRunnerAndOwnKey;
  if (environment === undefined) return null;
  if (environment.kind === "hosted" && harness !== "opencode")
    return DRAWER_COPY.runsOnNeedsRunner;
  if (environment.kind === "runner" && "entryId" in profile.document.model)
    return DRAWER_COPY.runsOnNeedsOwnKey;
  return null;
}

/** What a row of the list shows of a profile: its name, its current version and what that version says. */
export type ProfileRowData = {
  id: string;
  name: string;
  version: number;
  harness: ProfileHarness;
  /** The model as one line: the catalog entry or `provider · model`. */
  model: string;
  /** The name of the environment the profile runs in; null for a version saved before profiles had one. */
  environment: string | null;
  /** The environment the version names was removed since (the name is null then, as for a version saved before there was one). */
  environmentGone: boolean;
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
    environment: view.document.environment,
    environmentGone: view.environmentGone,
    canPush: view.document.canPush,
  };
}

export function ProfilesPageContent({
  workspaceSlug,
  profiles,
  environments,
  api: apiProp,
}: {
  workspaceSlug: string;
  profiles: readonly ProfileRowData[];
  /** The environments of the workspace: what a profile can run on. */
  environments: readonly EnvironmentOption[];
  /** Only tests pass this. */
  api?: ProfilesApi;
}) {
  const defaultApi = useMemo(
    () => browserProfilesApi(workspaceSlug),
    [workspaceSlug],
  );
  const api = apiProp ?? defaultApi;
  const [openId, setOpenId] = useState<string | null>(null);
  // What a save answered, by profile id: the list row and the drawer show it without asking the server again.
  const [saved, setSaved] = useState<Record<string, ProfileView>>({});

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
                profile={
                  saved[profile.id] === undefined
                    ? profile
                    : profileRowOf(saved[profile.id]!)
                }
                environments={environments}
                onOpen={() => setOpenId(profile.id)}
              />
            ))}
          </TableBody>
        </Table>
      )}
      <ProfileDrawer
        api={api}
        environments={environments}
        profileId={openId}
        saved={openId === null ? undefined : saved[openId]}
        onClose={() => setOpenId(null)}
        onSaved={(view) =>
          setSaved((current) => ({ ...current, [view.id]: view }))
        }
      />
    </section>
  );
}

function ProfileRow({
  profile,
  environments,
  onOpen,
}: {
  profile: ProfileRowData;
  environments: readonly EnvironmentOption[];
  onOpen: () => void;
}) {
  const kind = environments.find(
    (candidate) => candidate.name === profile.environment,
  )?.kind;
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
            {PROFILES_COPY.version(profile.version)}
          </span>
        </button>
      </TableCell>
      <TableCell className="whitespace-normal break-words">
        {profile.harness} · {profile.model}
      </TableCell>
      <TableCell className="whitespace-normal">
        <span className="flex flex-col gap-0.5">
          <span className="break-words">
            {profile.environmentGone
              ? PROFILES_COPY.environmentGone
              : (profile.environment ?? PROFILES_COPY.noEnvironment)}
          </span>
          {profile.environmentGone ? null : (
            <span className="text-xs text-muted-foreground">
              {profile.environment === null
                ? PROFILES_COPY.noEnvironmentHint
                : kind === "runner"
                  ? PROFILES_COPY.runnerOwn
                  : PROFILES_COPY.hostedSandbox}
            </span>
          )}
        </span>
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
  environments,
  profileId,
  saved,
  onClose,
  onSaved,
}: {
  api: ProfilesApi;
  environments: readonly EnvironmentOption[];
  profileId: string | null;
  /** What the last save of the open profile answered; it wins over a read that is older. */
  saved: ProfileView | undefined;
  onClose: () => void;
  onSaved: (profile: ProfileView) => void;
}) {
  const [loaded, reload] = useRequest(api, profileId, loadProfile);
  // The notice lives here: the body starts again from every new version, and the notice must outlast that.
  const [notice, setNotice] = useState<string | null>(null);
  const shown =
    loaded.state === "ready"
      ? saved !== undefined && saved.version >= loaded.data.profile.version
        ? saved
        : loaded.data.profile
      : null;
  return (
    <Sheet
      open={profileId !== null}
      onOpenChange={(open) => {
        if (open) return;
        setNotice(null);
        onClose();
      }}
    >
      <SheetContent className="w-full overflow-y-auto sm:max-w-lg">
        {shown !== null ? (
          <DrawerBody
            // A new version of the same profile starts the form again from what was saved.
            key={`${shown.id}:${String(shown.version)}`}
            api={api}
            environments={environments}
            profile={shown}
            notice={notice}
            onSaveStart={() => setNotice(null)}
            onSaved={(profile) => {
              setNotice(DRAWER_COPY.saved(profile.version));
              onSaved(profile);
            }}
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
  environments,
  profile,
  notice,
  onSaveStart,
  onSaved,
}: {
  api: ProfilesApi;
  environments: readonly EnvironmentOption[];
  profile: ProfileView;
  notice: string | null;
  /** A save begins: the notice of the one before is no longer true. */
  onSaveStart: () => void;
  onSaved: (profile: ProfileView) => void;
}) {
  const { document } = profile;
  const [harness, setHarness] = useState<ProfileHarness>(document.harness);
  const [instructions, setInstructions] = useState(document.instructions);
  const [canPush, setCanPush] = useState(document.canPush);
  // A version saved before profiles had an environment starts with none chosen.
  const [environment, setEnvironment] = useState(document.environment ?? "");
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const idPrefix = `profile-${profile.id}`;

  const save = useCallback(async () => {
    setPending(true);
    setProblem(null);
    onSaveStart();
    const result = await api.saveVersion(
      profile.id,
      nextVersionBody(profile, { harness, instructions, canPush, environment }),
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
    onSaved(result.data.profile);
  }, [
    api,
    profile,
    harness,
    instructions,
    canPush,
    environment,
    onSaveStart,
    onSaved,
  ]);

  const modelText = modelTextOf(document.model);
  const chosen = environments.find(
    (candidate) => candidate.name === environment,
  );
  const fitProblem = fitProblemOf(profile, harness, chosen);
  const keySource = keySourceOf(document.model, harness);
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
            value={keySource}
            onChange={() => undefined}
          >
            <option value={keySource}>{keySource}</option>
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
            aria-describedby={`${idPrefix}-runs-on-hint`}
            value={environment}
            onChange={(event) => setEnvironment(event.target.value)}
          >
            <option value="">{DRAWER_COPY.runsOnNone}</option>
            {environments.map((candidate) => (
              <option key={candidate.name} value={candidate.name}>
                {candidate.name} · {DRAWER_COPY.runsOnKind(candidate.kind)}
              </option>
            ))}
          </NativeSelect>
          <p
            id={`${idPrefix}-runs-on-hint`}
            className="text-xs text-muted-foreground"
          >
            {environments.length === 0
              ? DRAWER_COPY.noEnvironments
              : DRAWER_COPY.runsOnHint}
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
        {fitProblem !== null ? (
          <Alert variant="destructive">
            <AlertDescription>{fitProblem}</AlertDescription>
          </Alert>
        ) : environment === "" && environments.length > 0 ? (
          <Alert variant="info" role="status">
            {profile.environmentGone
              ? DRAWER_COPY.runsOnGone
              : DRAWER_COPY.runsOnRequired}
          </Alert>
        ) : null}
        {problem !== null ? (
          <Alert variant="destructive">
            <AlertDescription>{problem}</AlertDescription>
          </Alert>
        ) : null}
        <StatusRegion>{problem === null ? (notice ?? "") : ""}</StatusRegion>
        <div className="flex flex-wrap gap-2">
          <Button
            loading={pending}
            loadingLabel={DRAWER_COPY.saving}
            disabled={environment === "" || fitProblem !== null}
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
