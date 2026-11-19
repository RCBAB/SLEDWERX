# Suspension Tuning (Phase 6.2)

Track how each snowmobile's suspension is set up, every adjustment made to
it, how it rode, and go back to any earlier setup. Data lives in Migration 7
(see "Suspension setup & tuning" in [database.md](database.md)); nothing here
needs another migration.

> **Release blocker (production):** a mechanic's photo file can stay in
> storage when its upload succeeds but saving its record fails. Removing
> such files depends on the approved, not yet built **Migration 8** cleanup.
> See [Release blocker: leftover photo files](#release-blocker-leftover-photo-files).

## Where to find it

| Where | What |
|---|---|
| `/garage/[sledId]/suspension` | **Suspension Tuning** page: everything below |
| Snowmobile page, **Suspension** section | Active setup, current revision, newest ride feedback; View setup, Adjust, Ride feedback, Open Suspension Tuning |
| Garage Board (Cards, Compact, Wall Display) | The same summary and quick actions on every sled (large controls on Wall Display) |
| My Snowmobiles | Unchanged (no suspension information) |

## Setups

- A snowmobile can have any number of named **setups** ("Trail", "Deep
  powder", …). Names are unique per sled.
- A new setup starts **blank** or as a **copy of any saved revision** of the
  sled (values are copied for settings that still exist).
- **At most one setup is active.** A new setup is made active only when you
  tick "Make this the active setup"; **Set active** switches it later.
- The **active setup can't be deleted** (the button is disabled with an
  explanation): make another setup active first. Nothing is activated for
  you.
- Deleting a setup moves it, with its whole history, feedback and adjustment
  photos, to **Recently Deleted**.

## Settings list (custom settings and units)

- One list per snowmobile, shared by all its setups; each setup keeps its own
  values, and any setting can be blank.
- **Every sled starts empty.** There are no templates, starter settings or
  factory values.
- A setting has a name, a **zone** (where it is on the sled), a type
  (**Number** or **Text**), an optional **unit** and notes. Units are free
  text; **Clicks, Turns, mm, in, PSI** are offered as suggestions only.
- Settings can be reordered within their zone and removed (they go to
  Recently Deleted; history keeps their names and values).

## Interactive suspension diagram

- An original SledWerx top-down "blueprint" drawing, nose up (the sled's
  left is on the left). Seven numbered zones:
  1. Left ski shock, 2. Right ski shock, 3. Front general,
  4. Front track shock, 5. Rear track shock, 6. Springs & limiter strap,
  7. Rear general.
- Markers are 44 px buttons; arrow keys, Home and End move between them;
  the selected part is highlighted on the drawing.
- The **All zones** list does the same job as plain text (screen readers,
  keyboards). The zone panel shows the selected setup's current values.

## Adjustments and revision history

- **Record adjustment** shows every setting with its current value; change
  only what you adjusted. Zones are collapsible: the zone picked on the map
  opens, others start collapsed, several can be open, and collapsed zones
  show "N changes" or "Needs fixing". Values are kept when a zone collapses.
- Each save creates the next **revision**. Unchanged values carry forward;
  a blank value clears a setting. Saving with no change is refused.
- Number settings accept numbers only (e.g. `12`, `-1.5`, `0.5`; `.5` is
  read as `0.5`). Invalid values are flagged as you type and refused by the
  server and the database.
- **Mileage and engine hours** are copied from the current readings and can
  be edited. They are stored on the revision only and **never create or
  change a reading**, and don't affect maintenance or Ready/Not Ready.
- **Duplicate saves** are prevented (one idempotency key per opened form);
  **concurrent edits** are detected: if someone saved first, the save is
  refused with "Reload it and try again".
- Revisions can't be edited. The **history** shows, newest first: what
  changed against the previous revision (e.g. "Rebound: 8 → 10 Clicks"), date
  and time, who saved it, mileage and hours, "Restored from rev N", the note,
  ride feedback and photos.

## Ride feedback

- Any number of entries per revision: **Improved / Worse / No change**, the
  ride date (not in the future) and an optional note.
- Mechanics edit their own; owners and editors edit and remove any.

## Comparisons and restore

- **Compare** any two revisions of the sled, also across setups. Settings that
  differ show both values; unchanged settings fold under "Same in both".
  Stacked on phones (no sideways scrolling).
- **Restore this revision** previews what will change, then saves a **new**
  revision with those values ("Restored revision N"). Nothing is overwritten
  or erased. Settings removed since are listed as not restored.

## Photos

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

- Cards, Compact and Wall Display show the active setup, revision and newest
  feedback, with **View setup** (everyone), **Adjust** and **Ride feedback**
  (owners, editors, mechanics). Setup and settings management stay on the
  full page.
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
| See setups, values, history, feedback, photos | ✅ | ✅ | ✅ | ❌ |
| Create, rename, activate, delete setups | ✅ | ❌ | ❌ | ❌ |
| Add, edit, reorder, remove settings; reference photos | ✅ | ❌ | ❌ | ❌ |
| Record adjustments, restore revisions | ✅ | ✅ | ❌ | ❌ |
| Add ride feedback and adjustment photos | ✅ | ✅ | ❌ | ❌ |
| Edit feedback | any | own | ❌ | ❌ |
| Remove feedback and photos | ✅ | ❌ | ❌ | ❌ |
| Recently Deleted (restore) | ✅ | ❌ | ❌ | ❌ |

The interface only hides what a role can't do; Row Level Security, the
Migration 7 triggers and storage policies enforce it.

## Recently Deleted

Owners and editors see, for 30 days, deleted **setups** (restored with their
whole history), **settings** (with their reference photos) and **ride
feedback** removed on its own (restored exactly as it was: author, ride date,
rating, note, revision). Feedback that was deleted together with its setup
comes back with the setup and isn't listed separately. Nothing is permanently
deleted by the app; see Migration 8 below.

## Release blocker: leftover photo files

- Photos are uploaded first, then recorded. The server checks the parent,
  the permission and the room left before any upload, and a failed record
  save is retried once. If it still fails, **owners and editors remove the
  file again; mechanics can't** (storage policy: only owners and editors
  delete files). Such a file stays in storage, unlisted.
- Existing storage permissions **must not be weakened** to fix this.
- **Migration 8** (approved, not built) must remove unreferenced files
  safely (only app photo paths, no record of any state pointing at them,
  older than 24 hours, re-checked before each removal), start in
  **report-only** mode, and permanently delete only after separate approval.
- The cleanup must be **implemented and verified before the photo feature is
  released to production.** Details: "Migration 8: planned cleanup" in
  [database.md](database.md).

## Known limitations

- **Photo recovery** from Recently Deleted is deferred to a future release.
- **Photo links** expire after an hour; a page left open longer shows
  "Photo unavailable" until reloaded (same as issue photos).
- **History size:** the page loads a sled's newest 500 revisions and shows
  ten at a time.

## Tests

- Unit: `src/lib/suspension/*.test.ts`, `src/lib/keyboard/edit.test.ts`.
- Database: `supabase/tests/database/010_suspension.test.sql` (pgTAP).
- Browser: `e2e/suspension.spec.ts` (desktop and phone, real local Supabase
  stack in CI): roles end to end, adjustments, history, feedback, compare,
  restore, photos and cleanup, sled page and Garage Board, keyboard,
  accessibility (axe), no sideways scrolling, 44 px targets.
