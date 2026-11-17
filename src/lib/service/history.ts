/** The snowmobile season a date belongs to: July-June, e.g. "2025–26". */
export function seasonOf(date: string): string {
  const [year, month] = date.split("-").map(Number);
  const start = month >= 7 ? year : year - 1;
  return `${start}–${String((start + 1) % 100).padStart(2, "0")}`;
}

/** Groups records (already newest first) by season, keeping their order. */
export function groupBySeason<T extends { performedOn: string; costs: { total: number } }>(records: T[]) {
  const groups: { season: string; records: T[]; total: number }[] = [];
  for (const record of records) {
    const season = seasonOf(record.performedOn);
    let group = groups.at(-1);
    if (!group || group.season !== season) {
      group = { season, records: [], total: 0 };
      groups.push(group);
    }
    group.records.push(record);
    group.total = Math.round((group.total + record.costs.total) * 100) / 100;
  }
  return groups;
}
