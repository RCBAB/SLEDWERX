"use client";

import { ChevronDown, Plus, Settings2 } from "lucide-react";
import { useLayoutEffect, useState } from "react";

import type { SuspensionActionState } from "@/app/garage/suspension-actions";

import { Sheet } from "@/components/board/sheet";
import { useRefreshOnReturn } from "@/components/board/use-refresh-on-return";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import type { SledRole } from "@/lib/sleds/constants";
import { ROLE_LABELS, suspensionCapabilities } from "@/lib/sleds/permissions";
import { SUSPENSION_ZONES, latestRevision, type SuspensionData, type SuspensionSetting, type SuspensionZone } from "@/lib/suspension/types";

import { AdjustForm } from "./adjust-form";
import { DeletedItems } from "./deleted-items";
import { SettingForm, SettingsEditor } from "./settings-editor";
import { ActiveBadge, Panel, SectionTitle } from "./shared";
import { SetupActions, SetupBar, SetupForm, SetupSummary } from "./setups";
import { SledDiagram } from "./sled-diagram";
import { ZoneList, ZonePanel } from "./zones";

export type SledInfo = { id: string; name: string; description: string; odometer: number | null; engineHours: number | null };

type OpenSheet =
  | { kind: "new-setup"; copyFrom?: string }
  | { kind: "rename-setup"; id: string }
  | { kind: "add-setting"; zone?: SuspensionZone }
  | { kind: "edit-setting"; setting: SuspensionSetting }
  | { kind: "adjust" }
  | null;

/**
 * The Suspension Tuning page for one sled: its setups, the settings list,
 * and Recently Deleted. Everything is saved through the suspension server
 * actions as the signed-in user; the controls shown follow the user's role.
 */
export function SuspensionView({
  data,
  sled,
  role,
  initialSetupId,
}: {
  data: SuspensionData;
  sled: SledInfo;
  role: SledRole;
  userId: string;
  initialSetupId?: string;
}) {
  useRefreshOnReturn();
  const can = suspensionCapabilities(role);
  const [sheet, setSheet] = useState<OpenSheet>(null);
  const [session, setSession] = useState(0);
  const [chosen, setChosen] = useState<string | null>(initialSetupId ?? null);
  const [zone, setZone] = useState<SuspensionZone>(SUSPENSION_ZONES[0]);
  /** The revision just saved from the adjust sheet (shown as a notice). */
  const [savedId, setSavedId] = useState<string | null>(null);
  // Close sheets when the page is hidden (Next.js keeps it mounted).
  useLayoutEffect(() => () => setSheet(null), []);

  const show = (next: OpenSheet) => {
    setSession((n) => n + 1);
    setSheet(next);
  };
  const close = () => setSheet(null);

  const { setups, settings, revisions, deleted } = data;
  const selected = setups.find((s) => s.id === chosen) ?? setups.find((s) => s.isActive) ?? setups[0] ?? null;
  const renaming = sheet?.kind === "rename-setup" ? setups.find((s) => s.id === sheet.id) : undefined;
  const latest = selected ? latestRevision(revisions, selected.id) : undefined;
  const values = latest?.values ?? {};
  const saved = savedId ? revisions.find((r) => r.id === savedId && r.setupId === selected?.id) : undefined;
  const counts = Object.fromEntries(SUSPENSION_ZONES.map((z) => [z, settings.filter((s) => s.zone === z).length])) as Record<
    SuspensionZone,
    number
  >;
  const adjusted = (result: SuspensionActionState) => {
    close();
    if (result.ok && result.id) setSavedId(result.id);
  };

  return (
    <div className="mt-3 space-y-10" data-testid="suspension-page" data-sled-id={sled.id}>
      <header className="space-y-2">
        <h1 className="font-display text-4xl font-extrabold uppercase italic leading-none tracking-tight sm:text-5xl">Suspension tuning</h1>
        <p className="text-lg text-muted">
          {sled.name}
          {sled.name !== sled.description ? ` · ${sled.description}` : ""}
        </p>
        {!can.canAdjust ? (
          <p className="text-sm text-muted" data-testid="read-only-note">
            You can view this snowmobile&apos;s suspension ({ROLE_LABELS[role]}). The owner, editors and mechanics record changes.
          </p>
        ) : null}
      </header>

      <section aria-labelledby="setups-heading" className="space-y-4">
        <SectionTitle id="setups-heading">Setups</SectionTitle>
        {setups.length ? (
          <SetupBar
            setups={setups}
            revisions={revisions}
            selectedId={selected?.id ?? null}
            onSelect={setChosen}
            canManage={can.canManage}
            onNew={() => show({ kind: "new-setup" })}
          />
        ) : (
          <Panel data-testid="no-setups" className="space-y-3">
            <p className="font-semibold">No setups yet.</p>
            <p className="text-sm text-muted">
              A setup is a named set of values, like “Trail” or “Deep powder”. Each adjustment saves a new revision, so you can always look
              back or return to an earlier one.
            </p>
            {can.canManage ? (
              <Button type="button" onClick={() => show({ kind: "new-setup" })}>
                <Plus aria-hidden className="size-4" />
                Create a setup
              </Button>
            ) : (
              <p className="text-sm text-muted">The owner or an editor can create one.</p>
            )}
          </Panel>
        )}

        {selected ? (
          <Panel className="space-y-3" data-testid="selected-setup" data-setup-id={selected.id}>
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="font-display text-2xl font-bold uppercase italic" data-testid="selected-setup-name">
                {selected.name}
              </h3>
              {selected.isActive ? (
                <ActiveBadge />
              ) : (
                <span className="text-xs font-semibold uppercase tracking-wider text-muted">Not active</span>
              )}
            </div>
            <SetupSummary setup={selected} revisions={revisions} />
            {selected.notes ? <p className="whitespace-pre-line break-words text-sm text-foreground/90">{selected.notes}</p> : null}
            {can.canManage ? (
              <SetupActions
                setup={selected}
                onRename={() => show({ kind: "rename-setup", id: selected.id })}
                onDeleted={() => setChosen(null)}
              />
            ) : null}
          </Panel>
        ) : null}
      </section>

      <section aria-labelledby="map-heading" className="space-y-4" id="tuning-map">
        <SectionTitle id="map-heading">{selected ? `${selected.name} · current values` : "Suspension map"}</SectionTitle>
        {saved ? (
          <div data-testid="adjust-notice">
            <Alert tone="success">Adjustment saved as revision {saved.number}.</Alert>
          </div>
        ) : null}
        <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,420px)_minmax(0,1fr)]">
          <Panel className="space-y-4 bg-[#0e1114] p-4 sm:p-5 lg:sticky lg:top-20">
            <div className="flex items-center justify-between text-[0.65rem] font-semibold uppercase tracking-[0.25em] text-muted">
              <span>Top view · front ↑</span>
              <span className="text-accent-hot">SledWerx</span>
            </div>
            <SledDiagram selected={zone} onSelect={setZone} counts={counts} />
          </Panel>
          <div className="space-y-6">
            <Panel>
              <ZonePanel
                zone={zone}
                settings={settings}
                values={values}
                hasSetup={Boolean(selected && latest)}
                canAdjust={can.canAdjust}
                canManage={can.canManage}
                onAdjust={() => {
                  setSavedId(null);
                  show({ kind: "adjust" });
                }}
                onAddSetting={(z) => show({ kind: "add-setting", zone: z })}
              />
            </Panel>
            <Panel>
              <ZoneList selected={zone} onSelect={setZone} settings={settings} values={values} />
            </Panel>
          </div>
        </div>
      </section>

      {can.canManage ? (
        <section aria-labelledby="settings-heading" className="space-y-4" id="settings">
          <SectionTitle
            id="settings-heading"
            action={
              <Button type="button" variant="secondary" onClick={() => show({ kind: "add-setting" })}>
                <Settings2 aria-hidden className="size-4" />
                Add setting
              </Button>
            }
          >
            Settings list
          </SectionTitle>
          <p className="text-sm text-muted">
            One list for this snowmobile, shared by all its setups. Each setup keeps its own values, and any setting can be left blank.
          </p>
          <details className="group rounded-2xl border border-white/10 bg-surface/40" open={settings.length === 0 || undefined}>
            <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-3 px-5 py-3 font-semibold">
              <span>
                Customize settings <span className="text-muted">({settings.length})</span>
              </span>
              <ChevronDown aria-hidden className="size-5 text-muted transition-transform group-open:rotate-180" />
            </summary>
            <div className="border-t border-white/10 p-4 sm:p-5">
              <SettingsEditor
                settings={settings}
                onAdd={(z) => show({ kind: "add-setting", zone: z })}
                onEdit={(setting) => show({ kind: "edit-setting", setting })}
              />
            </div>
          </details>
        </section>
      ) : null}

      {can.canManage ? (
        <section aria-labelledby="deleted-heading" className="space-y-4" id="recently-deleted">
          <SectionTitle id="deleted-heading">Recently deleted</SectionTitle>
          <DeletedItems items={deleted} />
        </section>
      ) : null}

      <Sheet
        open={sheet?.kind === "adjust" && Boolean(selected && latest)}
        onClose={close}
        title="Record adjustment"
        description={selected ? `${sled.name} · ${selected.name}` : sled.name}
      >
        {sheet?.kind === "adjust" && selected && latest ? (
          <AdjustForm
            key={session}
            setupId={selected.id}
            setupName={selected.name}
            baseRevisionId={latest.id}
            values={values}
            settings={settings}
            focusZone={zone}
            odometer={sled.odometer}
            engineHours={sled.engineHours}
            onDone={adjusted}
          />
        ) : null}
      </Sheet>

      <Sheet open={sheet?.kind === "new-setup"} onClose={close} title="New setup" description={sled.name}>
        {sheet?.kind === "new-setup" ? (
          <SetupForm
            key={session}
            sledId={sled.id}
            setups={setups}
            revisions={revisions}
            copyFrom={sheet.copyFrom}
            onDone={(id) => {
              setChosen(id);
              close();
            }}
          />
        ) : null}
      </Sheet>

      <Sheet open={sheet?.kind === "rename-setup" && Boolean(renaming)} onClose={close} title="Rename setup" description={sled.name}>
        {sheet?.kind === "rename-setup" && renaming ? (
          <SetupForm key={session} sledId={sled.id} setup={renaming} setups={setups} revisions={revisions} onDone={close} />
        ) : null}
      </Sheet>

      <Sheet open={sheet?.kind === "add-setting"} onClose={close} title="Add setting" description={sled.name}>
        {sheet?.kind === "add-setting" ? <SettingForm key={session} sledId={sled.id} zone={sheet.zone} onDone={close} /> : null}
      </Sheet>

      <Sheet open={sheet?.kind === "edit-setting"} onClose={close} title="Edit setting" description={sled.name}>
        {sheet?.kind === "edit-setting" ? <SettingForm key={session} sledId={sled.id} setting={sheet.setting} onDone={close} /> : null}
      </Sheet>
    </div>
  );
}
