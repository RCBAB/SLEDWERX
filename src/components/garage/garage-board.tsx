"use client";

import { Check, Keyboard, LayoutGrid, Maximize, Minimize, Monitor, Package, Plus, Rows3, Settings2, X } from "lucide-react";
import Link from "next/link";
import { useCallback, useLayoutEffect, useState, useTransition } from "react";

import { saveGarageLayout, saveWallKeyboard } from "@/app/garage/board/actions";
import { CompleteForm, PackageForm, TONE_BAR, TONE_TEXT, type TaskRef } from "@/components/board/complete-form";
import { Sheet } from "@/components/board/sheet";
import { useRefreshOnReturn } from "@/components/board/use-refresh-on-return";
import { SledPhoto } from "@/components/sleds/sled-photo";
import { StatusBadge } from "@/components/sleds/status-badge";
import { UpdateMetersButton } from "@/components/sleds/update-meters";
import { Button, ButtonLink } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { STATUS_LABEL, STATUS_TONE, lastDoneLine, lastDoneShort, nextDueLine, nextDueShort, statusLine } from "@/lib/board/describe";
import type { BoardRow } from "@/lib/board/types";
import type { GarageLayout } from "@/lib/garage/layout";
import type { GarageBoardData, GarageBoardSled } from "@/lib/garage/queries";
import { sledSummary, type SledTone } from "@/lib/garage/summary";
import type { MaintenancePackage } from "@/lib/service/queries";
import { formatHours, formatMiles, sledDescription, sledName } from "@/lib/sleds/format";
import { ROLE_LABELS } from "@/lib/sleds/permissions";

import { useWallDisplay, WallClock } from "./wall";
import { WallKeyboard } from "./wall-keyboard";

type OpenSheet = { kind: "done"; sledId: string; tasks: TaskRef[] } | { kind: "package"; sledId: string } | null;

const TONE_DOT: Record<SledTone, string> = {
  red: "bg-red-500",
  yellow: "bg-amber-400",
  green: "bg-emerald-500",
  neutral: "bg-white/30",
};

const TONE_BORDER: Record<SledTone, string> = {
  red: "border-l-red-500",
  yellow: "border-l-amber-400",
  green: "border-l-emerald-500",
  neutral: "border-l-white/20",
};

/**
 * The Garage Board: every snowmobile the user can see and its maintenance, in
 * one place, like the dry-erase board on the garage wall. It reads the same
 * maintenance_board view and completes tasks with the same forms and action
 * as each sled's own Maintenance Board, so there is one maintenance system.
 */
export function GarageBoard({ data, initialWall }: { data: GarageBoardData; initialWall: boolean }) {
  const [layout, setLayout] = useState<GarageLayout>(data.layout);
  const [keyboard, setKeyboard] = useState(data.keyboard);
  const [, startSaving] = useTransition();
  const [sheet, setSheet] = useState<OpenSheet>(null);
  const [session, setSession] = useState(0);
  const close = useCallback(() => setSheet(null), []);
  const wall = useWallDisplay(initialWall, data.loadedAt);

  // Next.js keeps a page hidden (not unmounted) after navigating away; close
  // any open sheet then, so it isn't still open on return.
  useLayoutEffect(() => () => setSheet(null), []);
  useRefreshOnReturn();

  const all = [...data.owned, ...data.shared];
  const sheetSled = sheet ? all.find((s) => s.sled.id === sheet.sledId) : undefined;
  const open = (next: OpenSheet) => {
    setSession((n) => n + 1);
    setSheet(next);
  };
  const chooseLayout = (next: GarageLayout) => {
    if (next === layout) return;
    setLayout(next);
    startSaving(async () => {
      await saveGarageLayout(next);
    });
  };

  const toggleKeyboard = () => {
    const next = !keyboard;
    setKeyboard(next);
    startSaving(async () => {
      await saveWallKeyboard(next);
    });
  };

  const big = wall.active;
  const sections = [
    { key: "owned", title: "Your snowmobiles", sleds: data.owned },
    { key: "shared", title: "Shared with you", sleds: data.shared },
  ].filter((s) => s.sleds.length);

  return (
    <div
      data-testid="garage-board"
      data-layout={layout}
      data-wall={wall.active ? "on" : "off"}
      className={cn(
        wall.active && "fixed inset-0 z-50 overflow-y-auto overscroll-contain bg-background px-4 pb-10 pt-4 sm:px-8",
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h1 className="font-display text-4xl font-extrabold uppercase italic tracking-tight sm:text-5xl">
            Garage Board
          </h1>
          {wall.active ? <WallClock updatedAt={wall.updatedAt} /> : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div role="group" aria-label="Layout" className="inline-flex rounded-lg border border-white/15 bg-white/5 p-1">
            <LayoutButton active={layout === "cards"} big={big} onClick={() => chooseLayout("cards")}>
              <LayoutGrid aria-hidden className="size-4" />
              Cards
            </LayoutButton>
            <LayoutButton active={layout === "compact"} big={big} onClick={() => chooseLayout("compact")}>
              <Rows3 aria-hidden className="size-4" />
              Compact
            </LayoutButton>
          </div>
          {wall.active ? (
            <>
              <Button
                type="button"
                variant="secondary"
                size="lg"
                className="h-14"
                aria-pressed={keyboard}
                onClick={toggleKeyboard}
              >
                <Keyboard aria-hidden className="size-5" />
                Keyboard: {keyboard ? "On" : "Off"}
              </Button>
              {wall.canFullscreen ? (
                <Button type="button" variant="secondary" size="lg" className="h-14" onClick={wall.toggleFullscreen}>
                  {wall.fullscreen ? <Minimize aria-hidden className="size-5" /> : <Maximize aria-hidden className="size-5" />}
                  {wall.fullscreen ? "Leave full screen" : "Full screen"}
                </Button>
              ) : null}
              <Button type="button" variant="secondary" size="lg" className="h-14" onClick={wall.exit}>
                <X aria-hidden className="size-5" />
                Exit wall display
              </Button>
            </>
          ) : (
            <Button type="button" variant="secondary" onClick={wall.enter}>
              <Monitor aria-hidden className="size-4" />
              Wall display
            </Button>
          )}
        </div>
      </div>

      {wall.active && !wall.canFullscreen ? (
        <p className="mt-2 text-sm text-muted">
          Tip: this browser can&apos;t go full screen. Add SledWerx to your home screen to open it without browser bars.
        </p>
      ) : null}

      {all.length === 0 ? (
        <div className="mt-8 flex flex-col items-center rounded-2xl border border-dashed border-white/15 bg-surface/40 px-6 py-14 text-center">
          <p className="font-display text-2xl font-bold uppercase tracking-wide">No snowmobiles yet</p>
          <p className="mt-2 max-w-sm text-muted">Add a snowmobile, then put its maintenance on the board.</p>
          <ButtonLink href="/garage/new" size="lg" className="mt-6">
            <Plus aria-hidden className="size-4" />
            Add snowmobile
          </ButtonLink>
        </div>
      ) : (
        sections.map((section) => (
          <section key={section.key} className="mt-8" aria-labelledby={`garage-${section.key}`} data-testid={`garage-${section.key}`}>
            <h2 id={`garage-${section.key}`} className="text-sm font-semibold uppercase tracking-[0.2em] text-muted">
              {section.title}
            </h2>
            <ul
              className={cn(
                "mt-3 grid gap-4",
                layout === "cards" && (big ? "lg:grid-cols-2 2xl:grid-cols-3" : "md:grid-cols-2 2xl:grid-cols-3"),
                layout === "compact" && big && "2xl:grid-cols-2",
              )}
            >
              {section.sleds.map((entry) => (
                <li key={entry.sled.id} className="min-w-0">
                  {layout === "cards" ? (
                    <SledCard entry={entry} packages={data.packages} big={big} onOpen={open} />
                  ) : (
                    <SledTable entry={entry} packages={data.packages} big={big} onOpen={open} />
                  )}
                </li>
              ))}
            </ul>
          </section>
        ))
      )}

      {/* The on-screen keyboard exists only in Wall Display, when switched on. */}
      {wall.active && keyboard ? <WallKeyboard /> : null}

      <Sheet
        open={sheet?.kind === "done"}
        onClose={close}
        title={sheet?.kind === "done" && sheet.tasks.length === 1 ? sheet.tasks[0].name : "Mark done"}
        description={sheetSled ? `${sledName(sheetSled.sled)} · Saves a service record and updates the board.` : undefined}
      >
        {sheet?.kind === "done" && sheetSled ? (
          <CompleteForm
            key={session}
            sledId={sheetSled.sled.id}
            taskOptions={sheetSled.taskOptions}
            packages={data.packages}
            readings={sheetSled.readings}
            current={currentMeters(sheetSled)}
            tasks={sheet.tasks}
            onDone={close}
          />
        ) : null}
      </Sheet>

      <Sheet
        open={sheet?.kind === "package"}
        onClose={close}
        title="Complete package"
        description={sheetSled ? `${sledName(sheetSled.sled)} · Tick what you did.` : undefined}
      >
        {sheet?.kind === "package" && sheetSled ? (
          <PackageForm
            key={session}
            sledId={sheetSled.sled.id}
            taskOptions={sheetSled.taskOptions}
            packages={data.packages}
            readings={sheetSled.readings}
            current={currentMeters(sheetSled)}
            onDone={close}
          />
        ) : null}
      </Sheet>
    </div>
  );
}

function currentMeters({ sled }: GarageBoardSled) {
  return { odometer: sled.meters.odometer?.value ?? null, engineHours: sled.meters.engineHours?.value ?? null };
}

function LayoutButton({
  active,
  big,
  onClick,
  children,
}: {
  active: boolean;
  big: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-2 rounded-md px-3 text-sm font-semibold transition-colors",
        big ? "h-12 px-5 text-base" : "h-9",
        active ? "bg-accent text-white" : "text-muted hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

type SledProps = {
  entry: GarageBoardSled;
  packages: MaintenancePackage[];
  big: boolean;
  onOpen: (sheet: OpenSheet) => void;
};

function OverallStatus({ rows, big }: { rows: BoardRow[]; big: boolean }) {
  const summary = sledSummary(rows);
  return (
    <div className="min-w-0" data-testid="sled-overall" data-tone={summary.tone}>
      <p className={cn("flex items-center gap-2 font-semibold", big ? "text-lg" : "text-sm", TONE_TEXT[summary.tone])}>
        <span aria-hidden className={cn("size-2.5 shrink-0 rounded-full", TONE_DOT[summary.tone])} />
        {summary.label}
      </p>
      <p className={cn("text-muted", big ? "text-base" : "text-xs")}>{summary.detail}</p>
    </div>
  );
}

function Meters({ entry, big }: { entry: GarageBoardSled; big: boolean }) {
  const { meters } = entry.sled;
  return (
    <p className={cn("tabular-nums text-foreground/90", big ? "text-lg" : "text-sm")} data-testid="sled-meters">
      {formatMiles(meters.odometer?.value)}
      {meters.engineHours ? ` · ${formatHours(meters.engineHours.value)}` : ""}
    </p>
  );
}

function SledActions({ entry, packages, big, onOpen }: SledProps) {
  const name = sledName(entry.sled);
  const { meters } = entry.sled;
  return (
    <div className="flex flex-wrap gap-2">
      {entry.canAddReading ? (
        <UpdateMetersButton
          sledId={entry.sled.id}
          sledName={name}
          size={big ? "lg" : "md"}
          className={cn(big && "h-14")}
          current={{
            odometer: meters.odometer ? { value: meters.odometer.value, readOn: meters.odometer.readOn } : null,
            engineHours: meters.engineHours ? { value: meters.engineHours.value, readOn: meters.engineHours.readOn } : null,
          }}
        />
      ) : null}
      {entry.canComplete && packages.length ? (
        <Button
          type="button"
          variant="secondary"
          size={big ? "lg" : "md"}
          className={cn(big && "h-14")}
          aria-label={`Complete package on ${name}`}
          onClick={() => onOpen({ kind: "package", sledId: entry.sled.id })}
        >
          <Package aria-hidden className="size-4" />
          Complete package
        </Button>
      ) : null}
      {entry.canManage ? (
        <ButtonLink
          href={`/garage/${entry.sled.id}#board-heading`}
          variant="ghost"
          size={big ? "lg" : "md"}
          className={cn(big && "h-14")}
          aria-label={`Edit schedules for ${name}`}
        >
          <Settings2 aria-hidden className="size-4" />
          Edit schedules
        </ButtonLink>
      ) : null}
    </div>
  );
}

function SledHeading({ entry, big }: { entry: GarageBoardSled; big: boolean }) {
  const { sled } = entry;
  const name = sledName(sled);
  return (
    <div className="min-w-0">
      <div className="flex flex-wrap items-center gap-2">
        <Link
          href={`/garage/${sled.id}`}
          className={cn(
            "break-words font-display font-bold uppercase italic leading-tight hover:text-accent-hot",
            big ? "text-3xl" : "text-2xl",
          )}
        >
          {name}
        </Link>
        <StatusBadge status={sled.status} />
        {entry.role !== "owner" ? (
          <span className="inline-flex rounded-full bg-white/5 px-3 py-1 text-xs font-semibold text-muted">{ROLE_LABELS[entry.role]}</span>
        ) : null}
      </div>
      <p className={cn("text-muted", big ? "text-base" : "text-sm")}>
        {sledDescription({ model_year: sled.modelYear, make: sled.make, model: sled.model })}
      </p>
    </div>
  );
}

function EmptyRows({ entry }: { entry: GarageBoardSled }) {
  return (
    <p className="rounded-xl border border-dashed border-white/15 px-4 py-5 text-center text-sm text-muted">
      Nothing on the board yet.
      {entry.canManage ? (
        <>
          {" "}
          <Link href={`/garage/${entry.sled.id}#board-heading`} className="font-semibold text-foreground underline underline-offset-4">
            Add maintenance on the sled page
          </Link>
        </>
      ) : null}
    </p>
  );
}

function DoneButton({ entry, row, big, onOpen }: { entry: GarageBoardSled; row: BoardRow; big: boolean; onOpen: SledProps["onOpen"] }) {
  return (
    <Button
      type="button"
      size={big ? "lg" : "md"}
      className={cn(big && "h-14")}
      aria-label={`Mark ${row.taskName} done on ${sledName(entry.sled)}`}
      onClick={() => onOpen({ kind: "done", sledId: entry.sled.id, tasks: [{ taskId: row.taskId, name: row.taskName }] })}
    >
      <Check aria-hidden className="size-4" />
      Done
    </Button>
  );
}

/** Full Cards: photo, name, mileage, overall status, and every task with Done. */
function SledCard(props: SledProps) {
  const { entry, big, onOpen } = props;
  const { sled, rows } = entry;
  const current = currentMeters(entry);
  return (
    <article
      data-testid="garage-sled"
      data-sled-id={sled.id}
      aria-label={sledName(sled)}
      className="flex h-full flex-col overflow-hidden rounded-2xl border border-white/10 bg-surface/70"
    >
      <SledPhoto url={sled.photoUrl} alt={sledName(sled)} className={cn("w-full", big ? "aspect-[21/9]" : "aspect-[16/7]")} />
      <div className="flex flex-1 flex-col gap-4 p-4 sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <SledHeading entry={entry} big={big} />
          <Meters entry={entry} big={big} />
        </div>
        <OverallStatus rows={rows} big={big} />
        {rows.length ? (
          <ul className="space-y-2" data-testid="garage-tasks">
            {rows.map((row) => {
              const tone = STATUS_TONE[row.status];
              return (
                <li
                  key={row.planId}
                  data-testid="garage-task"
                  data-status={row.status}
                  className="flex items-stretch overflow-hidden rounded-xl border border-white/10 bg-background/40"
                >
                  <span aria-hidden className={cn("w-1.5 shrink-0", TONE_BAR[tone])} />
                  <div className="flex min-w-0 flex-1 items-center gap-3 p-3">
                    <div className="min-w-0 flex-1">
                      <p className={cn("break-words font-semibold", big && "text-lg")}>
                        <span>{row.taskName}</span>
                        <span className="sr-only">: {STATUS_LABEL[row.status]}</span>
                      </p>
                      <p className={cn("font-semibold", big ? "text-base" : "text-sm", TONE_TEXT[tone])} data-testid="board-status">
                        {statusLine(row)}
                      </p>
                      <p className={cn("text-muted", big ? "text-sm" : "text-xs")} data-testid="board-last-done">
                        {lastDoneLine(row)}
                      </p>
                      <p className={cn("text-muted", big ? "text-sm" : "text-xs")} data-testid="board-next-due">
                        {nextDueLine(row, current)}
                      </p>
                    </div>
                    {entry.canComplete ? <DoneButton entry={entry} row={row} big={big} onOpen={onOpen} /> : null}
                  </div>
                </li>
              );
            })}
          </ul>
        ) : (
          <EmptyRows entry={entry} />
        )}
        <div className="mt-auto">
          <SledActions {...props} />
        </div>
      </div>
    </article>
  );
}

/** Compact: a small header and a table of tasks (stacked rows on phones). */
function SledTable(props: SledProps) {
  const { entry, big, onOpen } = props;
  const { sled, rows } = entry;
  const current = currentMeters(entry);
  const cell = big ? "text-base" : "text-sm";
  return (
    <article
      data-testid="garage-sled"
      data-sled-id={sled.id}
      aria-label={sledName(sled)}
      className="overflow-hidden rounded-2xl border border-white/10 bg-surface/70"
    >
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-white/10 p-4">
        <div className="min-w-0 space-y-1">
          <SledHeading entry={entry} big={big} />
          <Meters entry={entry} big={big} />
        </div>
        <OverallStatus rows={rows} big={big} />
      </div>
      {rows.length ? (
        <table className={cn("block w-full sm:table", cell)} data-testid="garage-tasks">
          <caption className="sr-only">Maintenance for {sledName(sled)}</caption>
          <thead className="hidden text-left text-xs uppercase tracking-[0.15em] text-muted sm:table-header-group">
            <tr>
              <th scope="col" className="py-2 pl-4 pr-3 font-semibold">
                Task
              </th>
              <th scope="col" className="px-3 py-2 font-semibold">
                Status
              </th>
              <th scope="col" className="px-3 py-2 font-semibold">
                Last done
              </th>
              <th scope="col" className="px-3 py-2 font-semibold">
                Next due
              </th>
              <th scope="col" className="py-2 pl-3 pr-4">
                <span className="sr-only">Done</span>
              </th>
            </tr>
          </thead>
          <tbody className="block sm:table-row-group">
            {rows.map((row) => {
              const tone = STATUS_TONE[row.status];
              return (
                <tr
                  key={row.planId}
                  data-testid="garage-task"
                  data-status={row.status}
                  className={cn(
                    "grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 border-l-4 border-t border-t-white/10 px-4 py-3 sm:table-row sm:px-0 sm:py-0",
                    TONE_BORDER[tone],
                  )}
                >
                  <td className="col-start-1 min-w-0 break-words font-semibold sm:py-3 sm:pl-4 sm:pr-3">
                    <span>{row.taskName}</span>
                    <span className="sr-only">: {STATUS_LABEL[row.status]}</span>
                  </td>
                  <td className={cn("col-start-1 min-w-0 font-semibold sm:px-3 sm:py-3", TONE_TEXT[tone])} data-testid="board-status">
                    {statusLine(row)}
                  </td>
                  <td className="col-start-1 min-w-0 text-muted sm:px-3 sm:py-3" data-testid="board-last-done">
                    <span className="sm:hidden">Last: </span>
                    {lastDoneShort(row)}
                  </td>
                  <td className="col-start-1 min-w-0 text-muted sm:px-3 sm:py-3" data-testid="board-next-due">
                    <span className="sm:hidden">Next: </span>
                    {nextDueShort(row, current)}
                  </td>
                  <td className="col-start-2 row-span-4 row-start-1 self-center text-right sm:py-2 sm:pl-3 sm:pr-4">
                    {entry.canComplete ? <DoneButton entry={entry} row={row} big={big} onOpen={onOpen} /> : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : (
        <div className="p-4">
          <EmptyRows entry={entry} />
        </div>
      )}
      {entry.canComplete || entry.canManage || entry.canAddReading ? (
        <div className="border-t border-white/10 p-3">
          <SledActions {...props} />
        </div>
      ) : null}
    </article>
  );
}
