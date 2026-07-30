// `cato segments build` — turn filter flags into a reusable target-audience list.
//
// This is the campaign-building primitive: an agent describes an audience with
// the same flags as `people list`, and gets back a stable, replayable artefact
// (the filter expression + the resolved recipients + optional wave labels).
// It reads. It never enrols anyone into anything.

import type { TwentyRecord } from "@twenty-crm/core";
import { pick, toCsv } from "../output.ts";

export interface SegmentMember {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  jobTitle: string;
  companyId: string;
  branche: string;
  segment: string;
  wave?: number;
}

export interface Segment {
  name: string;
  builtAt: string;
  /** The exact Twenty filter used, so the selection can be reproduced or audited. */
  filter: string | null;
  /** Number of members actually resolved (may be capped by --limit). */
  count: number;
  waveSize: number | null;
  waves: number | null;
  members: SegmentMember[];
}

function str(record: TwentyRecord, path: string): string {
  const value = pick(record as Record<string, unknown>, path);
  if (value === null || value === undefined) return "";
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

export function toSegmentMember(record: TwentyRecord): SegmentMember {
  return {
    id: str(record, "id"),
    firstName: str(record, "name.firstName"),
    lastName: str(record, "name.lastName"),
    email: str(record, "emails.primaryEmail"),
    jobTitle: str(record, "jobTitle"),
    companyId: str(record, "companyId"),
    branche: str(record, "branche"),
    segment: str(record, "prudaiMarketingSourceSegment"),
  };
}

/**
 * Assign 1-based wave numbers. Waves are how a campaign gets sent in batches
 * instead of one blast; `waveSize <= 0` or undefined means "one single wave".
 */
export function assignWaves(members: SegmentMember[], waveSize: number | undefined): SegmentMember[] {
  if (!waveSize || waveSize <= 0) return members;
  return members.map((m, i) => ({ ...m, wave: Math.floor(i / waveSize) + 1 }));
}

export function buildSegment(
  name: string,
  filter: string | null,
  records: readonly TwentyRecord[],
  waveSize: number | undefined,
): Segment {
  const members = assignWaves(records.map(toSegmentMember), waveSize);
  const effectiveWaveSize = waveSize && waveSize > 0 ? waveSize : null;
  return {
    name,
    builtAt: new Date().toISOString(),
    filter,
    count: members.length,
    waveSize: effectiveWaveSize,
    waves: effectiveWaveSize ? Math.ceil(members.length / effectiveWaveSize) : null,
    members,
  };
}

export const SEGMENT_CSV_COLUMNS = [
  "id", "firstName", "lastName", "email", "jobTitle", "companyId", "branche", "segment", "wave",
] as const;

export function renderSegment(segment: Segment, format: "json" | "csv" | "table"): string {
  if (format === "json") return JSON.stringify(segment, null, 2);
  if (format === "csv") return toCsv(segment.members as unknown as Record<string, unknown>[], SEGMENT_CSV_COLUMNS);

  const lines = [
    `Segment : ${segment.name}`,
    `Built   : ${segment.builtAt}`,
    `Filter  : ${segment.filter ?? "(none)"}`,
    `Members : ${segment.count}`,
  ];
  if (segment.waveSize) lines.push(`Waves   : ${segment.waves} x ${segment.waveSize}`);
  lines.push("");
  lines.push(toCsv(segment.members as unknown as Record<string, unknown>[], SEGMENT_CSV_COLUMNS));
  return lines.join("\n");
}
