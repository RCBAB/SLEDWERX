# Suspension Quick Tune (Phase 6.2)

Track how each snowmobile's suspension is set up, every adjustment made to
it, which skis and carbides it ran, and how it rode, so you build up a
history of what works on that sled. Data lives in Migration 7 (settings,
revisions, feedback, photos) and Migration 9 (numbered configurations,
equipment, ride evaluations); see [database.md](database.md).

> **Migration 9 is not applied to production yet.** Until it is, the
> Suspension page shows a "needs a database update" notice and the snowmobile
> page and Garage Board show "Suspension: Not available yet". Nothing else
> is affected. Applying it needs separate approval.

> **Release (Decision 10, amended again 2026-11-24):** measurement photo
> uploads are **on** in production (feature flag `SUSPENSION_PHOTO_UPLOADS=on`).
> They don't depend on the Migration 8 cleanup's deletion: with the cleanup in
> report-only mode, files of replaced or removed photos (and a mechanic's
> upload whose record couldn't be saved) simply stay in storage and are
> listed by the daily report. Reference and adjustment photo uploads stay off
> in the code. See [Photo uploads feature flag](#photo-uploads-feature-flag).

## Where to find it

| Where | What |
|---|---|
| `/garage/[sledId]/suspension` | **Quick Tune** (default) or the **Suspension Map**: everything below |
| Snowmobile page, **Suspension** section | Active Trail configuration, newest ride evaluation, **Active Ski Configuration** (change it here), View, Adjust, Ride evaluation, Open Quick Tune |
| Garage Board (Cards, Compact, Wall Display) | The same summary and quick actions on every sled (large controls on Wall Display) |
| My Snowmobiles | Unchanged (no suspension information) |

## The active configuration

The top of the page always shows the **active configuration** ("Trail 4 ·
Active"), when it was saved, the **Active Ski Configuration** (installed skis
and carbides, with **Change**) and the newest ride evaluation. Everything you
adjust starts from the active configuration.

## Quick Tune and the Suspension Map

- **Quick Tune** is the default view; the **Suspension Map** (the sled
  diagram with its zone panel) is the alternate view. The choice is
  remembered in this browser (a cookie); `?view=quick|map` opens either.
- Quick Tune lists every setting on one scrolling page in five sections:
  **Front Ski Shocks, Front Track Shock, Rear Track Shock, Springs & Limiter
  Strap, Rear General**. The seven stored zones map onto them (left and right
  ski shocks and "front general" all go to Front Ski Shocks); no data changes.
- **Left and right ski shocks combined:** a left and a right setting with the
  same name, type and unit show as one row ("Compression · Both ski shocks")
  and change together. **Left and right separately** splits the row; a row
  whose saved or edited values differ is always shown split.
- **Clicks, turns, holes, positions** get large **−** / **+** buttons (and can
  still be typed); **measurements** (in, mm, psi, ...) are typed. Text
  settings are typed.
- Every changed value shows the saved one and the difference ("Was 10 clicks
  · +2"). Change as many settings as you like, then **Save Adjustments**
  (optional notes) or **Discard Changes**. Numbers that can't be saved are
  flagged and block the save.
- **Unsaved changes are protected:** following a link, switching view or
  closing the tab asks first; changing skis or carbides waits until you save
  or discard.
- The **Suspension Map** keeps working as before: pick a zone, see its values,
  **Record adjustment** (saves the next configuration the same way).

## Numbered Trail configurations

- There are no setup categories (Trail / Powder / Racing) any more: each
  snowmobile has one numbered sequence, **Trail 1, Trail 2, Trail 3, ...**
- Each configuration is a complete snapshot of every suspension value **and**
  the skis and carbides it was saved with.
- **Saving adjustments** creates the next number from the active
  configuration (unchanged values copied) and makes it active. A configuration
  is never edited or overwritten.
- **No duplicates:** a save with nothing changed is refused; each save
  carries an idempotency key, so a retry after a lost connection returns the
  configuration already saved instead of a second one; a save made from a
  configuration that is no longer active (someone else saved or switched in
  the meantime) is refused with "Reload".
- **History** lists every configuration, newest first: number, Active badge,
  date and author, mileage/hours copied at the time, skis and carbides, what
  changed from the configuration it was made from ("Trail 2 → Trail 5:
  Compression: 10 → 12 clicks (+2), Skis: XPT → XCS"), the note and its ride
  evaluations.
- **View** shows a configuration in full. Viewing never activates it.
- **Make active** switches to an older configuration without creating a new
  one (see below). The next save then continues from it with the next number.

## Skis and carbides

- Ski models: **C&A Pro XPT**, **C&A Pro XCS**. Carbide lengths: **6"**,
  **7.5"**, **9"**.
- The **Active Ski Configuration** is one record per snowmobile, shown and
  changed on the snowmobile page, the Garage Board and Quick Tune; a change
  anywhere shows everywhere.
- Changing it asks for confirmation, then: the current configuration is kept;
  the next Trail configuration is created with every suspension value copied
  and the new skis and carbides; it becomes active.
- Older configurations keep the equipment they were saved with.
  Configurations saved before Quick Tune show "Not recorded".

## Making an older configuration active

Selecting, viewing and activating are separate steps. **Make active** opens a
summary of what differs from the active configuration, then:

- **Same (or unrecorded) skis and carbides:** Activate.
- **Different skis or carbides:** both are shown ("Trail 3 was set up with
  C&A Pro XPT · 6" carbides / Installed now: C&A Pro XCS · 7.5" carbides").
  SledWerx doesn't assume anything was changed on the sled: **Activate** stays
  disabled until you tick "I've installed ...", which also updates the Active
  Ski Configuration. **Cancel** changes nothing.

## Ride evaluations

- Any number per configuration (adding one never creates a configuration):
  overall rating **Liked / Neutral (needs more testing) / Disliked**; trail
  conditions, any of **Loose Snow, Hard Pack, Perfect Groomed, Sloppy, Fresh
  Snow**; ride date (today by default, editable, not in the future); the
  **day's high °F** (optional, whole degrees −60 to 120); **ride notes**
  (optional).
- Shown in the configuration's history card, in the comparison and (newest)
  at the top and on the snowmobile page and Garage Board. Switching
  configurations keeps every evaluation.
- Feedback saved before Quick Tune keeps its rating (Improved / Worse / No
  change) and is shown as it was; editing it asks for a new-style rating.

## Warnings about configurations that rode badly

When you **make a configuration active**, **change skis or carbides**, or
**edit values in Quick Tune**, SledWerx checks whether the result is a
configuration that was rated **Disliked** before (same values for every
setting, same skis, same carbides). If so it shows, without blocking:

> This suspension configuration was previously rated Disliked under Loose
> Snow conditions. Review your earlier feedback before trying it again.
> (Trail 2)

Conditions matter: the warning names the conditions it was disliked in and,
if the same configuration was also **Liked** in other conditions, says so. A
configuration without a Disliked rating never warns. Quick Tune also says
when your edits match an existing configuration.

## Comparing configurations

Pick any two configurations: numbers, Active / Inactive, skis and carbides,
every suspension difference with its change ("10 → 12 clicks (+2)"), the
equipment change, and each one's ride evaluations (rating, conditions,
temperature, notes). Settings that are the same are folded away. **Compare**
on a history card compares it with the active one.

## Settings list and the suggested template

- One settings list per snowmobile. A snowmobile without settings offers
  **Use suggested settings** (one general list: compression, rebound and
  preload on both ski shocks; front track shock compression and rebound; rear
  track shock compression, rebound and preload; limiter strap; torsion spring
  position; track tension; names and units only, never values) or **Start
  blank**. There are no riding-style templates.
- Owners and editors can rename settings, change units and type, add, reorder
  and remove settings at any time. Saved configurations keep their values
  (with the names and units of the time).
- **How it's adjusted (Migration 12):** Measurement only (every existing
  setting), Turns only, or Measurement and Turns, for number settings.
  Choosing a turns option fills in "in" as the unit when none is set (it can
  be changed); Turns only shows no unit (the stored one is kept). See
  [Measurement and Turns](#measurement-and-turns) and
  [development-plan.md](development-plan.md) for the full design.

## Measurement and Turns

- **Turns are adjustments,** not totals: in Quick Tune, a Turns only setting,
  or a Measurement and Turns setting switched to **Turns**, gets − / + (half
  a turn per tap) and a field for any amount with up to two decimals (+1,
  −0.5, 2.25). 0 is no change. More than 20 turns in one adjustment asks for
  a second tap (**Save Anyway**). Turns field on the wall keyboard: the ± key works.
- **Each Save Adjustments with turns is the next Trail.** The setting's
  measurement is blank on that Trail; Quick Tune shows the cumulative turns
  ("+2.5 turns · measurement blank"). Turns add up across Trails until the
  measurement is documented; then they start again from 0.
- **Record Measurement** (Measurement and Turns settings, Measurement
  selected, active Trail only): type the measured value in the row and tap
  **Record Measurement**. It updates the same Trail (no new Trail number),
  replaces the turns shown with the measurement and clears Measurement
  Needed. **Correct recorded measurement** saves a correction the same way;
  every record stays in History. To document an older Trail, make it active
  first; newer Trails are never changed. After that, changing the
  measurement is an ordinary adjustment (the next Trail).
- **Reminders** (Measurement and Turns settings only): turns raise
  **Measurement Needed** and **Photo Needed**. A measurement clears
  Measurement Needed; one new photo on that Trail clears Photo Needed (photos
  carried from an earlier Trail don't count). Removing the last new photo
  brings Photo Needed back; restoring or replacing it clears it. Each Trail
  keeps its own reminders; making a Trail active shows that Trail's. Shown
  beside the setting in Quick Tune, at the top of the Suspension page, on the
  snowmobile page (per setting) and on the Garage Board and wall display
  (counts; they open the Suspension page). Photo Needed is hidden while photo
  uploads are off.
- **Photos:** a photo carried forward for a setting whose value changed
  (turns or a new measurement) is labelled **Previous Trail photo ·
  outdated**. When both slots hold photos and one is an outdated previous-Trail
  photo, **Take new photo** puts the new one in its place (only that Trail's
  copy; the earlier Trail keeps its photo).
- **History, View and Compare** show turns as "+2.5 turns", each adjustment
  ("+1 turn (total +3 turns)"), documented measurements and corrections, and
  each Trail's reminders. Disliked warnings compare turns too.
- **Record adjustment** (Suspension Map, snowmobile page, Garage Board):
  Turns only settings, and Measurement and Turns settings showing turns, are
  read-only there, with **Use Quick Tune**.
- **Switching how a setting is adjusted:** Turns only → Measurement and Turns
  → Record Measurement → Measurement only works and keeps the history. A
  setting can't go back to Measurement only while its active Trail shows
  turns instead of a measurement.

## Measurement photos (Migration 10)

Optional photos that document a measurement **as it was on one snowmobile
and one Trail configuration** (not a reference library or instructions).

- **Up to 2 per measurement per configuration.** A small camera and count
  (0/2, 1/2, 2/2) sits beside each setting in Quick Tune (the active
  configuration) and in **View Trail N** (any configuration, so older ones
  can be documented later). A combined left/right row shows one per side
  ("L 1/2", "R 0/2").
- The dialog names the configuration ("Photos of Sag on **Trail 7**") and
  shows two slots: **Take photo** (phone camera) or **Choose photo**,
  **View** (enlarged, with "Open full size"), **Replace** and **Remove**.
  Images are checked and resized in the browser (JPEG, longest side 1600 px,
  location data removed; 25 MB input, 5 MB stored).
- **Never a new Trail configuration:** adding, replacing or removing photos
  doesn't change numbers, values, evaluations or which configuration is
  active, and never marks Quick Tune as unsaved.
- **Carry-forward:** a new configuration starts with the photos of the one it
  was made from (new rows pointing at the same files, so nothing is uploaded
  twice). After that each configuration's photos are independent: replacing
  a photo in Trail 7 leaves Trail 6's photo as it was, and adding one to
  Trail 6 later doesn't change Trail 7.
- **Files are never overwritten or deleted by the app.** Replace uploads a
  new file; Replace and Remove move that configuration's row to Recently
  Deleted (30 days; restoring photos from the app is deferred, as for other
  photos). The Migration 8 cleanup removes a file only when no row in any
  configuration, active or deleted, refers to it.
- **Who:** everyone on the sled views; owners, editors and mechanics add;
  owners and editors replace and remove. Others can't see the rows or the
  files (Row Level Security and the existing private-bucket policies).
- **Shared files stay usable (Migration 11):** a file another configuration
  still uses stays viewable, and can still be carried forward, even if the
  configuration it was first uploaded to is later purged.
- **Only measurement photos are added.** The older reference photos (per
  setting) and adjustment photos (per configuration) are no longer added
  from the app, whatever the flag says; existing ones stay viewable and
  removable.
- **Feature flag:** adding and replacing need `SUSPENSION_PHOTO_UPLOADS=on`,
  the same flag as every other suspension photo (see below; off in
  production). With it off, existing measurement photos are still shown and
  can be removed; empty measurements show no camera.

## Photos

> **Uploads are turned off in production for now** (see
> [Photo uploads feature flag](#photo-uploads-feature-flag)). This section
> describes the behaviour with `SUSPENSION_PHOTO_UPLOADS=on`.

- **Reference photos** per setting (e.g. where the clicker is) and
  **adjustment photos** per revision, **6 at most each**, in the private
  `suspension-photos` bucket (signed links that expire after an hour).
- Photos are resized in the browser (longest side 1600 px, JPEG), which
  removes location (GPS) data. Non-images are refused before upload.
- Adjustment photos can be added while recording an adjustment or later from
  the history; they stay with their revision.
- Removed photos go to Recently Deleted in the database (kept 30 days).
  **Restoring removed photos from the app is deferred to a future release**
  (product decision, Checkpoint 7); setups, settings and ride feedback can be
  restored today.

## Garage Board and Wall Display

- Cards, Compact and Wall Display show the active Trail configuration, its
  newest ride evaluation and the Active Ski Configuration, with **View**
  (everyone), **Adjust**, **Ride evaluation** and **Change** skis/carbides
  (owners, editors, mechanics). Settings management stays on the full page.
- On Wall Display the SledWerx keyboard adds a **±** key for suspension
  number values only (see [wall-display.md](wall-display.md)).

## Color and contrast

Primary buttons and other filled controls with white text use `--primary`
(`#d92b12`, 4.88:1 with white; WCAG AA), darkening to `--primary-hover`
(`#b8240f`, 6.37:1) on hover and press. The brand `--accent` (`#ff3b1f`) is
unchanged for text, borders, focus outlines and decoration, where it reads
better on the dark background (5.46:1). The diagram's selected marker keeps
the accent (large bold number, 3.56:1; 3:1 needed). The automated
accessibility tests check every axe rule, color contrast included. The
maintenance board's interval line ("Every 500 mi") uses the full muted gray
(5.95:1; it was 80% opacity, 4.25:1).

## Who can do what

| | Owner / editor | Mechanic | Viewer | No access |
|---|---|---|---|---|
| See configurations, values, equipment, evaluations, photos | ✅ | ✅ | ✅ | ❌ |
| Settings list (template, add, rename, units, reorder, remove); reference photos | ✅ | ❌ | ❌ | ❌ |
| Save adjustments, make a configuration active, change skis and carbides | ✅ | ✅ | ❌ | ❌ |
| Add ride evaluations and adjustment photos | ✅ | ✅ | ❌ | ❌ |
| Edit ride evaluations | any | own | ❌ | ❌ |
| Remove evaluations and photos | ✅ | ❌ | ❌ | ❌ |
| Recently Deleted (restore) | ✅ | ❌ | ❌ | ❌ |

The interface only hides what a role can't do; Row Level Security, the
Migration 7 triggers, the Migration 9 functions (which check the caller's
permission on the sled) and storage policies enforce it.

## Recently Deleted

Owners and editors see, for 30 days, deleted **settings** (with their
reference photos), **ride evaluations** removed on their own (restored
exactly as they were: author, ride date, rating, conditions, temperature,
notes, configuration), and any **setup** deleted before Quick Tune (restored
with its history). Nothing is permanently
deleted by the app; see Migration 8 below.

## Photo uploads feature flag

| `SUSPENSION_PHOTO_UPLOADS` | Behaviour |
|---|---|
| unset, or anything but `on` (default) | No way to add suspension photos: no "Add reference photos" link, no Photos button on revisions without photos, no photo picker when recording an adjustment (Suspension page, snowmobile page, Garage Board). The server actions also refuse to prepare or record a photo. Photos that already exist are still shown, and owners and editors can still remove them. |
| `on` (**production since 2026-11-24**) | Measurement photos (Migration 10). Reference and adjustment photo uploads stay off in the code. With the flag off, Photo Needed reminders are hidden (Measurement Needed still shows). |

- Server-only (read at request time in `src/lib/suspension/photo-flag.ts`,
  never sent to the browser as configuration); the interface follows it
  through the role capabilities (`suspensionCapabilities(role, { photoUploads })`
  in `src/lib/sleds/permissions.ts`), which default to off.
- **Turning uploads on:** set `SUSPENSION_PHOTO_UPLOADS=on` for Production in
  Vercel and redeploy. No code change.
- **Limit:** the flag hides the app's upload path. The storage policies are
  unchanged (by decision), so a signed-in owner, editor or mechanic could
  still upload a file to their sled's folder with the Storage API directly.
  Such a file is unreferenced, unlisted in the app, and is reported by the
  Migration 8 cleanup like any other orphan.
- **Turning uploads off again** at any time: unset the variable and redeploy;
  existing photos are unaffected.

## Release blocker for photo uploads: leftover photo files

- Photos are uploaded first, then recorded. The server checks the parent,
  the permission and the room left before any upload, and a failed record
  save is retried once. If it still fails, **owners and editors remove the
  file again; mechanics can't** (storage policy: only owners and editors
  delete files). Such a file stays in storage, unlisted.
- Existing storage permissions **must not be weakened** to fix this.
- **Migration 8** (built; [cleanup.md](cleanup.md)) removes unreferenced
  files safely (only app photo paths, no record of any state pointing at them,
  at least 24 hours old, re-checked under a lock before each removal), starts
  in **report-only** mode, and permanently deletes only after separate
  approval. Claimed and removed paths are closed to new uploads.
- Photo uploads no longer wait for the cleanup's deletion (Decision 10,
  amended again 2026-11-24). With deletion off, leftover files stay in
  storage; the daily report lists them.

## Known limitations

- **Photo recovery** from Recently Deleted is deferred to a future release.
- **Photo links** expire after an hour; a page left open longer shows
  "Photo unavailable" until reloaded (same as issue photos).
- **History size:** the page loads a sled's newest 500 configurations and
  shows ten at a time.
- **Remembered view** is per browser (a cookie), not per account.
- **Leaving with unsaved changes:** links, view switches and closing the tab
  ask first; the browser's Back button in the app doesn't.
- **Older data:** sleds with several setups from before Quick Tune keep them
  internally; their revisions are numbered into one Trail sequence in the
  order they were saved, and the active setup's latest revision is the active
  configuration.

## Tests

- Unit: `src/lib/suspension/*.test.ts`, `src/lib/keyboard/edit.test.ts`.
  `quick-tune.test.ts` covers sections and left/right pairing, + / − steps,
  differences, pending changes, equipment, warnings and the template.
- Database: `supabase/tests/database/010_suspension.test.sql` and
  `014_suspension_quick_tune.test.sql` (pgTAP); Migration 9 rollback:
  `scripts/test-migration-9-rollback.sh`.
- Browser: `e2e/suspension.spec.ts` (desktop and phone, real local Supabase
  stack in CI): first visit and template, Quick Tune batch saves, discard and
  left/right, skis and carbides from either screen with history snapshots,
  activating older configurations (matching and mismatched equipment,
  cancel), ride evaluations with conditions and temperature, Disliked
  warnings, comparison, unsaved-change protection, the Suspension Map, roles,
  snowmobile page, Garage Board and Wall Display, photos off, the leftover
  photo file case, accessibility (axe), no sideways scrolling, 44 px targets. Playwright
  starts two servers from the same build: the main one with photo uploads
  **off** (as in production; includes a test that no upload control is
  offered anywhere and that existing photos stay visible and removable) and
  one on the next port with `SUSPENSION_PHOTO_UPLOADS=on` for the photo tests
  (`test.describe("with photo uploads turned on")`).
