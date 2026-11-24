# SledWerx development plan

Approved features that are planned but not built yet, in order. Each one is
designed and its open decisions settled before any implementation starts.

| Order | Feature | Status |
|---|---|---|
| 1 | [Suspension Measurement / Turns](#1-suspension-measurement--turns) | Design decisions in progress |
| 2 | [Maintenance Inspection & Replacement Tracking](#2-maintenance-inspection--replacement-tracking) | Requirements approved; design after feature 1 |

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

### Implementation outline

- **Migration 12** (approved; additive; the same SQL Editor process as Migrations 9–11:
  preflight, trial with ROLLBACK, apply, read-only verification):
  - `suspension_settings.input_methods` (existing settings: measurement only);
  - per-adjustment turns rows, written with the new Trail and never changed;
  - a per-Trail, per-setting row for cumulative turns, the documented
    measurement and both reminders, copied forward on save;
  - an `outdated` marker on carried-forward measurement photos;
  - `save_suspension_configuration` re-created with a turns parameter;
  - a separate "Record measurement" function (updates the same Trail);
  - the add and replace photo functions clear Photo Needed for that Trail.
- **Photo Needed** is always stored. It is hidden only if
  `SUSPENSION_PHOTO_UPLOADS` is switched off again (it can't be cleared then);
  Measurement Needed always shows.
- **Delivery (approved):** two PRs, (a) database and the input-method setting, then
  (b) Quick Tune, History/View/Compare, and the reminder summaries. Nothing
  changes for anyone until a setting is switched to Turns or Both, so it is
  tested end to end on Photo Test.
- Same PR: bring Decision 10, runbook B9 and `photo-flag.ts` up to date (photo
  uploads no longer wait for cleanup deletion).

### Design decisions

| # | Decision | Status |
|---|---|---|
| 1 | "Task" means an individual suspension setting (not a maintenance task). Measurement only / Turns only / Both is chosen when creating or editing a setting; existing settings default to Measurement only | **Decided** |
| 2 | No "Not needed" dismiss: Photo Needed is cleared only by uploading one new photo for that setting on that Trail (can be added later if needed) | **Decided** |
| 3 | Units stay customizable and existing units are preserved; inches is the default only when no unit is set (editable). Turns always display as turns, independent of the unit; Turns only settings show no measurement unit. No conversions or data changes | **Decided** |
| 4 | Each − / + tap is ±0.5 turns (no per-setting step option); typed amounts up to two decimals; signed adjustments and cumulative totals are displayed; 0 means no change and creates no adjustment; a single adjustment beyond ±20 turns asks for confirmation but is allowed; no limit on the cumulative total | **Decided** |
| 5 | A measurement entered while Measurement Needed is on counts as documentation | Open |
| 6 | Ordinary value changes mark photos outdated; removing the clearing photo | Open |
| 7 | Dashboard: snowmobile page only, or the Garage Board too | Open |
| 8 | Turns and documentation in Quick Tune only at first | Open |

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
