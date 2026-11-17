// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";
// The dialog that adds or changes an MCP server (#1050): name, transport, address and authentication (none, or one or more headers).
// The header values are write-only: a stored value is never loaded into the form, the field shows that one is stored, and an empty field
// keeps it. A refusal is a fixed sentence for its code, shown at the field it belongs to (`MCP_INPUT_FIELD`).
import { useId, useState, type FormEvent } from "react";
import { Button } from "../../components/button.tsx";
import { NativeSelect } from "../../components/native-select.tsx";
import { Alert, AlertDescription } from "../../components/ui/alert.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog.tsx";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "../../components/ui/field.tsx";
import { Input } from "../../components/ui/input.tsx";
import { useProductIdentity } from "../../product-identity/context.tsx";
import {
  MCP_INPUT_CODES,
  MCP_INPUT_FIELD,
  type McpInputCode,
} from "../errors.ts";
import type { McpServerView } from "../service.ts";
import type { McpApi, McpServerForm } from "./api.ts";
import {
  AUTH_COPY,
  describeMcpFailure,
  PAGE_COPY,
  TRANSPORT_COPY,
} from "./messages.ts";

type Row = {
  key: number;
  name: string;
  value: string;
  /** The name this row had when the server was loaded, when its value is stored: an empty value keeps it. */
  storedAs: string | null;
};

type Failure = { text: string; field: string | null };

function fieldOf(code: string): string | null {
  return (MCP_INPUT_CODES as readonly string[]).includes(code)
    ? MCP_INPUT_FIELD[code as McpInputCode]
    : null;
}

export function ServerDialog({
  api,
  open,
  server,
  onClose,
  onSaved,
}: {
  api: McpApi;
  open: boolean;
  /** The server to change, or null to add one. */
  server: McpServerView | null;
  onClose: () => void;
  onSaved: (saved: McpServerView, created: boolean) => void;
}) {
  const product = useProductIdentity();
  const ids = useId();
  const [name, setName] = useState(server?.name ?? "");
  const [transport, setTransport] = useState(
    server?.transport ?? "streamable-http",
  );
  const [url, setUrl] = useState(server?.url ?? "");
  const [auth, setAuth] = useState<"none" | "header">(
    server?.auth === "header" ? "header" : server === null ? "header" : "none",
  );
  const [counter, setCounter] = useState(server?.headers.length ?? 1);
  const [rows, setRows] = useState<Row[]>(
    server !== null && server.auth === "header"
      ? server.headers.map((header, index) => ({
          key: index,
          name: header,
          value: "",
          storedAs: header,
        }))
      : [{ key: 0, name: "Authorization", value: "", storedAs: null }],
  );
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);

  const editing = server !== null;
  const errorAt = (field: string) =>
    failure?.field === field ? failure.text : undefined;

  function update(key: number, change: Partial<Row>) {
    setRows((current) =>
      current.map((row) => (row.key === key ? { ...row, ...change } : row)),
    );
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setFailure(null);
    const form: McpServerForm = {
      name,
      transport,
      url,
      auth:
        auth === "none"
          ? { kind: "none" }
          : {
              kind: "header",
              headers: rows.map((row) =>
                row.value === "" &&
                row.storedAs !== null &&
                row.storedAs === row.name
                  ? { name: row.name, keep: true as const }
                  : { name: row.name, value: row.value },
              ),
            },
      ...(server === null ? {} : { revision: server.revision }),
    };
    setBusy(true);
    const result =
      server === null
        ? await api.create(form)
        : await api.update(server.id, form);
    setBusy(false);
    if (!result.ok) {
      setFailure({
        text: describeMcpFailure(product, {
          code: result.code,
          status: result.status,
        }),
        field: fieldOf(result.code),
      });
      return;
    }
    onSaved(result.data.server, server === null);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent
        aria-label={editing ? PAGE_COPY.formEditTitle : PAGE_COPY.formAddTitle}
      >
        <DialogHeader>
          <DialogTitle>
            {editing ? PAGE_COPY.formEditTitle : PAGE_COPY.formAddTitle}
          </DialogTitle>
          <DialogDescription>{PAGE_COPY.formDescription}</DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(event) => void submit(event)}
          noValidate
          className="flex flex-col gap-4"
        >
          {failure !== null && failure.field === null ? (
            <Alert variant="destructive">
              <AlertDescription>{failure.text}</AlertDescription>
            </Alert>
          ) : null}
          <Field data-invalid={errorAt("name") !== undefined || undefined}>
            <FieldLabel htmlFor={`${ids}-name`}>
              {PAGE_COPY.nameLabel}
            </FieldLabel>
            <Input
              id={`${ids}-name`}
              value={name}
              onChange={(event) => setName(event.target.value)}
              aria-invalid={errorAt("name") !== undefined}
              autoComplete="off"
              spellCheck={false}
            />
            {errorAt("name") === undefined ? (
              <FieldDescription>{PAGE_COPY.nameHint}</FieldDescription>
            ) : (
              <FieldError>{errorAt("name")}</FieldError>
            )}
          </Field>
          <Field data-invalid={errorAt("transport") !== undefined || undefined}>
            <FieldLabel htmlFor={`${ids}-transport`}>
              {PAGE_COPY.transportLabel}
            </FieldLabel>
            <NativeSelect
              id={`${ids}-transport`}
              value={transport}
              onChange={(event) => setTransport(event.target.value)}
            >
              {Object.entries(TRANSPORT_COPY).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </NativeSelect>
            {errorAt("transport") === undefined ? null : (
              <FieldError>{errorAt("transport")}</FieldError>
            )}
          </Field>
          <Field data-invalid={errorAt("url") !== undefined || undefined}>
            <FieldLabel htmlFor={`${ids}-url`}>{PAGE_COPY.urlLabel}</FieldLabel>
            <Input
              id={`${ids}-url`}
              type="url"
              inputMode="url"
              placeholder="https://mcp.example.com/mcp"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              aria-invalid={errorAt("url") !== undefined}
              autoComplete="off"
              spellCheck={false}
            />
            {errorAt("url") === undefined ? (
              <FieldDescription>{PAGE_COPY.urlHint}</FieldDescription>
            ) : (
              <FieldError>{errorAt("url")}</FieldError>
            )}
          </Field>
          <Field data-invalid={errorAt("auth") !== undefined || undefined}>
            <FieldLabel htmlFor={`${ids}-auth`}>
              {PAGE_COPY.authLabel}
            </FieldLabel>
            <NativeSelect
              id={`${ids}-auth`}
              value={auth}
              onChange={(event) =>
                setAuth(event.target.value === "none" ? "none" : "header")
              }
            >
              <option value="none">{AUTH_COPY.none}</option>
              <option value="header">{AUTH_COPY.header}</option>
              <option value="oauth" disabled>
                {AUTH_COPY.oauth} ({PAGE_COPY.oauthLater})
              </option>
            </NativeSelect>
            {errorAt("auth") === undefined ? null : (
              <FieldError>{errorAt("auth")}</FieldError>
            )}
          </Field>
          {auth === "header" ? (
            <fieldset className="flex flex-col gap-3 border-0 p-0">
              <legend className="mb-2 text-sm font-semibold">
                {PAGE_COPY.headers}
              </legend>
              {rows.map((row, index) => (
                <div
                  key={row.key}
                  className="flex flex-wrap items-end gap-2"
                  role="group"
                  aria-label={`Header ${String(index + 1)}`}
                >
                  <Field className="min-w-40 flex-1">
                    <FieldLabel htmlFor={`${ids}-hn-${String(row.key)}`}>
                      {PAGE_COPY.headerNameLabel}
                    </FieldLabel>
                    <Input
                      id={`${ids}-hn-${String(row.key)}`}
                      value={row.name}
                      onChange={(event) =>
                        update(row.key, { name: event.target.value })
                      }
                      autoComplete="off"
                      spellCheck={false}
                    />
                  </Field>
                  <Field className="min-w-40 flex-[2]">
                    <FieldLabel htmlFor={`${ids}-hv-${String(row.key)}`}>
                      {PAGE_COPY.headerValueLabel}
                    </FieldLabel>
                    <Input
                      id={`${ids}-hv-${String(row.key)}`}
                      type="password"
                      autoComplete="new-password"
                      spellCheck={false}
                      value={row.value}
                      placeholder={
                        row.storedAs !== null && row.storedAs === row.name
                          ? PAGE_COPY.headerKept
                          : undefined
                      }
                      onChange={(event) =>
                        update(row.key, { value: event.target.value })
                      }
                    />
                  </Field>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    aria-label={`${PAGE_COPY.removeHeader} ${String(index + 1)}`}
                    disabled={rows.length === 1}
                    onClick={() =>
                      setRows((current) =>
                        current.filter((entry) => entry.key !== row.key),
                      )
                    }
                  >
                    {PAGE_COPY.removeHeader}
                  </Button>
                </div>
              ))}
              <div>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    setRows((current) => [
                      ...current,
                      { key: counter, name: "", value: "", storedAs: null },
                    ]);
                    setCounter(counter + 1);
                  }}
                >
                  {PAGE_COPY.addHeader}
                </Button>
              </div>
              {errorAt("headers") === undefined ? null : (
                <p role="alert" className="text-sm text-destructive">
                  {errorAt("headers")}
                </p>
              )}
            </fieldset>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={onClose}>
              {PAGE_COPY.cancel}
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? PAGE_COPY.saving : PAGE_COPY.save}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
