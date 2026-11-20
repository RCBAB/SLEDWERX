"use client";

import { ChevronDown, Eye, ListChecks, Map as MapIcon, MessageSquarePlus, Settings2, SlidersHorizontal, Wrench } from "lucide-react";
import { useCallback, useLayoutEffect, useState } from "react";

import { applySuggestedSettings, type SuspensionActionState } from "@/app/garage/suspension-actions";
import { Sheet } from "@/components/board/sheet";
import { useRefreshOnReturn } from "@/components/board/use-refresh-on-return";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import type { SledRole } from "@/lib/sleds/constants";
import { ROLE_LABELS, suspensionCapabilities } from "@/lib/sleds/permissions";
import { VIEW_COOKIE, baseOf, byNumberDesc, type SuspensionViewMode } from "@/lib/suspension/quick-tune";
import { SUGGESTED_SETTINGS } from "@/lib/suspension/template";
import {
  SUSPENSION_ZONES,
  ZONE_LABEL,
  configName,
  type SuspensionData,
  type SuspensionFeedback,
  type SuspensionRevision,
  type SuspensionSetting,
  type SuspensionZone,
} from "@/lib/suspension/types";

import { ActivateForm } from "./activate-form";
import { AdjustForm } from "./adjust-form";
import { CompareConfigurations } from "./compare";
import { ConfigurationDetails, ConfigurationHistory } from "./configurations";
import { DeletedItems } from "./deleted-items";
import { EquipmentForm } from "./equipment";
import { EvaluationForm } from "./evaluation-form";
import { PhotoManager } from "./photos";
import { QuickTune } from "./quick-tune";
import { SettingForm, SettingsEditor } from "./settings-editor";
import { ActiveBadge, ConditionChips, EquipmentText, LocalDate, Panel, RatingBadge, SectionTitle, useRun } from "./shared";
import { SledDiagram } from "./sled-diagram";
import { UNSAVED_MESSAGE, useUnsavedWarning } from "./use-unsaved-warning";
import { ZoneList, ZonePanel } from "./zones";

/** Remember Quick Tune or the map in this browser (read by the page on the server). */
function rememberView(mode: SuspensionViewMode) {
  try {
    document.cookie = `${VIEW_COOKIE}=${mode}; path=/; max-age=31536000; samesite=lax`;
  } catch {
    // Not remembered: the default view next time.
  }
}

export type SledInfo = { id: string; name: string; description: string; odometer: number | null; engineHours: number | null };

type OpenSheet =
  | { kind: "add-setting"; zone?: SuspensionZone }
  | { kind: "edit-setting"; setting: SuspensionSetting }
  | { kind: "adjust" }
  | { kind: "evaluation"; revision: SuspensionRevision; feedback?: SuspensionFeedback }
  | { kind: "activate"; revision: SuspensionRevision }
  | { kind: "view"; revision: SuspensionRevision }
  | { kind: "equipment" }
  | { kind: "photos"; parent: "setting" | "revision"; id: string }
  | null;

/**
 * The Suspension page for one sled. Quick Tune (default) or the Suspension Map
 * (remembered per browser), both working on the ACTIVE numbered configuration
 * shown at the top; the configuration history with ride evaluations and Make
 * active; comparison of any two configurations; the settings list (suggested
 * template or blank) and Recently Deleted. Everything is saved through the
 * suspension server actions as the signed-in user; controls follow the role.
 */
export function SuspensionView({
  data,
  sled,
  role,
  photoUploads,
  userId,
  initialView,
}: {
  data: SuspensionData;
  sled: SledInfo;
  role: SledRole;
  /** The photo-upload feature flag (decided on the server). */
  photoUploads: boolean;
  userId: string;
  initialView: SuspensionViewMode;
}) {
  useRefreshOnReturn();
  const can = suspensionCapabilities(role, { photoUploads });
  const [view, setView] = useState<SuspensionViewMode>(initialView);
  const [sheet, setSheet] = useState<OpenSheet>(null);
  const [session, setSession] = useState(0);
  const [zone, setZone] = useState<SuspensionZone>(SUSPENSION_ZONES[0]);
  const [editorOpen, setEditorOpen] = useState(false);
  const [notice, setNotice] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const [compare, setCompare] = useState<{ a: string; b: string } | null>(null);
  const [dirty, setDirty] = useState(false);
  const [tuneKey, setTuneKey] = useState(0);
  useUnsavedWarning(dirty);
  const onDirtyChange = useCallback((value: boolean) => setDirty(value), []);
  // Close sheets when the page is hidden (Next.js keeps it mounted).
  useLayoutEffect(() => () => setSheet(null), []);

  const show = (next: OpenSheet) => {
    setSession((n) => n + 1);
    setSheet(next);
  };
  const close = () => setSheet(null);

  const { settings, revisions, deleted, activeRevisionId, installed } = data;
  const active = revisions.find((r) => r.id === activeRevisionId);
  const ordered = byNumberDesc(revisions);
  const counts = Object.fromEntries(SUSPENSION_ZONES.map((z) => [z, settings.filter((s) => s.zone === z).length])) as Record<
    SuspensionZone,
    number
  >;

  const switchView = (next: SuspensionViewMode) => {
    if (next === view) return;
    if (dirty && !window.confirm(UNSAVED_MESSAGE)) return;
    if (dirty) {
      setTuneKey((k) => k + 1);
      setDirty(false);
    }
    setView(next);
    rememberView(next);
  };

  const saved = (result: SuspensionActionState, verb = "Saved as") => {
    close();
    if (result.ok && result.configNumber)
      setNotice({ tone: "success", text: `${verb} ${configName(result.configNumber)}. It's the active configuration now.` });
  };

  // The photos sheet reads the current data, so it updates after each upload or removal.
  const photoTarget = (() => {
    if (sheet?.kind !== "photos") return undefined;
    if (sheet.parent === "setting") {
      const setting = settings.find((s) => s.id === sheet.id);
      return setting ? { label: setting.name, title: `${setting.name} · ${sled.name}`, photos: setting.photos } : undefined;
    }
    const revision = revisions.find((r) => r.id === sheet.id);
    return revision
      ? { label: configName(revision.configNumber), title: `${configName(revision.configNumber)} · ${sled.name}`, photos: revision.photos }
      : undefined;
  })();

  const defaultCompare = () => {
    const b = active ?? ordered[0];
    const a = b ? (baseOf(revisions, b) ?? ordered.find((r) => r.id !== b.id)) : undefined;
    return a && b ? { a: a.id, b: b.id } : null;
  };
  const pair = compare ?? defaultCompare();
  const showCompare = (revision: SuspensionRevision) => {
    const other = revision.id === active?.id ? (baseOf(revisions, revision) ?? ordered.find((r) => r.id !== revision.id)) : active;
    setCompare({ a: revision.id, b: other?.id ?? revision.id });
    document.getElementById("compare")?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <div className="mt-3 space-y-8" data-testid="suspension-page" data-sled-id={sled.id}>
      <header className="space-y-2">
        <h1 className="font-display text-4xl font-extrabold uppercase italic leading-none tracking-tight sm:text-5xl">Suspension</h1>
        <p className="text-lg text-muted">
          {sled.name}
          {sled.name !== sled.description ? ` · ${sled.description}` : ""}
        </p>
        {!can.canAdjust ? (
          <p className="text-sm text-muted" data-testid="read-only-note">
            You can view this snowmobile&apos;s suspension ({ROLE_LABELS[role]}
            ). The owner, editors and mechanics record changes.
          </p>
        ) : null}
      </header>

      <ActiveConfiguration
        active={active}
        installed={installed}
        canAdjust={can.canAdjust}
        canAddFeedback={can.canAddFeedback}
        dirty={dirty}
        onEquipment={() => show({ kind: "equipment" })}
        onEvaluate={(revision) => show({ kind: "evaluation", revision })}
        onView={(revision) => show({ kind: "view", revision })}
      />

      {notice ? (
        <div data-testid="suspension-notice">
          <Alert tone={notice.tone}>{notice.text}</Alert>
        </div>
      ) : null}

      {!settings.length ? (
        <GettingStarted
          sledId={sled.id}
          canManage={can.canManage}
          onBlank={() => {
            setEditorOpen(true);
            show({ kind: "add-setting" });
          }}
        />
      ) : null}

      <section aria-labelledby="tune-heading" className="space-y-4" id="tune">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 id="tune-heading" className="font-display text-2xl font-bold uppercase tracking-wide">
            {view === "quick" ? "Quick Tune" : "Suspension Map"}
          </h2>
          <div className="inline-flex rounded-xl bg-white/5 p-1 ring-1 ring-white/10" role="group" aria-label="View">
            {(
              [
                ["quick", "Quick Tune", ListChecks],
                ["map", "Suspension Map", MapIcon],
              ] as const
            ).map(([mode, text, Icon]) => (
              <button
                key={mode}
                type="button"
                aria-pressed={view === mode}
                onClick={() => switchView(mode)}
                className={cn(
                  "inline-flex min-h-11 items-center gap-2 rounded-lg px-4 text-sm font-semibold",
                  view === mode ? "bg-primary text-white" : "text-muted hover:text-foreground",
                )}
              >
                <Icon aria-hidden className="size-4" />
                {text}
              </button>
            ))}
          </div>
        </div>

        {view === "quick" ? (
          <QuickTune
            key={`${tuneKey}-${active?.id ?? "none"}`}
            sledId={sled.id}
            settings={settings}
            active={active}
            installed={installed}
            revisions={revisions}
            canAdjust={can.canAdjust}
            canManage={can.canManage}
            odometer={sled.odometer}
            engineHours={sled.engineHours}
            onSaved={(result) => saved(result)}
            onDirtyChange={onDirtyChange}
            onAddSetting={(z) => show({ kind: "add-setting", zone: z })}
            onPhotos={(setting) => show({ kind: "photos", parent: "setting", id: setting.id })}
          />
        ) : (
          <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,420px)_minmax(0,1fr)]" data-testid="suspension-map">
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
                  values={active?.values ?? {}}
                  hasSetup={settings.length > 0}
                  canAdjust={can.canAdjust}
                  canManage={can.canManage}
                  canAddPhotos={can.canAddReferencePhotos}
                  onAdjust={() => {
                    setNotice(null);
                    show({ kind: "adjust" });
                  }}
                  onAddSetting={(z) => show({ kind: "add-setting", zone: z })}
                  onPhotos={(setting) => show({ kind: "photos", parent: "setting", id: setting.id })}
                />
              </Panel>
              <Panel>
                <ZoneList selected={zone} onSelect={setZone} settings={settings} values={active?.values ?? {}} />
              </Panel>
            </div>
          </div>
        )}
      </section>

      {revisions.length ? (
        <section aria-labelledby="history-heading" className="scroll-mt-20 space-y-4" id="history">
          <SectionTitle id="history-heading">Trail configurations</SectionTitle>
          <ConfigurationHistory
            revisions={revisions}
            activeId={activeRevisionId}
            settings={settings}
            role={role}
            photoUploads={photoUploads}
            userId={userId}
            onView={(revision) => show({ kind: "view", revision })}
            onCompare={showCompare}
            onActivate={(revision) => show({ kind: "activate", revision })}
            onAddEvaluation={(revision) => show({ kind: "evaluation", revision })}
            onEditEvaluation={(revision, feedback) => show({ kind: "evaluation", revision, feedback })}
            onPhotos={(revision) => show({ kind: "photos", parent: "revision", id: revision.id })}
          />
        </section>
      ) : null}

      {pair && revisions.length > 1 ? (
        <section aria-labelledby="compare-heading" className="scroll-mt-20 space-y-4" id="compare">
          <SectionTitle id="compare-heading">Compare configurations</SectionTitle>
          <Panel>
            <CompareConfigurations
              revisions={revisions}
              activeId={activeRevisionId}
              settings={settings}
              aId={pair.a}
              bId={pair.b}
              onChange={(a, b) => setCompare({ a, b })}
            />
          </Panel>
        </section>
      ) : null}

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
            One list for this snowmobile. Rename settings, change units, add or remove them; saved configurations keep their values.
          </p>
          <details
            className="group rounded-2xl border border-white/10 bg-surface/40"
            open={editorOpen}
            onToggle={(event) => setEditorOpen(event.currentTarget.open)}
          >
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
        open={sheet?.kind === "adjust"}
        onClose={close}
        title="Record adjustment"
        description={active ? `${sled.name} · from ${configName(active.configNumber)}` : sled.name}
      >
        {sheet?.kind === "adjust" ? (
          <AdjustForm
            key={session}
            configName={active ? configName(active.configNumber) : null}
            baseRevisionId={active?.id ?? null}
            values={active?.values ?? {}}
            sledId={sled.id}
            settings={settings}
            focusZone={zone}
            odometer={sled.odometer}
            engineHours={sled.engineHours}
            photoUploads={can.canAddAdjustmentPhotos}
            onDone={(result) => saved(result)}
          />
        ) : null}
      </Sheet>

      <Sheet
        open={sheet?.kind === "evaluation"}
        onClose={close}
        title={sheet?.kind === "evaluation" && sheet.feedback ? "Edit ride evaluation" : "Ride evaluation"}
        description={sheet?.kind === "evaluation" ? `${sled.name} · ${configName(sheet.revision.configNumber)}` : undefined}
      >
        {sheet?.kind === "evaluation" ? (
          <EvaluationForm
            key={session}
            sledId={sled.id}
            revisionId={sheet.revision.id}
            feedback={sheet.feedback}
            onDone={() => {
              close();
              setNotice({ tone: "success", text: "Ride evaluation saved." });
            }}
          />
        ) : null}
      </Sheet>

      <Sheet
        open={sheet?.kind === "activate"}
        onClose={close}
        title="Make active"
        description={sheet?.kind === "activate" ? `${sled.name} · ${configName(sheet.revision.configNumber)}` : undefined}
      >
        {sheet?.kind === "activate" ? (
          <ActivateForm
            key={session}
            revision={sheet.revision}
            active={active}
            installed={installed}
            revisions={revisions}
            settings={settings}
            onCancel={close}
            onDone={(result) => {
              close();
              if (result.configNumber)
                setNotice({ tone: "success", text: `${configName(result.configNumber)} is the active configuration now.` });
            }}
          />
        ) : null}
      </Sheet>

      <Sheet
        open={sheet?.kind === "view"}
        onClose={close}
        title={sheet?.kind === "view" ? configName(sheet.revision.configNumber) : "Configuration"}
        description={sled.name}
      >
        {sheet?.kind === "view" ? (
          <div className="space-y-5">
            <ConfigurationDetails
              revision={sheet.revision}
              settings={settings}
              active={sheet.revision.id === activeRevisionId}
              role={role}
              userId={userId}
            />
            {can.canAdjust && sheet.revision.id !== activeRevisionId ? (
              <Button type="button" size="lg" className="w-full" onClick={() => show({ kind: "activate", revision: sheet.revision })}>
                Make {configName(sheet.revision.configNumber)} active…
              </Button>
            ) : null}
          </div>
        ) : null}
      </Sheet>

      <Sheet open={sheet?.kind === "equipment"} onClose={close} title="Skis & carbides" description={sled.name}>
        {sheet?.kind === "equipment" ? (
          <EquipmentForm
            key={session}
            sledId={sled.id}
            activeRevisionId={active?.id ?? null}
            activeName={active ? configName(active.configNumber) : null}
            installed={installed}
            values={active?.values ?? {}}
            revisions={revisions}
            onDone={(result) => saved(result, "New skis or carbides saved as")}
          />
        ) : null}
      </Sheet>

      <Sheet
        open={sheet?.kind === "photos" && Boolean(photoTarget)}
        onClose={close}
        title={sheet?.kind === "photos" && sheet.parent === "setting" ? "Reference photos" : "Adjustment photos"}
        description={photoTarget?.title}
      >
        {sheet?.kind === "photos" && photoTarget ? (
          <PhotoManager
            key={session}
            sledId={sled.id}
            parent={{ kind: sheet.parent, id: sheet.id }}
            label={photoTarget.label}
            photos={photoTarget.photos}
            canAdd={sheet.parent === "setting" ? can.canAddReferencePhotos : can.canAddAdjustmentPhotos}
            canRemove={can.canRemove}
          />
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

/** The active configuration, clearly at the top: number, skis and carbides, newest ride evaluation. */
function ActiveConfiguration({
  active,
  installed,
  canAdjust,
  canAddFeedback,
  dirty,
  onEquipment,
  onEvaluate,
  onView,
}: {
  active: SuspensionRevision | undefined;
  installed: SuspensionData["installed"];
  canAdjust: boolean;
  canAddFeedback: boolean;
  dirty: boolean;
  onEquipment: () => void;
  onEvaluate: (revision: SuspensionRevision) => void;
  onView: (revision: SuspensionRevision) => void;
}) {
  const latest = active?.feedback[0];
  return (
    <Panel className="space-y-4 border-accent/40" data-testid="active-configuration">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-muted">Active configuration</p>
          {active ? (
            <p className="mt-1 flex flex-wrap items-center gap-3">
              <span className="font-display text-4xl font-extrabold uppercase italic leading-none" data-testid="active-name">
                {configName(active.configNumber)}
              </span>
              <ActiveBadge />
            </p>
          ) : (
            <p className="mt-1 text-lg font-semibold" data-testid="active-name">
              None yet
            </p>
          )}
          <p className="mt-1 text-sm text-muted">
            {active ? (
              <>
                Saved <LocalDate value={active.createdAt} withTime /> · {active.createdByName}
              </>
            ) : (
              "Make adjustments below and Save Adjustments to create Trail 1."
            )}
          </p>
        </div>
        {active ? (
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="ghost" onClick={() => onView(active)} aria-label={`View ${configName(active.configNumber)}`}>
              <Eye aria-hidden className="size-4" />
              View
            </Button>
            {canAddFeedback ? (
              <Button
                type="button"
                variant="secondary"
                onClick={() => onEvaluate(active)}
                aria-label={`Add ride evaluation to ${configName(active.configNumber)}`}
              >
                <MessageSquarePlus aria-hidden className="size-4" />
                Ride evaluation
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>

      <div
        className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-background/40 px-4 py-3 ring-1 ring-white/10"
        data-testid="active-equipment"
      >
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-muted">Active ski configuration</p>
          <p className="mt-0.5 text-lg">
            <EquipmentText equipment={installed} className="font-semibold" />
          </p>
        </div>
        {canAdjust ? (
          <div className="text-right">
            <Button type="button" variant="secondary" onClick={onEquipment} disabled={dirty} aria-label="Change skis or carbides">
              <Wrench aria-hidden className="size-4" />
              Change
            </Button>
            {dirty ? <p className="mt-1 text-xs text-muted">Save or discard your adjustments first.</p> : null}
          </div>
        ) : null}
      </div>

      {latest ? (
        <div className="flex flex-wrap items-center gap-2 text-sm" data-testid="active-evaluation">
          <span className="text-muted">Latest ride:</span>
          <RatingBadge rating={latest.rating} />
          <ConditionChips conditions={latest.conditions} />
        </div>
      ) : active ? (
        <p className="text-sm text-muted">No ride evaluations for {configName(active.configNumber)} yet.</p>
      ) : null}
    </Panel>
  );
}

/** A sled without settings: the one suggested template, or start blank. */
function GettingStarted({ sledId, canManage, onBlank }: { sledId: string; canManage: boolean; onBlank: () => void }) {
  const { busy, error, run } = useRun();
  const zones = [...new Set(SUGGESTED_SETTINGS.map((s) => s.zone))];
  return (
    <Panel className="space-y-4" data-testid="getting-started">
      <div>
        <h2 className="font-display text-2xl font-bold uppercase tracking-wide">Set up your settings</h2>
        <p className="mt-1 text-sm text-muted">
          {canManage
            ? "Start from the suggested list or from nothing. You can rename, remove and add settings and change units at any time. No values are filled in."
            : "This snowmobile has no suspension settings yet. The owner or an editor sets them up."}
        </p>
      </div>
      {canManage ? (
        <>
          {error ? <Alert tone="error">{error}</Alert> : null}
          <details className="group rounded-xl border border-white/10">
            <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 px-4 py-2 text-sm font-semibold">
              What&apos;s in the suggested list ({SUGGESTED_SETTINGS.length} settings)
              <ChevronDown aria-hidden className="size-5 text-muted transition-transform group-open:rotate-180" />
            </summary>
            <ul className="space-y-1 border-t border-white/10 px-4 py-3 text-sm" data-testid="template-preview">
              {zones.map((z) => (
                <li key={z}>
                  <span className="text-muted">{ZONE_LABEL[z]}:</span>{" "}
                  {SUGGESTED_SETTINGS.filter((s) => s.zone === z)
                    .map((s) => `${s.name}${s.unit ? ` (${s.unit})` : ""}`)
                    .join(", ")}
                </li>
              ))}
            </ul>
          </details>
          <div className="grid gap-3 sm:grid-cols-2">
            <Button type="button" size="lg" disabled={busy} onClick={() => void run(() => applySuggestedSettings(sledId))}>
              <SlidersHorizontal aria-hidden className="size-4" />
              Use suggested settings
            </Button>
            <Button type="button" size="lg" variant="secondary" disabled={busy} onClick={onBlank}>
              Start blank
            </Button>
          </div>
        </>
      ) : null}
    </Panel>
  );
}
