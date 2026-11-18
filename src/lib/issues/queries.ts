import "server-only";

import { PHOTO_URL_TTL } from "@/lib/sleds/constants";
import { createClient } from "@/lib/supabase/server";

import { ISSUE_PHOTO_BUCKET, sortIssues, type Issue, type IssuePriority, type IssueStatus } from "./types";

// Every query runs as the signed-in user, so Row Level Security decides which
// issues are visible (the sled's owner and the people it is shared with).

const COLUMNS =
  "id, sled_id, title, description, priority, status, reported_on, odometer_mi, resolved_on, resolution_notes, resolved_entry_id, created_by, version";

/**
 * Issues of some sleds (not in Recently Deleted), with photos as short-lived
 * signed links and the linked service record's title. Grouped by sled; open
 * issues most urgent first, resolved ones most recent first.
 */
export async function listIssues(sledIds: string[], status?: IssueStatus): Promise<Map<string, Issue[]>> {
  const bySled = new Map<string, Issue[]>(sledIds.map((id) => [id, []]));
  if (!sledIds.length) return bySled;
  const supabase = await createClient();
  let query = supabase.from("sled_issues").select(COLUMNS).in("sled_id", sledIds).is("deleted_at", null);
  if (status) query = query.eq("status", status);
  const { data: rows, error } = await query;
  if (error) throw new Error("Could not load issues.");
  if (!rows.length) return bySled;

  const issueIds = rows.map((r) => r.id);
  const entryIds = [...new Set(rows.flatMap((r) => (r.resolved_entry_id ? [r.resolved_entry_id] : [])))];
  const [photos, entries] = await Promise.all([
    supabase
      .from("sled_issue_photos")
      .select("id, issue_id, path, position, version, created_at")
      .in("issue_id", issueIds)
      .is("deleted_at", null)
      .order("position", { ascending: true })
      .order("created_at", { ascending: true }),
    entryIds.length
      ? supabase.from("maintenance_entries").select("id, title, performed_on, deleted_at").in("id", entryIds)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (photos.error || entries.error) throw new Error("Could not load issues.");

  const paths = (photos.data ?? []).map((p) => p.path);
  const urls = new Map<string, string>();
  if (paths.length) {
    const { data } = await supabase.storage.from(ISSUE_PHOTO_BUCKET).createSignedUrls(paths, PHOTO_URL_TTL);
    for (const item of data ?? []) if (item.path && item.signedUrl && !item.error) urls.set(item.path, item.signedUrl);
  }
  const entryById = new Map((entries.data ?? []).map((e) => [e.id, e]));

  for (const r of rows) {
    const entry = r.resolved_entry_id ? entryById.get(r.resolved_entry_id) : undefined;
    bySled.get(r.sled_id)?.push({
      id: r.id,
      sledId: r.sled_id,
      title: r.title,
      description: r.description,
      priority: r.priority as IssuePriority,
      status: r.status as IssueStatus,
      reportedOn: r.reported_on,
      odometer: r.odometer_mi == null ? null : Number(r.odometer_mi),
      resolvedOn: r.resolved_on,
      resolutionNotes: r.resolution_notes,
      // A deleted service record is hidden from some users; show the link as deleted.
      resolvedEntry: r.resolved_entry_id
        ? entry
          ? { id: entry.id, title: entry.title, performedOn: entry.performed_on, deleted: entry.deleted_at != null }
          : { id: r.resolved_entry_id, title: "Service record", performedOn: "", deleted: true }
        : null,
      createdBy: r.created_by,
      version: r.version,
      photos: (photos.data ?? [])
        .filter((p) => p.issue_id === r.id)
        .map((p) => ({ id: p.id, path: p.path, url: urls.get(p.path) ?? null, version: p.version })),
    });
  }
  for (const [id, list] of bySled) bySled.set(id, sortIssues(list));
  return bySled;
}

/** One sled's issues, open and resolved. */
export async function listSledIssues(sledId: string): Promise<Issue[]> {
  return (await listIssues([sledId])).get(sledId) ?? [];
}

/** Issues resolved by each service record of a sled (for the service history). */
export async function issuesResolvedByEntry(sledId: string): Promise<Map<string, { id: string; title: string }[]>> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("sled_issues")
    .select("id, title, resolved_entry_id")
    .eq("sled_id", sledId)
    .eq("status", "resolved")
    .not("resolved_entry_id", "is", null)
    .is("deleted_at", null);
  if (error) return new Map();
  const map = new Map<string, { id: string; title: string }[]>();
  for (const r of data ?? []) {
    const list = map.get(r.resolved_entry_id!) ?? [];
    list.push({ id: r.id, title: r.title });
    map.set(r.resolved_entry_id!, list);
  }
  return map;
}

export type ServiceOption = { id: string; title: string; performedOn: string };

/** Completed, non-deleted service records of a sled, newest first: what can resolve an issue. */
export async function resolvableServices(sledId: string): Promise<ServiceOption[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("maintenance_entries")
    .select("id, title, performed_on")
    .eq("sled_id", sledId)
    .eq("completed", true)
    .is("deleted_at", null)
    .order("performed_on", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(200);
  if (error) throw new Error("Could not load service records.");
  return (data ?? []).map((e) => ({ id: e.id, title: e.title, performedOn: e.performed_on }));
}
