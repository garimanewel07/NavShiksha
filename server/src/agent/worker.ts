import { createHash, createHmac } from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import { betaZodTool } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod';

/**
 * The NavShiksha Assistant: an optional AI that works on fault and wrong-record tickets.
 *
 * NES switches it on or off (Settings → Help and support; off by default, and then the helpdesk
 * does everything by hand). It runs as its own process and reaches NavShiksha only through the
 * signed agent API (NS_AGENT_URL, NS_AGENT_KEY, NS_AGENT_SECRET): it never has a database
 * connection, and the API gives it redacted tickets and opaque record references, never a school's
 * records. It does not talk to users. It sorts tickets, leaves notes for the helpdesk, and proposes
 * fixes, which the school office (or the developer) approves before the system applies them.
 *
 *   NS_AGENT_URL=https://navshiksha.example/api/v1 NS_AGENT_KEY=nsk_… NS_AGENT_SECRET=… npm run agent -w server
 *
 * Claude credentials come from the environment (ANTHROPIC_API_KEY, or an `ant auth login` profile).
 */

let BASE = (process.env.NS_AGENT_URL ?? 'http://localhost:8787/api/v1').replace(/\/$/, '');
let KEY = process.env.NS_AGENT_KEY ?? '', SECRET = process.env.NS_AGENT_SECRET ?? '';
/** For tests: point the worker at a server and key. */
export function configure(o: { url: string; key: string; secret: string }) { BASE = o.url.replace(/\/$/, ''); KEY = o.key; SECRET = o.secret; }
const MODEL = 'claude-opus-5-5';

/** A signed call to the agent API: HMAC-SHA256 over timestamp, method, path and the body's hash. */
export class Off extends Error {}
export async function call(method: 'GET' | 'POST', path: string, body?: unknown) {
  const url = new URL(`${BASE}/agent/v1${path}`);
  const text = body === undefined ? '' : JSON.stringify(body);
  const ts = String(Date.now());
  const toSign = `${ts}\n${method}\n${url.pathname}${url.search}\n${createHash('sha256').update(text).digest('hex')}`;
  const res = await fetch(url, { method, body: method === 'GET' ? undefined : text, headers: {
    'content-type': 'application/json', 'x-ns-key': KEY, 'x-ns-timestamp': ts, 'x-ns-signature': createHmac('sha256', SECRET).update(toSign).digest('hex') } });
  const json = await res.json().catch(() => ({}));
  const err = (json as { error?: { code?: string; message?: string } }).error;
  if (res.status === 403 && err?.code === 'ai_off') throw new Off(err.message);
  if (!res.ok) throw new Error(err?.message ?? `Agent API answered ${res.status}`);
  return json;
}

/** Each tool returns JSON text; an error is returned as text so the model can adjust, never thrown. */
const safe = (fn: () => Promise<unknown>) => fn().then((r) => JSON.stringify(r)).catch((e: Error) => `Error: ${e.message}`);
const enc = encodeURIComponent;

const tools = [
  betaZodTool({ name: 'get_ticket', description: 'Read a ticket: redacted title and description, its notes and progress, attached record references (with the fields that can be corrected), and any fixes already proposed.',
    inputSchema: z.object({ number: z.string().describe('Ticket number, e.g. TKT-000123') }), run: ({ number }) => safe(() => call('GET', `/tickets/${enc(number)}`)) }),
  betaZodTool({ name: 'search_docs', description: 'Search the NavShiksha product documentation (how screens and rules are meant to work), to tell a fault from intended behaviour.',
    inputSchema: z.object({ query: z.string() }), run: ({ query }) => safe(() => call('GET', `/knowledge?q=${enc(query)}`)) }),
  betaZodTool({ name: 'get_catalog', description: 'The modules, the fields that can be corrected for each kind of record, and the repair actions available.',
    inputSchema: z.object({}), run: () => safe(() => call('GET', '/catalog')) }),
  betaZodTool({ name: 'add_note', description: 'A working note for the helpdesk and developer (never shown to the user): your diagnosis, what you checked, or what a person should look at.',
    inputSchema: z.object({ number: z.string(), note: z.string().min(2).max(3000) }), run: ({ number, note }) => safe(() => call('POST', `/tickets/${enc(number)}/notes`, { body: note })) }),
  betaZodTool({ name: 'triage_ticket', description: 'Set category, module and severity, write a one-paragraph summary, and send to the developer first when the request needs a code change, a new feature, or looks unnecessary or risky.',
    inputSchema: z.object({ number: z.string(), category: z.enum(['PROBLEM', 'DATA', 'REQUEST', 'QUESTION', 'ACCESS']).optional(), module: z.string().optional(),
      severity: z.enum(['LOW', 'NORMAL', 'HIGH', 'URGENT']).optional(), summary: z.string().max(1000), needs_developer: z.boolean(), reason: z.string().max(500).optional() }),
    run: ({ number, needs_developer, ...rest }) => safe(() => call('POST', `/tickets/${enc(number)}/triage`, { ...rest, needsDeveloper: needs_developer })) }),
  betaZodTool({ name: 'propose_data_correction', description: 'Propose correcting one field of a record attached to the ticket. Use new_value "USER_VALUE" when the user gave the correct value (you cannot see it). The school office approves; the system applies it.',
    inputSchema: z.object({ number: z.string(), ref: z.string().describe('The record reference from get_ticket, e.g. R1A2B3C4D5E6'), field: z.string(), new_value: z.string(), summary: z.string().min(5).max(300), details: z.string().max(2000).optional() }),
    run: ({ number, ref, field, new_value, summary, details }) => safe(() => call('POST', `/tickets/${enc(number)}/proposals`, { kind: 'DATA_CORRECTION', ref, field, newValue: new_value, summary, details })) }),
  betaZodTool({ name: 'propose_repair', description: 'Propose a repair from the catalogue (recalculate or resend; it changes no data). Some repairs need a record reference.',
    inputSchema: z.object({ number: z.string(), action: z.string(), ref: z.string().optional(), summary: z.string().min(5).max(300) }),
    run: ({ number, action, ref, summary }) => safe(() => call('POST', `/tickets/${enc(number)}/proposals`, { kind: 'REPAIR', action, ref, summary })) }),
  betaZodTool({ name: 'propose_setting_change', description: 'Propose changing a school setting (key and JSON value) from today. The principal or NES approves.',
    inputSchema: z.object({ number: z.string(), key: z.string(), value: z.string().describe('JSON value, e.g. 15 or "MONTHLY" or true'), summary: z.string().min(5).max(300) }),
    run: ({ number, key, value, summary }) => safe(() => call('POST', `/tickets/${enc(number)}/proposals`, { kind: 'SETTING', field: key, newValue: value, summary })) }),
  betaZodTool({ name: 'propose_code_change', description: 'Describe a code change for the developer (what is wrong, where, the fix, how to test it). The developer must accept it; nothing changes until it is released.',
    inputSchema: z.object({ number: z.string(), summary: z.string().min(5).max(300), details: z.string().max(20000), risk: z.enum(['LOW', 'MEDIUM', 'HIGH']) }),
    run: ({ number, summary, details, risk }) => safe(() => call('POST', `/tickets/${enc(number)}/proposals`, { kind: 'CODE_CHANGE', summary, details, risk })) }),
  betaZodTool({ name: 'resolve_ticket', description: 'Mark the ticket resolved with a one-line resolution the user will see, once the fault is fixed (never while a fix waits for approval).',
    inputSchema: z.object({ number: z.string(), resolution: z.string().min(5).max(1000) }), run: ({ number, resolution }) => safe(() => call('POST', `/tickets/${enc(number)}/resolve`, { resolution })) }),
];

const SYSTEM = `You are the NavShiksha Assistant. NavShiksha is the school system of the Navy Education Society (Navy Children Schools and Navy Kindergartens in India). You work on support tickets that report a fault (something not working, a wrong figure) or a wrong detail in a record. You fix faults; you do not chat with users or answer how-to questions, and nothing you write reaches the user except the one-line resolution.

What you can see: tickets are redacted. Names, phone numbers, emails and long numbers appear as [NAME], [PHONE], [EMAIL], [NUMBER], [RECORD NO]. Records attached to a ticket appear only as references (e.g. R1A2B3C4D5E6). You never see a school's records.

For each ticket, in one pass:
1. Read it (get_ticket). Use search_docs to check how the module is meant to work, so you can tell a fault from intended behaviour.
2. Triage it: category, module, severity (URGENT only when fees, payroll, exams or safety are blocked for many people today), and a short summary for the helpdesk.
3. Act:
   - A wrong detail in a record: propose_data_correction for a field in the catalogue. If the user gave the correct value, use "USER_VALUE". The school office checks the current and new values and approves.
   - A figure or list out of step (designations, chat groups, a payroll draft, failed messages, bank matching, a transport fee): propose_repair from the catalogue. Repairs change no data.
   - A fault in the software itself: add_note with your diagnosis, and propose_code_change for the developer (what is wrong, where, the fix, how to test it).
   - Anything that is not a fault (a request for something new, a question, something risky or affecting many schools): triage with needs_developer true, or leave a note for the helpdesk. Do not propose work on it.
4. Resolve only when the fault is fixed and nothing waits for approval. Leave everything else for the helpdesk; add_note says what you found.`;

const client = new Anthropic();

/** Works on one ticket until the agent stops calling tools. */
async function handle(number: string) {
  const final = await client.beta.messages.toolRunner({
    model: MODEL,
    max_tokens: 16000,
    thinking: { type: 'adaptive' },
    output_config: { effort: 'medium' },
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    cache_control: { type: 'ephemeral' },
    system: SYSTEM,
    tools,
    max_iterations: 12,
    messages: [{ role: 'user', content: `Handle ticket ${number}. Start by reading it.` }],
  });
  if (final.stop_reason === 'refusal') {
    await call('POST', `/tickets/${enc(number)}/notes`, { body: 'The assistant could not work on this ticket; the helpdesk should take it up.' }).catch(() => null);
    console.warn(`${number}: declined (${final.stop_details?.category ?? 'no category'})`);
  }
  return final.stop_reason;
}

/** One pass over the tickets waiting for an agent. */
export async function runOnce() {
  let waiting: { number: string }[];
  try { waiting = (await call('GET', '/tickets?waiting=1')) as { number: string }[]; }
  catch (e) { if (e instanceof Off) { console.log('Switched off by NES; the helpdesk is handling tickets.'); return 0; } throw e; }
  for (const t of waiting) {
    try { console.log(`${t.number}: ${await handle(t.number)}`); }
    catch (e) {
      if (e instanceof Anthropic.RateLimitError) { console.warn('Rate limited; will try again on the next pass.'); break; }
      if (e instanceof Anthropic.APIError) { console.error(`${t.number}: Claude API error ${e.status}: ${e.message}`); continue; }
      console.error(`${t.number}: ${(e as Error).message}`);
    }
  }
  return waiting.length;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (!KEY || !SECRET) { console.error('Set NS_AGENT_KEY and NS_AGENT_SECRET (from Support → Agents in NavShiksha).'); process.exit(1); }
  const every = Number(process.env.NS_AGENT_EVERY_SECONDS ?? 60) * 1000;
  console.log(`NavShiksha Assistant working on ${BASE} every ${every / 1000}s with ${MODEL}.`);
  for (;;) {
    await runOnce().catch((e) => console.error('Pass failed:', (e as Error).message));
    await new Promise((r) => setTimeout(r, every));
  }
}
