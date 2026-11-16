/**
 * The advertising record — Civil Code § 1812.533(c). Spec § 9.4.
 *
 * WHAT THIS SCREEN IS FOR. "Every nurses' registry shall maintain a record of all
 * advertisements, correlated to show the date and the publication in which the
 * advertisement appeared, retrospectively for a period of one year." It is a short
 * sentence that asks for something specific: not a list of things published, but a
 * record that can answer a question about a DAY — what was advertised on the third of
 * March, and where.
 *
 * `advertising_log` held nothing for the whole of this project's history, and the shape
 * it held nothing in could not have answered that. Core migration 0025 gave an entry an
 * interval, because the only publication this registry has is a website and a website
 * does not appear on a date; it runs until something replaces it. What this module adds
 * is the reading half: the record, what is running now, and the days the record cannot
 * account for.
 *
 * THE ONE THING THIS SCREEN MUST NOT DO is call an uncovered day a violation. The record
 * knows about advertisements somebody entered. A day with nothing against it means the
 * record says nothing ran — which is either true, because nothing did, or a gap, and
 * only the operator knows which. Every other compliance screen in this console offers
 * the remedy next to the problem. This one cannot, because there is no remedy: you
 * cannot retrospectively advertise, and an entry written from memory six months later is
 * the false record § 1812.533(b)(1) is about. So the screen states the position and
 * stops, which is the honest shape for a problem whose only fix was available in the
 * past.
 *
 * Reads are audited as `advertisement`. The record holds nothing about a household or a
 * provider — it is what this business said about itself in public — but who checked the
 * advertising record, and when, is a fact worth having when somebody later asks whether
 * an advertisement was known about.
 */
import { getDb } from '@h-hallows/core/db';
import {
  AD_MEDIA, ADVERTISING_LOG_CLOSE, ADVERTISING_LOG_CORRECTION, ADVERTISING_LOG_INSERT,
  ADVERTISING_WINDOW_DAYS, advertisingCoverage, contactLineProblem, isAdMedium,
  isContinuous, type AdMedium, type AdvertisingCoverage,
} from '@h-hallows/core/domain';
import { audit, auditRead, type AuditContext } from '@/lib/audit';

export class AdvertisingError extends Error {}

/** One entry, with the parts the screen says in words rather than in columns. */
export interface AdEntry {
  id: string;
  medium: AdMedium;
  mediumLabel: string;
  continuous: boolean;
  publication: string;
  appearedFrom: string;
  appearedTo: string | null;
  reference: string | null;
  carriedName: string;
  carriedContact: string;
  recordedBy: string;
  recordedAt: string;
  correctsId: string | null;
  correctionNote: string | null;
  /** True where a later entry corrects this one. The original stays, struck through. */
  superseded: boolean;
  /** Days it has appeared for, to its end or to today. Both ends counted. */
  days: number;
}

export interface AdvertisingState {
  entries: AdEntry[];
  /** Still appearing. The ones a withdrawal can be recorded against. */
  open: AdEntry[];
  coverage: AdvertisingCoverage;
  /** California's date, which is the only date this record is read against. */
  today: string;
  /** Distinct publications ever recorded. */
  publications: number;
}

interface Row {
  id: string; medium: string; publication: string; appeared_from: string;
  appeared_to: string | null; reference: string | null; carried_name: string;
  carried_contact: string; recorded_by: string; recorded_at: string;
  corrects_id: string | null; correction_note: string | null;
  superseded: boolean; days: number;
}

/*
 * `days` is computed in SQL rather than from the two dates in TypeScript, because the
 * open case needs today's date in California and the rest of this file already gets its
 * today from the database. Two sources for one day is how the other measure screen came
 * to disagree with itself.
 */
const ENTRY_SELECT = `
  SELECT a.id, a.medium::text, a.publication,
         a.appeared_from::text, a.appeared_to::text,
         a.reference, a.carried_name, a.carried_contact,
         a.recorded_by, a.created_at::text AS recorded_at,
         a.corrects_id, a.correction_note,
         EXISTS (SELECT 1 FROM advertising_log f WHERE f.corrects_id = a.id) AS superseded,
         (COALESCE(a.appeared_to, (now() AT TIME ZONE 'America/Los_Angeles')::date)
            - a.appeared_from + 1)::int AS days
    FROM advertising_log a`;

function toEntry(r: Row): AdEntry {
  const medium = isAdMedium(r.medium) ? r.medium : 'website';
  return {
    id: r.id,
    medium,
    mediumLabel: AD_MEDIA[medium].label,
    continuous: isContinuous(medium),
    publication: r.publication,
    appearedFrom: r.appeared_from,
    appearedTo: r.appeared_to,
    reference: r.reference,
    carriedName: r.carried_name,
    carriedContact: r.carried_contact,
    recordedBy: r.recorded_by,
    recordedAt: r.recorded_at,
    correctsId: r.corrects_id,
    correctionNote: r.correction_note,
    superseded: r.superseded,
    days: Number(r.days),
  };
}

async function californiaToday(): Promise<string> {
  const db = await getDb();
  const [row] = await db.query<{ d: string }>(
    `SELECT (now() AT TIME ZONE 'America/Los_Angeles')::date::text AS d`);
  return row!.d;
}

/**
 * The whole record, newest advertisement first, with corrections under the entry they
 * correct rather than at the top as though they were new advertisements.
 *
 * No LIMIT, deliberately, and this is the one register where that is defensible for
 * longer than most: an advertisement is a thing the business did on purpose, a handful a
 * year rather than a row per transaction. If that ever stops being true the trailing
 * year is the natural page, and the window is already computed.
 */
export async function record(ctx: AuditContext): Promise<AdvertisingState> {
  const db = await getDb();
  const rows = await db.query<Row>(
    `${ENTRY_SELECT} ORDER BY a.appeared_from DESC, a.corrects_id NULLS FIRST, a.created_at`);
  const entries = rows.map(toEntry);
  const today = await californiaToday();

  /*
   * Coverage is computed from ORIGINALS only. A correction restates an entry; counting
   * both would have the corrected days covered twice, and — worse — an entry whose dates
   * were corrected because they were wrong would go on covering the days it never ran.
   */
  const originals = entries.filter((e) => e.correctsId === null && !e.superseded);
  const corrected = entries.filter((e) => e.correctsId !== null);
  const coverage = advertisingCoverage(
    [...originals, ...corrected].map((e) => ({ from: e.appearedFrom, to: e.appearedTo })),
    today,
  );

  await auditRead(ctx, 'advertisement', null, {
    read: 'the advertising record',
    section: 'Civil Code § 1812.533(c)',
    entries: entries.length,
    uncoveredDays: coverage.uncoveredDays,
  });

  return {
    entries,
    open: entries.filter((e) => e.appearedTo === null && !e.superseded),
    coverage,
    today,
    publications: new Set(entries.map((e) => `${e.medium}:${e.publication}`)).size,
  };
}

export interface NewAdvertisement {
  medium: string;
  publication: string;
  appearedFrom: string;
  /** Null for a continuous medium still running. Forced equal to the start for a dated one. */
  appearedTo: string | null;
  reference: string | null;
  carriedName: string;
  carriedContact: string;
}

/**
 * Record an advertisement.
 *
 * The § 1812.533(b)(2) check runs here, before the insert, so the operator is told which
 * half of the contact line is wrong rather than being handed a constraint name. The
 * database check stays regardless — this one explains, that one holds.
 */
export async function recordAdvertisement(
  ctx: AuditContext, input: NewAdvertisement,
): Promise<string> {
  const db = await getDb();

  if (!isAdMedium(input.medium)) {
    throw new AdvertisingError(
      `“${input.medium}” is not one of the media this record keeps. Adding one is a `
      + 'decision rather than a free-text field, so that a directory listing and a '
      + 'directory listing are the same thing a year from now.');
  }
  const publication = input.publication.trim();
  if (publication === '') {
    throw new AdvertisingError(
      'Civil Code § 1812.533(c) asks for the publication the advertisement appeared in, '
      + 'so an entry without one records half of what the section asks for.');
  }
  const problem = contactLineProblem(input.carriedName, input.carriedContact);
  if (problem) throw new AdvertisingError(problem);

  // A dated medium closes on the day it ran. Enforced in the database too; done here so
  // the form need not ask for an end date it already knows.
  const appearedTo = isContinuous(input.medium)
    ? (input.appearedTo === '' ? null : input.appearedTo)
    : input.appearedFrom;

  const id = await db.transaction(async (tx) => {
    const [row] = await tx.query<{ id: string }>(ADVERTISING_LOG_INSERT, [
      input.medium, publication, input.appearedFrom, appearedTo,
      input.reference?.trim() || null, null,
      input.carriedName.trim(), input.carriedContact.trim(), null, ctx.actor,
      // null: the entry is made now. Only the seed fabricates a history.
      null,
    ]);
    await audit({
      ...ctx, action: 'create', entity: 'advertisement', entityId: row!.id,
      diff: {
        medium: input.medium, publication, appearedFrom: input.appearedFrom, appearedTo,
        carriedName: input.carriedName.trim(), carriedContact: input.carriedContact.trim(),
        section: 'Civil Code § 1812.533(c)',
      },
    }, tx);
    return row!.id;
  });
  return id;
}

/**
 * An advertisement stops appearing.
 *
 * The only mutation this table permits, and the `WHERE appeared_to IS NULL` in the
 * statement means a second attempt matches nothing rather than quietly overwriting the
 * day it actually came down. That distinction is the reason this returns rather than
 * being fire-and-forget: "already closed" is a different answer from "closed".
 */
export async function withdrawAdvertisement(
  ctx: AuditContext, id: string, on: string,
): Promise<void> {
  const db = await getDb();
  await db.transaction(async (tx) => {
    const closed = await tx.query<{ id: string; appeared_from: string }>(
      ADVERTISING_LOG_CLOSE, [id, on]);
    if (closed.length === 0) {
      throw new AdvertisingError(
        'That entry is already closed, or it is not in the record. The day an '
        + 'advertisement came down is recorded once; changing it afterwards would be '
        + 'editing the register rather than adding to it.');
    }
    if (on < closed[0]!.appeared_from) {
      // Also refused by the database. Named here because the operator typed the date.
      throw new AdvertisingError(
        'An advertisement cannot stop appearing before it started.');
    }
    await audit({
      ...ctx, action: 'update', entity: 'advertisement', entityId: id,
      diff: { withdrewOn: on, section: 'Civil Code § 1812.533(c)' },
    }, tx);
  });
}

export interface Correction {
  entryId: string;
  appearedFrom: string;
  appearedTo: string | null;
  reference: string | null;
  carriedName: string;
  carriedContact: string;
  note: string;
}

/**
 * A correction: a new entry saying what the old one should have said, pointing at it.
 *
 * The medium and the publication are copied from the entry being corrected, in SQL, and
 * are not arguments here. A correction that could move an advertisement to a different
 * publication would not be a correction — it would be a different advertisement, and it
 * belongs in the record as one.
 */
export async function correctEntry(ctx: AuditContext, input: Correction): Promise<string> {
  const db = await getDb();
  const note = input.note.trim();
  if (note === '') {
    throw new AdvertisingError(
      'A correction says what was wrong with the entry it replaces. Without that, the '
      + 'record holds two accounts of one advertisement and nothing to tell them apart.');
  }
  const problem = contactLineProblem(input.carriedName, input.carriedContact);
  if (problem) throw new AdvertisingError(problem);

  const [original] = await db.query<{ medium: string }>(
    `SELECT medium::text FROM advertising_log WHERE id = $1`, [input.entryId]);
  if (!original) throw new AdvertisingError('That entry is not in the record.');

  const appearedTo = isAdMedium(original.medium) && isContinuous(original.medium)
    ? (input.appearedTo === '' ? null : input.appearedTo)
    : input.appearedFrom;

  return db.transaction(async (tx) => {
    const [row] = await tx.query<{ id: string }>(ADVERTISING_LOG_CORRECTION, [
      input.entryId, input.appearedFrom, appearedTo, input.reference?.trim() || null, null,
      input.carriedName.trim(), input.carriedContact.trim(), ctx.actor, note,
    ]);
    await audit({
      ...ctx, action: 'create', entity: 'advertisement', entityId: row!.id,
      diff: {
        corrects: input.entryId, appearedFrom: input.appearedFrom, appearedTo, note,
        section: 'Civil Code § 1812.533(c)',
      },
    }, tx);
    return row!.id;
  });
}

export { AD_MEDIA, ADVERTISING_WINDOW_DAYS };
