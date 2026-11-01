import { z } from 'zod';

/**
 * A small, safe rule language for anything NES wants to change without a code
 * release: admission categories, fee bands, concessions. Rules are JSON stored
 * in the database. There is no eval, no loops, no network: a rule can only
 * compare named facts with literal values.
 *
 *   { "all": [ { "eq": ["service", "NAVY"] }, { "eq": ["posted_in_station", true] } ] }
 */
export type Rule =
  | { all: Rule[] }
  | { any: Rule[] }
  | { not: Rule }
  | { eq: [string, Scalar] }
  | { ne: [string, Scalar] }
  | { in: [string, Scalar[]] }
  | { gte: [string, number] }
  | { lte: [string, number] }
  | { always: true };

type Scalar = string | number | boolean | null;
export type Facts = Record<string, Scalar>;

const scalar = z.union([z.string(), z.number(), z.boolean(), z.null()]);
export const ruleSchema: z.ZodType<Rule> = z.lazy(() =>
  z.union([
    z.object({ all: z.array(ruleSchema).min(1) }).strict(),
    z.object({ any: z.array(ruleSchema).min(1) }).strict(),
    z.object({ not: ruleSchema }).strict(),
    z.object({ eq: z.tuple([z.string(), scalar]) }).strict(),
    z.object({ ne: z.tuple([z.string(), scalar]) }).strict(),
    z.object({ in: z.tuple([z.string(), z.array(scalar).min(1)]) }).strict(),
    z.object({ gte: z.tuple([z.string(), z.number()]) }).strict(),
    z.object({ lte: z.tuple([z.string(), z.number()]) }).strict(),
    z.object({ always: z.literal(true) }).strict(),
  ]),
) as z.ZodType<Rule>;

export interface Evaluation {
  ok: boolean;
  /** Human-readable reasons, used to explain every computed result. */
  trace: string[];
}

const show = (v: unknown) => (typeof v === 'string' ? v.replaceAll('_', ' ').toLowerCase() : String(v));

export function evaluate(rule: Rule, facts: Facts): Evaluation {
  if ('always' in rule) return { ok: true, trace: ['applies to everyone else'] };
  if ('all' in rule) {
    const parts = rule.all.map((r) => evaluate(r, facts));
    return { ok: parts.every((p) => p.ok), trace: parts.flatMap((p) => p.trace) };
  }
  if ('any' in rule) {
    const parts = rule.any.map((r) => evaluate(r, facts));
    const hit = parts.find((p) => p.ok);
    return hit ? { ok: true, trace: hit.trace } : { ok: false, trace: parts.flatMap((p) => p.trace) };
  }
  if ('not' in rule) {
    const inner = evaluate(rule.not, facts);
    return { ok: !inner.ok, trace: inner.trace.map((t) => `not (${t})`) };
  }
  if ('eq' in rule) {
    const [k, v] = rule.eq;
    return { ok: facts[k] === v, trace: [`${show(k)} is ${show(v)}`] };
  }
  if ('ne' in rule) {
    const [k, v] = rule.ne;
    return { ok: facts[k] !== v, trace: [`${show(k)} is not ${show(v)}`] };
  }
  if ('in' in rule) {
    const [k, vs] = rule.in;
    return { ok: vs.includes(facts[k] ?? null), trace: [`${show(k)} is one of ${vs.map(show).join(', ')}`] };
  }
  if ('gte' in rule) {
    const [k, v] = rule.gte;
    const f = facts[k];
    return { ok: typeof f === 'number' && f >= v, trace: [`${show(k)} is at least ${v}`] };
  }
  const [k, v] = rule.lte;
  const f = facts[k];
  return { ok: typeof f === 'number' && f <= v, trace: [`${show(k)} is at most ${v}`] };
}

export interface RankedRule {
  id: string;
  code: string;
  label: string;
  priority: number;
  condition: Rule;
}

export interface Classification {
  code: string;
  label: string;
  priority: number;
  ruleId: string;
  because: string[];
}

/** First matching rule by priority wins. Schemes must end with an `always` rule. */
export function classify(rules: RankedRule[], facts: Facts): Classification {
  const ordered = [...rules].sort((a, b) => a.priority - b.priority);
  for (const r of ordered) {
    const e = evaluate(r.condition, facts);
    if (e.ok) return { code: r.code, label: r.label, priority: r.priority, ruleId: r.id, because: e.trace };
  }
  throw new Error('No category rule matched. Every scheme must end with a catch-all rule.');
}
