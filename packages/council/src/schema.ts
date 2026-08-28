/**
 * The council's vote contract.
 *
 * Every family answers with ONE JSON object matching {@link CouncilVote}. Model
 * output is untrusted text, so `coerceVote` never throws: anything it cannot
 * read with confidence becomes an `ABSTAIN`, which the tally counts as
 * not-a-merge. A vote that cannot be parsed must never be able to merge code.
 */

export type Decision = 'MERGE' | 'BLOCK' | 'ABSTAIN';

/** The set of families that may sit on the council. */
export const FAMILIES = ['claude', 'gemini', 'xai'] as const;
export type Family = (typeof FAMILIES)[number];

export interface CouncilVote {
  family: Family;
  /** Model id that actually answered (for the audit trail). */
  model: string;
  decision: Decision;
  /** Self-reported 0..1. Advisory only — the tally never weights by it. */
  confidence: number;
  reasons: string[];
  risks: string[];
  /** Objections the voter considers merge-blocking. */
  blockingObjections: string[];
  /** Which round produced this vote: 1 = independent, 2 = after cross-examination. */
  round: 1 | 2;
  /** True when the family was unreachable / errored — a degraded panel. */
  unreachable?: boolean;
  /** Populated when `unreachable`, or when the response needed coercion. */
  error?: string;
  /** Raw model text, retained verbatim for the transcript. */
  raw?: string;
}

const DECISIONS: Decision[] = ['MERGE', 'BLOCK', 'ABSTAIN'];

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((v) => (typeof v === 'string' ? v : JSON.stringify(v))).filter(Boolean);
  }
  if (typeof value === 'string' && value.trim()) return [value.trim()];
  return [];
}

function asConfidence(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return 0;
  // Tolerate a 0-100 scale; clamp everything into 0..1.
  const scaled = n > 1 ? n / 100 : n;
  return Math.min(1, Math.max(0, scaled));
}

/**
 * Pull the first balanced JSON object out of model text.
 *
 * Models wrap JSON in prose or fences, and a naive `indexOf('{')`/`lastIndexOf('}')`
 * slice swallows trailing prose that happens to contain a brace. Scanning for the
 * first *balanced* object (string-aware, so braces inside quotes don't count) is
 * what makes this robust enough to gate a merge on.
 */
export function extractJsonObject(text: string): unknown {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidates = fenced ? [fenced[1], text] : [text];

  for (const candidate of candidates) {
    const start = candidate.indexOf('{');
    if (start === -1) continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < candidate.length; i++) {
      const ch = candidate[i];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        escaped = true;
        continue;
      }
      if (ch === '"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          try {
            return JSON.parse(candidate.slice(start, i + 1));
          } catch {
            break; // malformed — fall through to the next candidate
          }
        }
      }
    }
  }
  return null;
}

export interface CoerceOptions {
  family: Family;
  model: string;
  round: 1 | 2;
  raw: string;
}

/** Turn raw model text into a vote. Unreadable input becomes a safe ABSTAIN. */
export function coerceVote(opts: CoerceOptions): CouncilVote {
  const base: CouncilVote = {
    family: opts.family,
    model: opts.model,
    decision: 'ABSTAIN',
    confidence: 0,
    reasons: [],
    risks: [],
    blockingObjections: [],
    round: opts.round,
    raw: opts.raw,
  };

  const parsed = extractJsonObject(opts.raw);
  if (!parsed || typeof parsed !== 'object') {
    return { ...base, error: 'no JSON object in response — coerced to ABSTAIN' };
  }

  const obj = parsed as Record<string, unknown>;
  const rawDecision = String(obj.decision ?? obj.verdict ?? '')
    .trim()
    .toUpperCase();
  const decision = DECISIONS.includes(rawDecision as Decision) ? (rawDecision as Decision) : 'ABSTAIN';

  return {
    ...base,
    decision,
    confidence: asConfidence(obj.confidence),
    reasons: asStringArray(obj.reasons),
    risks: asStringArray(obj.risks),
    blockingObjections: asStringArray(obj.blockingObjections ?? obj.blocking_objections),
    error:
      decision === 'ABSTAIN' && rawDecision && rawDecision !== 'ABSTAIN'
        ? `unrecognised decision ${JSON.stringify(rawDecision)} — coerced to ABSTAIN`
        : undefined,
  };
}

/** A vote standing in for a family that could not be reached. Never a MERGE. */
export function unreachableVote(family: Family, model: string, round: 1 | 2, error: string): CouncilVote {
  return {
    family,
    model,
    decision: 'ABSTAIN',
    confidence: 0,
    reasons: [],
    risks: [],
    blockingObjections: [],
    round,
    unreachable: true,
    error,
  };
}
