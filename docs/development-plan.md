# SledWerx development plan

Approved features that are planned but not built yet, in order. Each one is
designed and its open decisions settled before any implementation starts.

| Order | Feature | Status |
|---|---|---|
| 1 | [Suspension Measurement / Turns](#1-suspension-measurement--turns) | PR 1 merged (Migration 12 applied); PR 2 (interface) in review |
| 2 | [Maintenance Inspection & Replacement Tracking](#2-maintenance-inspection--replacement-tracking) | Requirements approved; next after Measurement / Turns is complete |

Production context (as of 2026-11-24):
- Measurement photo uploads are live (`SUSPENSION_PHOTO_UPLOADS=on`,
  Production only). Migrations 1–11 are applied.
- The Migration 8 cleanup runs report-only. Deletion and retention are off and
  are a separate decision; they are not a prerequisite for anything below.

---

## 1. Suspension Measurement / Turns

### Approved requirements

1. **Input methods per suspension setting:** Measurement only (inches), Turns
   only, or both. At least one is required. For settings with both, Quick
   Tune has a Measurement / Turns selector, Measurement by default.
2. **Turns are adjustments,** not totals from a reference point: +2 tightens
   two turns, −1 loosens one, +0.5 tightens half a turn. Successive
   adjustments add up (+2, +1, −0.5 = +2.5). Each adjustment creates a new
   numbered Trail, and each one stays visible in History. If the total returns
   to 0, the measurement stays blank and Measurement Needed stays on.
3. **Actual measurements:** while turns are outstanding the measurement is
   blank. Entering the physical measurement later updates the same Trail
   (no new Trail number), replaces the displayed turns with the measurement,
   clears Measurement Needed, keeps the turns history, and leaves Photo Needed
   on until a new photo is uploaded. A current measurement and current turns
   are never shown together.
4. **Automatic reminders (settings with both methods):** entering turns sets
   Measurement Needed and Photo Needed, with no configuration. They are
   independent: a measurement clears Measurement Needed only; one newly
   uploaded photo clears Photo Needed (a second photo stays optional). Any
   turns adjustment, including a fraction, marks earlier photos as outdated.
5. **Measurement photos:** a new Trail carries earlier photos forward for
   reference, labelled outdated / Previous Trail Photos when turns changed
   that setting, and never counted as newly captured. One new photo clears
   Photo Needed for that Trail only. Adding, replacing or removing photos
   never creates a Trail. Older Trails keep their own photos and reminders.
   The two-photo limit and all security controls stay as they are.
6. **Trails:** each real adjustment creates a numbered Trail. Unchanged
   settings carry forward, including cumulative turns and outstanding
   reminders. Activating an older Trail restores its configuration and
   reminders. Documenting a measurement or uploading a photo updates only
   that Trail and never recalculates or overwrites newer Trails.
7. **Reminder visibility:** beside the setting in Quick Tune, in a summary at
   the top of the Suspension page, and on the snowmobile dashboard (Active
   Trail only; switching Trails updates it immediately). Inactive Trails keep
   their own reminder status in History.
8. **Preserve everything existing:** Quick Tune and Save Adjustments, Trail
   numbering and activation, History and evaluations, skis and carbides,
   measurement photos and the two-photo limit, existing measurements, and the
   PR #20 Quick Tune timing fixes. No existing data is lost.

### Design decisions (all final)

| # | Decision |
|---|---|
| 1 | "Task" means an individual suspension setting (not a maintenance task). Measurement only / Turns only / Both is chosen when creating or editing a setting; existing settings default to Measurement only. |
| 2 | No "Not needed" dismiss: Photo Needed is cleared only by uploading one new photo for that setting on that Trail (can be added later if needed). |
| 3 | Units stay customizable and existing units are preserved; inches is the default only when no unit is set (editable). Turns always display as turns, independent of the unit; Turns only settings show no measurement unit. No conversions or data changes. |
| 4 | Each − / + tap is ±0.5 turns (no per-setting step option); typed amounts up to two decimals; signed adjustments and cumulative totals are displayed; 0 means no change and creates no adjustment; a single adjustment beyond ±20 turns asks for confirmation but is allowed; no limit on the cumulative total. |
| 5 | While Measurement Needed is on, entering a measurement in Quick Tune (same row, existing Measurement / Turns selector; no separate form, popup or navigation) and tapping Record Measurement documents the active Trail without a new Trail: clears Measurement Needed, keeps Photo Needed until a new photo, keeps all turns adjustments in History. A documented measurement can be corrected on the same Trail, keeping the correction history. Later physical adjustments create a new Trail as normal. |
| 6 | (a) Any value change in a save (Measurement mode or turns) marks that setting's carried-forward photos outdated; ordinary measurement changes raise no Photo Needed; unchanged settings keep their photo status. (b) Photo Needed is derived: on while a turns-flagged Trail has no active new (non-inherited) photo for that setting. Removing the last qualifying photo reactivates it; restoring or replacing clears it; with two new photos, removing one keeps it cleared. All photo statuses and reminders are per setting and per Trail. |
| 7 | Reminders on both the snowmobile page (each setting needing a measurement or photo listed) and the Garage Board including the wall display (compact counts that don't enlarge the card; selecting them opens that snowmobile's Suspension page). Active Trail only; switching Trails updates them immediately. Reuse the shared `SuspensionSummary` component and active-Trail query. |
| 8 | Quick Tune is the interface for turns and Record Measurement, and stays fully usable in Garage Mode and on the wall touchscreen. Record adjustment is unchanged wherever applicable; Turns only settings and Both settings with outstanding turns are read-only there, with a direct link to Quick Tune. Recording a measurement on an older Trail requires activating it first; newer Trails are never affected. |

### Implementation plan (approved: Migration 12, two PRs)

**PR 1: database and the input-method setting.** Detailed scope below.
Migration 12 is applied with the usual SQL Editor process (preflight, trial
with ROLLBACK, apply, read-only verification) **before** PR 1 is merged: it
works with the app as deployed today, and the new settings form saves the
input method, which needs the column.

**PR 2: interface.**
- Quick Tune: Measurement / Turns selector on Both settings (Measurement by
  default), signed turns control (±0.5 taps, typed to two decimals, ±20
  confirmation), cumulative turns shown instead of a blank measurement, Record
  Measurement on the same row, reminder badges per setting, outdated labels in
  the photo dialog. Wall keyboard: the turns field gets the ± key
  (`data-allow-negative`); large touch targets as today.
- Record adjustment: read-only rows plus a Quick Tune link (decision 8).
- History / View / Compare: each turns adjustment, measurement records and
  corrections, per-Trail reminder status; disliked warnings and compare
  include cumulative turns and documented measurements.
- Reminder summaries: top of the Suspension page, snowmobile page (per
  setting) and Garage Board / wall display (counts), via `SuspensionSummary`.
- Docs: Decision 10, runbook B9 and the `photo-flag.ts` comment brought up to
  date (photo uploads no longer wait for cleanup deletion).
- Photo Needed is hidden only if `SUSPENSION_PHOTO_UPLOADS` is ever switched
  off again; Measurement Needed always shows.
- Tested end to end on Photo Test.

### PR 1 scope

Migration 12 (`supabase/migrations/2026112…_suspension_turns.sql`), additive:
- `suspension_settings.input_methods`: `measurement` | `turns` | `both`, not
  null, default `measurement` (every existing setting).
- `suspension_turn_adjustments`: one row per turns adjustment (Trail,
  setting, signed amount with two decimals, never 0), written only by the save
  function, never changed.
- `suspension_trail_settings`: one row per Trail per turns-tracked setting:
  cumulative turns, documented measurement, Measurement Needed, and whether
  that Trail requires a new photo. Created only for settings with turns
  history, so existing Trails need no backfill.
- `suspension_measurement_records`: each Record Measurement and correction
  (value, who, when), never changed; the latest one is the Trail's measurement.
- `sled_measurement_photos.outdated` (default false), set when a photo is
  carried forward for a setting that changed in that save, or was already
  outdated.
- `save_suspension_configuration` re-created with a turns parameter (setting
  → signed amount). It refuses a value and turns for the same setting, turns
  on a Measurement only setting, and 0. Turned settings: cumulative = base
  cumulative (or 0 after a documented measurement) + amount, value blank,
  Measurement Needed on (Both only), new photo required (Both only). Other
  turns-tracked settings copy forward; a photo requirement carries forward
  only while unmet on the base Trail.
- `record_suspension_measurement(trail, setting, value)`: active Trail only,
  Turns-capable settings with Measurement; adds a record, clears Measurement
  Needed; corrections allowed. Never creates a Trail or touches other Trails.
- Read function for the active Trail's reminders (per setting), for PR 2.
- Photo Needed is derived from active photos with no `carried_from_id`, so
  add, replace, remove and restore need no change.
- Changing input methods: a setting can't lose Turns while its active Trail
  shows turns instead of a measurement (record the measurement first).
  Turns only settings are never locked in: switch to Both, record the
  measurement, then switch to Measurement only; the turns history is kept.
- Found while testing: a Trail can inherit two outdated photos, filling both
  slots, and mechanics can add but not remove photos. A new photo therefore
  takes the place of an outdated inherited one when both slots are full
  (only that Trail's reference copy; the earlier Trail keeps its photo).
- Row Level Security as before (view by sled permission; writes only through
  the functions); no anonymous access; registered with the Migration 8
  cleanup like Migration 10. Rollback script and rollback test.
- Tests: pgTAP `017_suspension_turns`, rollback test in CI, generated types.

App:
- Settings editor: Measurement only / Turns only / Both when creating or
  editing a setting (at least one). Unit is pre-filled with "in" when blank
  for measurement-capable settings and hidden for Turns only.
- Until PR 2 ships, Turns only and Both are shown but disabled ("Available
  with Quick Tune Turns"), so no setting can be switched before the interface
  exists. PR 2 enables them.
- Existing Quick Tune, Record adjustment, History and photos behave exactly
  as today. Full CI (unit, pgTAP, rollback tests, e2e).

---

## 2. Maintenance Inspection & Replacement Tracking

Starts after Measurement / Turns. Goal: one maintenance item per component
(no more separate "Belt Check" and "Belt Replacement" tasks), accurately
tracking both component life and inspection intervals.

### Approved requirements

1. One maintenance item can support inspection only, replacement only, or
   both.
2. Inspection and replacement schedules are tracked independently.
3. Recording a check resets only the inspection interval. Recording a
   replacement resets both intervals.
4. Inspection results are **Good** or **Needs Replacement**.
5. Needs Replacement automatically flags the item on the maintenance board
   until a replacement is recorded.
6. One maintenance card shows both schedules and their statuses.
7. Multiple scheduling conditions per schedule; whichever comes first triggers
   the reminder. Options: mileage, time interval, preseason, postseason, every
   season, every mileage update, and every logged ride, where applicable.
   Replacement can also be "as needed".
8. **Quick Check** lists all outstanding inspections on a snowmobile, with an
   individual result for each and a **Mark All as Good** option.
9. Quick Check is offered automatically after a mileage update when
   inspections are due. Completing them stays optional.
10. Existing maintenance tasks can be edited to use the new tracking without
    losing history. No task-merging feature.
11. An inspection record has date, mileage, result and optional notes. Date
    and mileage are filled in automatically and can be edited. No inspection
    photos.
12. Existing replacement documentation keeps working as it does today.
13. Inspection and replacement history are each initialized independently
    from known history, a current tracking baseline, or unknown history.
    Unknown history prompts an initial inspection. Setting a baseline never
    records a replacement that didn't happen.
14. Plain **Checked** and **Replaced** wording; no customizable action names.
15. Checks and replacements can be recorded at any time, due or not.

Principles: keep it simple, preserve existing maintenance functionality, avoid
unnecessary complexity. A technical review of the existing maintenance tables
and board, and any open design decisions, come before implementation.
