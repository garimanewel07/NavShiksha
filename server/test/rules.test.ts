import { describe, expect, it } from 'vitest';
import { classify, evaluate, ruleSchema } from '../src/lib/rules.js';

describe('rule language', () => {
  it('evaluates nested conditions and explains why', () => {
    const r = evaluate({ all: [{ eq: ['service', 'NAVY'] }, { any: [{ eq: ['posted_in_station', true] }, { eq: ['status', 'DIED_IN_SERVICE'] }] }] },
      { service: 'NAVY', posted_in_station: true, status: 'SERVING' });
    expect(r.ok).toBe(true);
    expect(r.trace).toContain('service is navy');
  });

  it('rejects anything that is not a known operator', () => {
    expect(ruleSchema.safeParse({ eval: 'process.exit()' }).success).toBe(false);
    expect(ruleSchema.safeParse({ eq: ['a', { nested: true }] }).success).toBe(false);
    expect(ruleSchema.safeParse({ all: [] }).success).toBe(false);
  });

  it('picks the highest-priority match and needs a catch-all', () => {
    const rules = [
      { id: 'b', code: 'B', label: 'B', priority: 2, condition: { always: true as const } },
      { id: 'a', code: 'A', label: 'A', priority: 1, condition: { gte: ['n', 2] as [string, number] } },
    ];
    expect(classify(rules, { n: 3 }).code).toBe('A');
    expect(classify(rules, { n: 1 }).code).toBe('B');
    expect(() => classify([rules[1]], { n: 0 })).toThrow(/catch-all/);
  });
});
