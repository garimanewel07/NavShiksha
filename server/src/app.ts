import { timingSafeEqual } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { Db } from './db/client.js';
import { AppError, fromDbError, invalid } from './lib/errors.js';
import { actorFromToken, assertUnitInScope, devLogin, listDemoUsers, requireRole, type Actor } from './modules/auth.js';
import * as org from './modules/org.js';
import * as categories from './modules/categories.js';
import * as admissions from './modules/admissions.js';
import * as students from './modules/students.js';
import * as fees from './modules/fees.js';
import * as access from './modules/access.js';
import * as classTeachers from './modules/classTeachers.js';
import * as charges from './modules/charges.js';
import * as refunds from './modules/refunds.js';
import * as printing from './modules/printing.js';
import * as library from './modules/library.js';
import * as cards from './modules/cards.js';
import * as certificates from './modules/certificates.js';
import * as transfers from './modules/transfers.js';
import * as chat from './modules/chat.js';
import { nesEmblem } from './lib/brand.js';
import * as sections from './modules/sections.js';
import * as payments from './modules/payments.js';
import * as messaging from './modules/messaging.js';
import * as attendance from './modules/attendance.js';
import * as dashboard from './modules/dashboard.js';
import { trialBalance } from './modules/ledger.js';
import * as notify from './modules/notify.js';
import * as homework from './modules/homework.js';
import * as notices from './modules/notices.js';
import * as leave from './modules/leave.js';
import * as timetable from './modules/timetable.js';
import * as cover from './modules/cover.js';
import * as generator from './modules/generator.js';
import * as settings from './modules/settings.js';
import * as duties from './modules/duties.js';
import * as approvals from './modules/approvals.js';
import * as attachments from './modules/attachments.js';
import * as dataio from './modules/dataio.js';
import * as studentApp from './modules/studentApp.js';
import * as site from './modules/site.js';
import * as academics from './modules/academics.js';
import * as awards from './modules/awards.js';
import * as reportCards from './modules/reportCards.js';
import * as hpc from './modules/hpc.js';
import * as system from './modules/system.js';
import * as pi from './modules/pi.js';
import * as analytics from './modules/analytics.js';
import * as staff from './modules/staff.js';
import * as staffLeave from './modules/staffLeave.js';
import * as payroll from './modules/payroll.js';
import * as accounts from './modules/accounts.js';
import * as transport from './modules/transport.js';
import * as support from './modules/support.js';
import * as recruitment from './modules/recruitment.js';
import * as cwt from './modules/cwt.js';
import * as health from './modules/health.js';
import * as gate from './modules/gate.js';
import * as stores from './modules/stores.js';
import * as governance from './modules/governance.js';
import * as inspections from './modules/inspections.js';
import * as insights from './modules/insights.js';
import * as alumni from './modules/alumni.js';
import * as exams from './modules/exams.js';
import * as promotion from './modules/promotion.js';
import * as messagesMod from './modules/messages.js';
import { localToday, daysFromToday, currentYear } from './lib/dates.js';

type Env = { Variables: { actor: Actor } };

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.');
const today = () => localToday();
const plusDays = (n: number) => daysFromToday(n);
const uuid = z.string().uuid();
const service = z.object({
  service: z.enum(['NAVY', 'ARMY', 'AIR_FORCE', 'COAST_GUARD', 'DEF_CIV_NAVY', 'DEF_CIV_ARMY_AF', 'NES_STAFF', 'CIVILIAN']),
  status: z.enum(['SERVING', 'DEPUTATION_NAVY', 'ESM_PENSION', 'ESM_NO_PENSION', 'RETIRED', 'DIED_IN_SERVICE', 'NONE']),
  rankCode: z.string().nullable().optional(),
  civilOfficer: z.boolean().optional(),
  postedInStation: z.boolean().optional(),
});

async function body<T extends z.ZodTypeAny>(c: Context, schema: T): Promise<z.infer<T>> {
  const raw = await c.req.json().catch(() => ({}));
  const r = schema.safeParse(raw);
  if (!r.success) throw new AppError(422, 'invalid', 'Some fields need attention.', r.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })));
  return r.data;
}

/**
 * The HTTP API, version 1. Routes only validate input and call a module; all rules live in
 * the modules and the database. New behaviour gets new fields or routes; existing ones keep
 * their meaning (breaking changes go to /api/v2).
 */
export function buildApp(db: Db) {
  const app = new Hono<Env>().basePath('/api/v1');

  // Every error has a code (what happened) and a number (NS- and the HTTP status) shown to the user;
  // an unexpected one also has a reference, kept in the error log for the helpdesk.
  app.onError(async (err, c) => {
    if (err instanceof z.ZodError) return c.json({ error: { code: 'invalid', number: 'NS-422', message: 'Something in the request is not valid.', details: err.issues.slice(0, 10).map((i) => ({ field: i.path.join('.'), message: i.message })) } }, 422);
    if (err instanceof SyntaxError && /JSON/.test(err.message)) return c.json({ error: { code: 'bad_request', number: 'NS-400', message: 'The request could not be read.' } }, 400);
    const e = err instanceof AppError ? err : fromDbError(err);
    if (e) {
      if (e.status === 503 || e.status === 423) c.header('retry-after', '60');
      return c.json({ error: { code: e.code, number: `NS-${e.status}`, message: e.message, details: e.details } }, e.status as 400);
    }
    console.error(err);
    let userId: string | null = null; try { userId = c.get('actor')?.id ?? null; } catch { /* not signed in */ }
    const ref = await system.logError(db, { method: c.req.method, path: c.req.path, status: 500, message: (err as Error).message ?? String(err), stack: (err as Error).stack, userId });
    return c.json({ error: { code: 'server_error', number: 'NS-500', ref, message: `Something went wrong on our side and nothing was saved. If it happens again, raise a ticket quoting ${ref}.` } }, 500);
  });
  app.notFound((c) => c.json({ error: { code: 'not_found', number: 'NS-404', message: 'There is nothing at this address.' } }, 404));

  // The emergency controls (kill switches) are checked first, on every request.
  app.use('*', async (c, next) => {
    await system.gate(db, c.req.method, c.req.path.replace(/^\/api\/v1/, ''), c.req.header('authorization')?.replace(/^Bearer\s+/i, ''));
    await next();
  });
  app.get('/system/status', async (c) => c.json(await system.status(db)));
  // A screen that crashed in the browser reports itself here (before sign-in too), so the reference the user sees is in the error log.
  app.post('/system/client-errors', async (c) => c.json(await system.logClientError(db, await body(c, z.object({
    ref: z.string().regex(/^C-[A-Z0-9]{4,12}-[A-Z0-9]{1,6}$/), message: z.string().max(1000), stack: z.string().max(4000).optional(), path: z.string().max(400) })))));

  app.get('/health', (c) => c.json({ ok: true }));
  // Demo sign-in picks a user without a password. It exists for R1 testing only and is refused in production.
  const demoLogin = process.env.NODE_ENV !== 'production' && process.env.NES_DEMO_LOGIN !== 'off';
  // On a test server open to the internet, demo sign-in needs the testers' passcode (NES_TEST_PASSCODE).
  const passcode = process.env.NES_TEST_PASSCODE ?? '';
  app.use('/auth/*', async (c, next) => {
    if (!demoLogin) throw new AppError(404, 'not_found', 'Demo sign-in is switched off on this server.');
    if (passcode) {
      const given = Buffer.from(c.req.header('x-test-passcode') ?? ''), want = Buffer.from(passcode);
      if (given.length !== want.length || !timingSafeEqual(given, want)) {
        await new Promise((r) => setTimeout(r, 400));
        throw new AppError(401, 'passcode_required', 'Enter the testers’ passcode to try the system.');
      }
    }
    await next();
  });
  app.get('/auth/demo-users', async (c) => c.json(await listDemoUsers(db)));
  app.post('/auth/login', async (c) => {
    const { userId } = await body(c, z.object({ userId: uuid }));
    const s = await devLogin(db, userId);
    return c.json({ token: s.token, user: s.actor });
  });
  // ── Public school websites (no sign-in) ──
  app.get('/public/sites/:slug', async (c) => {
    const n = (k: string) => (c.req.query(k) === undefined ? undefined : Number(c.req.query(k)));
    return c.json(await site.publicSite(db, c.req.param('slug'), { notices: n('notices'), events: n('events'), toppers: n('toppers') }));
  });
  app.get('/public/sites/:slug/logo', async (c) => { const l = await printing.publicLogo(db, c.req.param('slug')); return c.body(new Uint8Array(l.data), 200, { 'content-type': l.type, 'cache-control': 'public, max-age=3600' }); });
  app.get('/public/brand/nes-logo', (c) => { const l = nesEmblem(); return c.body(new Uint8Array(l.data), 200, { 'content-type': l.type, 'cache-control': 'public, max-age=86400' }); });
  app.get('/public/assets/:id', async (c) => {
    const a = await site.asset(db, c.req.param('id'));
    // PDFs open in the browser's own viewer (which a strict content policy would block); photos keep it.
    const pdf = a.content_type === 'application/pdf';
    return c.body(Buffer.from(a.bytes), 200, {
      'content-type': a.content_type, 'cache-control': 'public, max-age=86400', 'x-content-type-options': 'nosniff',
      ...(pdf ? { 'content-disposition': `inline; filename="${(a.name ?? 'document').replace(/[^\w.\- ]+/g, '').replace(/\.pdf$/i, '') || 'document'}.pdf"` } : { 'content-security-policy': "default-src 'none'" }),
    });
  });
  const enquiryHits = new Map<string, number[]>();
  // A tracker fitted in a school vehicle (no sign-in: it identifies itself with its secret token).
  app.post('/public/tracker/position', async (c) => c.json(await transport.devicePosition(db, c.req.header('x-tracker-token'),
    await body(c, z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) })))));
  app.post('/public/sites/:slug/enquiries', async (c) => {
    // At most 5 enquiries per visitor address in 10 minutes.
    const ip = c.req.header('x-forwarded-for')?.split(',')[0].trim() || 'local';
    const now = Date.now();
    const hits = (enquiryHits.get(ip) ?? []).filter((t) => now - t < 600_000);
    if (hits.length >= 5) throw new AppError(429, 'slow_down', 'Too many enquiries. Please try again in a few minutes.');
    enquiryHits.set(ip, [...hits, now]);
    const b = await body(c, z.object({
      name: z.string().trim().min(2).max(80), phone: z.string().trim().regex(/^\+?[0-9 ]{10,15}$/, 'Enter a valid mobile number.'),
      topic: z.enum(['Admissions', 'Fees', 'Transfer certificate', 'Careers', 'Other']), message: z.string().trim().min(5).max(2000),
    }));
    return c.json(await site.enquire(db, c.req.param('slug'), b), 201);
  });

  // Anyone can check a certificate from the code printed on it.
  app.get('/public/verify/:code', async (c) => c.json(await certificates.verify(db, c.req.param('code'))));

  // ── Careers (no sign-in): open vacancies at every Navy school, and candidate registration ──
  const otpHits = new Map<string, number[]>();
  const otpLimit = (c: Context) => {
    const ip = c.req.header('x-forwarded-for')?.split(',')[0].trim() || 'local';
    const now = Date.now();
    const hits = (otpHits.get(ip) ?? []).filter((t) => now - t < 600_000);
    if (hits.length >= 20) throw new AppError(429, 'slow_down', 'Too many codes asked for from here. Please try again later.');
    otpHits.set(ip, [...hits, now]);
  };
  app.get('/public/careers', async (c) => c.json(await recruitment.openVacancies(db, { schoolId: c.req.query('schoolId'), postType: c.req.query('postType'), subject: c.req.query('subject'), search: c.req.query('q'), page: Number(c.req.query('page') ?? 1) })));
  app.get('/public/careers/:id', async (c) => c.json(await recruitment.vacancy(db, c.req.param('id'))));
  app.post('/public/careers/otp', async (c) => { otpLimit(c); return c.json(await recruitment.requestOtp(db, await body(c, z.object({ destination: z.string().min(5).max(120), purpose: z.enum(['REGISTER', 'LOGIN']) })))); });
  app.post('/public/careers/register', async (c) => c.json(await recruitment.register(db, await body(c, z.object({ name: z.string().trim().min(3).max(80), email: z.string().email().max(120), mobile: z.string().min(10).max(15),
    dob: date, gender: z.enum(['F', 'M', 'X']), category: z.enum(['GEN', 'OBC', 'SC', 'ST', 'EWS']).optional(), emailCode: z.string().regex(/^\d{6}$/), mobileCode: z.string().regex(/^\d{6}$/) }))), 201));
  app.get('/public/alumni/schools', async (c) => c.json(await alumni.schools(db)));
  app.post('/public/alumni/code', async (c) => { otpLimit(c); return c.json(await alumni.requestCode(db, await body(c, z.object({ destination: z.string().min(5).max(120), purpose: z.enum(['ALUMNI_REGISTER', 'ALUMNI_LOGIN']) })))); });
  app.post('/public/alumni/register', async (c) => c.json(await alumni.register(db, await body(c, z.object({ schoolId: uuid, name: z.string().trim().min(3).max(80), email: z.string().email().max(120), mobile: z.string().min(10).max(15),
    dob: date.nullable().optional(), leftYear: z.number().int().min(1950).max(2100), lastClass: z.string().max(10).optional(), city: z.string().max(60).optional(), occupation: z.string().max(80).optional(),
    organisation: z.string().max(120).optional(), inDirectory: z.boolean().optional(), emailCode: z.string().regex(/^\d{6}$/), mobileCode: z.string().regex(/^\d{6}$/) }))), 201));
  app.post('/public/alumni/login', async (c) => c.json(await alumni.login(db, await body(c, z.object({ destination: z.string().min(5).max(120), code: z.string().regex(/^\d{6}$/) })))));
  app.post('/public/careers/login', async (c) => c.json(await recruitment.login(db, await body(c, z.object({ destination: z.string().min(5).max(120), code: z.string().regex(/^\d{6}$/) })))));

  // The gateway calls this without a session; the HMAC signature is the authentication.
  app.post('/payments/webhook', async (c) => {
    const raw = await c.req.text();
    return c.json(await payments.handleWebhook(db, raw, c.req.header('x-signature')));
  });

  // ── The agent API: helpdesk, developer and AI agents. Signed requests only; tickets only, never school data. ──
  const agentRoute = (method: 'GET' | 'POST', path: string, handler: (agent: support.Agent, input: any, c: Context) => Promise<unknown>) =>
    app.on(method, `/agent/v1${path}`, async (c) => {
      const raw = method === 'GET' ? '' : await c.req.text();
      const url = new URL(c.req.url);
      const signed = url.pathname + url.search;
      const agent = await support.authenticateAgent(db, { key: c.req.header('x-ns-key'), ts: c.req.header('x-ns-timestamp'), sig: c.req.header('x-ns-signature'),
        proto: c.req.header('x-forwarded-proto') ?? url.protocol.replace(':', '') }, method, signed, raw);
      let input: unknown = {};
      if (raw) { try { input = JSON.parse(raw); } catch { throw new AppError(422, 'invalid', 'The body is not JSON.'); } }
      try {
        const r = await handler(agent, input, c);
        await support.logCall(db, agent.id, method, signed, 200);
        return c.json(r);
      } catch (e) { await support.logCall(db, agent.id, method, signed, (e as AppError).status ?? 500); throw e; }
    });
  const parse = <T extends z.ZodTypeAny>(schema: T, v: unknown): z.infer<T> => {
    const r = schema.safeParse(v);
    if (!r.success) throw new AppError(422, 'invalid', 'Some fields need attention.', r.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })));
    return r.data;
  };
  agentRoute('GET', '/catalog', async () => support.catalog());
  agentRoute('GET', '/knowledge', async (_a, _i, c) => support.knowledge(c.req.query('q') ?? ''));
  agentRoute('GET', '/tickets', async (a, _i, c) => support.agentQueue(db, a, { status: c.req.query('status'), waiting: c.req.query('waiting') === '1' }));
  agentRoute('GET', '/tickets/:number', async (a, _i, c) => support.agentTicket(db, a, c.req.param('number')!));
  agentRoute('POST', '/tickets/:number/notes', async (a, i, c) => support.agentMessage(db, a, c.req.param('number')!, { body: parse(z.object({ body: z.string().min(2).max(5000) }), i).body, internal: true }));
  agentRoute('POST', '/tickets/:number/triage', async (a, i, c) => support.agentTriage(db, a, c.req.param('number')!, parse(z.object({
    category: z.enum(['PROBLEM', 'DATA', 'REQUEST', 'QUESTION', 'ACCESS']).optional(), module: z.string().max(30).optional(), severity: z.enum(['LOW', 'NORMAL', 'HIGH', 'URGENT']).optional(),
    summary: z.string().max(1000).optional(), needsDeveloper: z.boolean().optional(), reason: z.string().max(500).optional() }), i)));
  agentRoute('POST', '/tickets/:number/proposals', async (a, i, c) => support.agentPropose(db, a, c.req.param('number')!, parse(z.object({
    kind: z.enum(['DATA_CORRECTION', 'REPAIR', 'SETTING', 'CODE_CHANGE']), ref: z.string().max(20).optional(), field: z.string().max(60).optional(), newValue: z.string().max(500).optional(),
    action: z.string().max(40).optional(), params: z.record(z.string(), z.unknown()).optional(), summary: z.string().min(5).max(300), details: z.string().max(20000).optional(), risk: z.enum(['LOW', 'MEDIUM', 'HIGH']).optional() }), i)));
  agentRoute('POST', '/tickets/:number/resolve', async (a, i, c) => support.agentResolve(db, a, c.req.param('number')!, parse(z.object({ resolution: z.string().min(5).max(2000) }), i).resolution));

  app.use('*', async (c, next) => {
    const token = c.req.header('authorization')?.replace(/^Bearer\s+/i, '');
    c.set('actor', await actorFromToken(db, token));
    await next();
  });
  // The helpdesk, the developer and candidates have no part of the NES tree: whatever a route would
  // allow, they reach only their own screens (and never a school's records).
  app.use('*', async (c, next) => {
    const a = c.get('actor'), p = c.req.path.replace(/^\/api\/v1/, '');
    if (['SUPPORT', 'DEVELOPER'].includes(a.role) && !/^\/(me|support|help|notifications|fixes|system\/errors)(\/|$)/.test(p)) throw new AppError(403, 'forbidden', 'The support desk works on tickets only.');
    if (a.role === 'CANDIDATE' && !/^\/(me|candidate|help|notifications)(\/|$)/.test(p)) throw new AppError(403, 'forbidden', 'This is for school staff and parents.');
    if (a.role === 'ALUMNUS' && !/^\/(me|alumni-me|help|notifications)(\/|$)/.test(p)) throw new AppError(403, 'forbidden', 'This is for school staff and parents.');
    await next();
  });

  // Who is signed in, and what they may do (the screens show only those actions).
  app.get('/me', async (c) => c.json({ ...c.get('actor'), can: access.permissionsOf(c.get('actor')), governance: await governance.involved(db, c.get('actor')),
    inspections: ['NES_ADMIN', 'COMMAND_OFFICER', 'SCHOOL_ADMIN'].includes(c.get('actor').role) || !!(await db.maybeOne('select 1 from inspection_team where user_id = $1', [c.get('actor').id])) }));
  // Emergency controls for NES; the error log for NES, the helpdesk and the developer.
  app.get('/system/switches', async (c) => c.json(await system.list(db, c.get('actor'))));
  app.post('/system/switches/:key', async (c) => { const b = await body(c, z.object({ on: z.boolean(), reason: z.string().max(300) }));
    return c.json(await system.set(db, c.get('actor'), z.enum(Object.keys(system.SWITCHES) as [system.SwitchKey, ...system.SwitchKey[]]).parse(c.req.param('key')), b.on, b.reason)); });
  app.post('/system/sign-out-all', async (c) => c.json(await system.signEveryoneOut(db, c.get('actor'), (await body(c, z.object({ reason: z.string().max(300) }))).reason)));
  app.post('/system/lockdown', async (c) => { const b = await body(c, z.object({ reason: z.string().max(300), confirm: z.string().max(10) })); return c.json(await system.lockdown(db, c.get('actor'), b.reason, b.confirm)); });
  app.get('/system/errors', async (c) => c.json(await system.recentErrors(db, c.get('actor'))));
  app.get('/org/tree', async (c) => c.json(await org.tree(db, c.get('actor'))));
  app.get('/org/schools/:id/campuses', async (c) => {
    await assertUnitInScope(db, c.get('actor'), c.req.param('id'));
    return c.json(await org.campuses(db, c.req.param('id')));
  });
  app.get('/schools/:id/details', async (c) => c.json(await org.schoolDetails(db, c.get('actor'), c.req.param('id'))));
  app.put('/schools/:id/details', async (c) => c.json(await org.updateSchoolDetails(db, c.get('actor'), c.req.param('id'), await body(c, z.object({
    name: z.string().min(3).max(120).optional(), address: z.string().max(300).nullable().optional(), phone: z.string().max(60).nullable().optional(), email: z.string().max(120).nullable().optional(),
    website: z.string().max(120).nullable().optional(), city: z.string().max(60).nullable().optional(), affiliationNo: z.string().max(30).nullable().optional(), udiseCode: z.string().max(20).nullable().optional(),
    schoolNo: z.string().max(20).nullable().optional(), tan: z.string().max(10).nullable().optional(), campuses: z.array(z.object({ id: uuid, address: z.string().max(300) })).max(10).optional() })))));
  app.post('/org/mergers', async (c) => c.json(await org.recordMerger(db, c.get('actor'),
    await body(c, z.object({ mergedSchoolId: uuid, survivingSchoolId: uuid, effectiveDate: date, note: z.string().optional() })))));
  app.get('/ranks', async (c) => c.json(await db.query('select code, service, name, band from rank order by service, band, name')));
  app.get('/categories/schemes', async (c) => { await access.assertCan(db, c.get('actor'), 'categories.view'); return c.json(await categories.listSchemes(db)); });
  app.post('/categories/evaluate', async (c) => {
    const b = await body(c, z.object({ schoolId: uuid, relationship: z.string(), service }));
    await access.assertCan(db, c.get('actor'), 'categories.view', b.schoolId);
    return c.json(await admissions.evaluateApplicant(db, b.schoolId, b.relationship, b.service));
  });

  app.get('/dashboard/muster', async (c) => c.json(await dashboard.muster(db, c.get('actor'), c.req.query('year') ?? currentYear())));

  app.get('/admissions', async (c) => c.json(await admissions.listApplications(db, c.get('actor'), c.req.query('schoolId')!, c.req.query('status'))));
  app.post('/admissions', async (c) => c.json(await admissions.submitApplication(db, c.get('actor'), await body(c, z.object({
    campusId: uuid, academicYear: z.string(), classCode: z.string(),
    child: z.object({ name: z.string().min(2), dob: date, gender: z.enum(['F', 'M', 'X']), bloodGroup: z.enum(['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-']).nullable().optional(),
      apaarId: z.string().regex(/^\d{12}$/, 'APAAR ID has 12 digits.').nullable().optional(), pen: z.string().regex(/^\d{11}$/, 'PEN has 11 digits.').nullable().optional() }),
    guardian: z.object({ name: z.string().min(2), phone: z.string().regex(/^\+91[6-9]\d{9}$/, 'Use +91 and a 10-digit mobile number.'), email: z.string().email().optional() }),
    relationship: z.enum(['FATHER', 'MOTHER', 'GUARDIAN', 'GRANDPARENT']), service,
    address: z.string().max(300).nullable().optional(), previousSchool: z.string().max(160).nullable().optional(),
    otherParent: z.object({ name: z.string().min(2), phone: z.string().regex(/^\+91[6-9]\d{9}$/, 'Use +91 and a 10-digit mobile number.'), email: z.string().email().optional(),
      relationship: z.enum(['FATHER', 'MOTHER', 'GUARDIAN', 'GRANDPARENT']) }).nullable().optional(),
  }))), 201));
  app.put('/students/:id/details', async (c) => c.json(await students.updateDetails(db, c.get('actor'), c.req.param('id'), await body(c, z.object({
    name: z.string().min(2).max(120).optional(), dob: date.optional(), gender: z.enum(['F', 'M', 'X']).optional(), bloodGroup: z.enum(['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-']).nullable().optional(),
    apaarId: z.string().regex(/^\d{12}$/, 'APAAR ID has 12 digits.').nullable().optional(), pen: z.string().regex(/^\d{11}$/, 'PEN has 11 digits.').nullable().optional(), previousSchool: z.string().max(160).nullable().optional() })))));
  app.put('/guardians/:id', async (c) => c.json(await students.updateGuardian(db, c.get('actor'), c.req.param('id'), await body(c, z.object({
    name: z.string().min(2).max(120).optional(), phone: z.string().regex(/^\+91[6-9]\d{9}$/, 'Use +91 and a 10-digit mobile number.').optional(), email: z.string().email().nullable().optional(), address: z.string().max(300).nullable().optional() })))));
  app.get('/admissions/:id', async (c) => c.json(await admissions.applicationDetail(db, c.get('actor'), c.req.param('id'))));
  app.post('/admissions/:id/documents', async (c) => {
    const b = await body(c, z.object({ docType: z.string(), status: z.enum(['VERIFIED', 'REJECTED']), note: z.string().optional() }));
    return c.json(await admissions.verifyDocument(db, c.get('actor'), c.req.param('id'), b.docType, b.status, b.note));
  });
  app.post('/admissions/:id/offer', async (c) => {
    const b = await body(c, z.object({ overCapacityReason: z.string().min(5).optional() }));
    return c.json(await admissions.offerSeat(db, c.get('actor'), c.req.param('id'), b.overCapacityReason));
  });
  app.post('/admissions/:id/admit', async (c) => c.json(await admissions.admit(db, c.get('actor'), c.req.param('id'),
    await body(c, z.object({ provisional: z.boolean().optional(), tcDueDate: date.optional(), startDate: date.optional() })))));
  app.post('/admissions/:id/confirm', async (c) => c.json(await admissions.confirmProvisional(db, c.get('actor'), c.req.param('id'))));
  app.post('/admissions/:id/status', async (c) => {
    const b = await body(c, z.object({ status: z.enum(['WAITLISTED', 'REJECTED', 'WITHDRAWN']), note: z.string().optional() }));
    return c.json(await admissions.setStatus(db, c.get('actor'), c.req.param('id'), b.status, b.note));
  });
  app.get('/campuses/:id/seats', async (c) => c.json(await admissions.seatMatrix(db, c.get('actor'), c.req.param('id'), c.req.query('year') ?? currentYear())));

  const studentFilter = z.object({ classCode: z.string().regex(/^[A-Z0-9]{1,4}$/).optional(), section: z.string().regex(/^[A-Z]$/).optional(),
    status: z.enum(['ACTIVE', 'PROVISIONAL']).optional(), offset: z.coerce.number().int().min(0).max(100_000).optional() });
  app.get('/students', async (c) => {
    const f = studentFilter.safeParse({ classCode: c.req.query('classCode') || undefined, section: c.req.query('section') || undefined, status: c.req.query('status') || undefined, offset: c.req.query('offset') || undefined });
    if (!f.success) throw invalid('Choose a class, section and status from the lists.');
    return c.json(await students.search(db, c.get('actor'), c.req.query('q') ?? '', c.req.query('schoolId'), f.data));
  });
  app.get('/students/:id', async (c) => c.json(await students.profile(db, c.get('actor'), c.req.param('id'))));
  // Moving to another Navy Children School or Navy Kindergarten: a request the other school answers.
  app.get('/students/:id/transfer-destinations', async (c) => c.json(await transfers.destinations(db, c.get('actor'), c.req.param('id'), c.req.query('classCode') || undefined)));
  app.get('/students/:id/transfer-requests', async (c) => c.json(await transfers.requestsForStudent(db, c.get('actor'), c.req.param('id'))));
  app.post('/students/:id/transfer-requests', async (c) => c.json(await transfers.requestTransfer(db, c.get('actor'), { studentId: c.req.param('id'),
    ...(await body(c, z.object({ toSchoolId: uuid, joiningOn: date, reason: z.string().max(300), classCode: z.string().max(10).optional() }))) }), 201));
  app.get('/schools/:id/transfer-requests/incoming', async (c) => c.json(await transfers.incomingRequests(db, c.get('actor'), c.req.param('id'))));
  app.get('/schools/:id/transfer-requests/outgoing', async (c) => c.json(await transfers.outgoingRequests(db, c.get('actor'), c.req.param('id'))));
  app.post('/transfer-requests/:id/decide', async (c) => c.json(await transfers.decide(db, c.get('actor'), c.req.param('id'),
    await body(c, z.object({ decision: z.enum(['ACCEPT', 'WAITLIST', 'DECLINE']), sectionId: uuid.optional(), note: z.string().max(300).optional() })))));
  app.post('/transfer-requests/:id/cancel', async (c) => c.json(await transfers.cancelRequest(db, c.get('actor'), c.req.param('id'), (await body(c, z.object({ reason: z.string().max(300) }))).reason)));
  // Staff chat, end-to-end encrypted: the server stores keys it cannot use and ciphertext it cannot read.
  const b64 = z.string().regex(/^[A-Za-z0-9+/=]+$/);
  const identityBody = z.object({ publicKey: b64.max(8000), keyBackup: b64.max(8000), backupSalt: b64.max(200), backupIv: b64.max(200), backupIterations: z.number().int(), fingerprint: z.string().max(120) });
  app.get('/chat/identity', async (c) => c.json({ identity: await chat.identity(db, c.get('actor')) }));
  app.post('/chat/identity', async (c) => c.json(await chat.setIdentity(db, c.get('actor'), await body(c, identityBody)), 201));
  app.post('/chat/identity/reset', async (c) => c.json(await chat.setIdentity(db, c.get('actor'), await body(c, identityBody), true)));
  app.get('/chat/people', async (c) => c.json(await chat.directory(db, c.get('actor'), c.req.query('q') ?? '')));
  app.get('/chat/conversations', async (c) => c.json(await chat.conversations(db, c.get('actor'))));
  app.get('/chat/unread', async (c) => c.json(await chat.unread(db, c.get('actor'))));
  app.post('/chat/direct', async (c) => c.json(await chat.direct(db, c.get('actor'), (await body(c, z.object({ userId: uuid }))).userId)));
  app.post('/chat/groups', async (c) => c.json(await chat.createGroup(db, c.get('actor'), await body(c, z.object({ title: z.string().max(80), memberIds: z.array(uuid).max(500) }))), 201));
  app.get('/chat/conversations/:id', async (c) => c.json(await chat.detail(db, c.get('actor'), c.req.param('id'))));
  app.post('/chat/conversations/:id/keys', async (c) => c.json(await chat.putKeys(db, c.get('actor'), c.req.param('id'), await body(c, z.object({
    epoch: z.number().int().min(1), envelopes: z.array(z.object({ userId: uuid, wrappedKey: b64.max(400), iv: b64.max(40), recipientKeyVersion: z.number().int().min(1) })).max(600) })))));
  app.get('/chat/conversations/:id/messages', async (c) => c.json(await chat.messages(db, c.get('actor'), c.req.param('id'),
    { before: c.req.query('before') || undefined, after: c.req.query('after') || undefined, limit: Number(c.req.query('limit') ?? 60) })));
  app.post('/chat/conversations/:id/messages', async (c) => c.json(await chat.send(db, c.get('actor'), c.req.param('id'), await body(c, z.object({
    epoch: z.number().int().min(1), iv: b64.max(40), ciphertext: b64.max(200_000), attachmentId: uuid.nullable().optional(), replyTo: uuid.nullable().optional() }))), 201));
  app.post('/chat/conversations/:id/read', async (c) => c.json(await chat.markRead(db, c.get('actor'), c.req.param('id'))));
  app.post('/chat/conversations/:id/files', async (c) => c.json(await chat.upload(db, c.get('actor'), c.req.param('id'), new Uint8Array(await c.req.arrayBuffer())), 201));
  app.get('/chat/files/:id', async (c) => c.body(new Uint8Array(await chat.download(db, c.get('actor'), c.req.param('id'))), 200, { 'content-type': 'application/octet-stream', 'cache-control': 'private, no-store' }));
  app.delete('/chat/messages/:id', async (c) => c.json(await chat.remove(db, c.get('actor'), c.req.param('id'))));
  app.post('/chat/conversations/:id/members', async (c) => c.json(await chat.addMembers(db, c.get('actor'), c.req.param('id'), (await body(c, z.object({ userIds: z.array(uuid).min(1).max(200) }))).userIds)));
  app.delete('/chat/conversations/:id/members/:userId', async (c) => c.json(await chat.removeMember(db, c.get('actor'), c.req.param('id'), c.req.param('userId'))));
  app.put('/chat/conversations/:id/members/:userId', async (c) => c.json(await chat.setRole(db, c.get('actor'), c.req.param('id'), c.req.param('userId'), (await body(c, z.object({ role: z.enum(['ADMIN', 'MEMBER']) }))).role)));
  app.put('/chat/conversations/:id', async (c) => c.json(await chat.rename(db, c.get('actor'), c.req.param('id'), (await body(c, z.object({ title: z.string().max(80) }))).title)));
  app.get('/schools/:id/incoming', async (c) => c.json(await transfers.incoming(db, c.get('actor'), c.req.param('id'))));
  app.post('/enrolments/:id/section', async (c) => c.json(await transfers.placeInSection(db, c.get('actor'), c.req.param('id'), (await body(c, z.object({ sectionId: uuid }))).sectionId)));
  app.post('/guardians/:id/service', async (c) => c.json(await students.changeService(db, c.get('actor'), c.req.param('id'),
    await body(c, service.extend({ from: date, evidence: z.string().optional() })))));
  app.get('/my/children', async (c) => {
    const a = c.get('actor');
    return c.json(await db.query(
      `select s.id, s.name, s.nes_id, e.id as enrolment_id, e.class_code, sec.name as section, e.admission_no, e.school_id, o.name as school, cp.name as campus
         from student_guardian sg join student s on s.id = sg.student_id
         join enrolment e on e.student_id = s.id and upper_inf(e.period)
         join org_unit o on o.id = e.school_id join org_unit cp on cp.id = e.campus_id left join section sec on sec.id = e.section_id
        where sg.guardian_id = $1 order by s.dob`, [a.guardianId]));
  });

  app.get('/fees/plans', async (c) => {
    await access.assertCan(db, c.get('actor'), 'fees.view', c.req.query('schoolId') ?? '');
    return c.json(await fees.planDetail(db, c.req.query('schoolId')!, c.req.query('year') ?? currentYear()));
  });
  app.post('/fees/schedule', async (c) => {
    const b = await body(c, z.object({ schoolId: uuid, year: z.string(), schedule: z.enum(['QUARTERLY', 'MONTHLY']) }));
    return c.json(await fees.setSchedule(db, c.get('actor'), b.schoolId, b.year, b.schedule));
  });
  app.get('/students/:id/family', async (c) => {
    const g = await access.assertStudentAccess(db, c.get('actor'), c.req.param('id'), 'profile');
    const f = await fees.family(db, c.req.param('id'));
    return c.json({ ...f, pta: g.has('fee_status') ? f.pta : null });   // the PTA fee and whether it is paid: those who may see fees
  });
  app.post('/students/:id/fees/whole-year', async (c) => { await access.assertStudentAccess(db, c.get('actor'), c.req.param('id'), 'fees'); return c.json(await fees.billRestOfYear(db, c.get('actor'), c.req.param('id'))); });
  app.get('/students/:id/pay-options', async (c) => { await access.assertStudentAccess(db, c.get('actor'), c.req.param('id'), 'fees'); return c.json(await fees.payOptions(db, c.req.param('id'))); });
  app.post('/fees/generate', async (c) => {
    const b = await body(c, z.object({ schoolId: uuid, year: z.string(), installment: z.string() }));
    return c.json(await fees.generateDemands(db, c.get('actor'), b.schoolId, b.year, b.installment));
  });
  app.post('/fees/plans/:planId/revisions', async (c) => c.json(await fees.draftRevision(db, c.get('actor'), c.req.param('planId'), await body(c, z.object({
    effectiveFrom: date, policy: z.enum(['FUTURE_ONLY', 'DIFFERENCE_ON_PAID']), note: z.string().min(3),
    arrears: z.object({ mode: z.enum(['WITH_NEXT', 'ON_DATE', 'SPREAD']), due: date.nullable().optional() }).optional(),
    changes: z.array(z.object({ classBand: z.string(), feeBand: z.string(), head: z.string(), amountPaise: z.number().int().nonnegative() })).min(1),
  }))), 201));
  app.get('/fees/revisions/:id/preview', async (c) => {
    const v = await db.maybeOne<{ school_id: string }>('select p.school_id from fee_plan_version v join fee_plan p on p.id = v.plan_id where v.id = $1', [c.req.param('id')]);
    await access.assertCan(db, c.get('actor'), 'fees.view', v?.school_id ?? '');
    return c.json(await fees.previewRevision(db, c.req.param('id')));
  });
  app.post('/fees/revisions/:id/approve', async (c) => c.json(await fees.approveRevision(db, c.get('actor'), c.req.param('id'))));
  app.get('/students/:id/dues', async (c) => {
    await students.assertStudentAccess(db, c.get('actor'), c.req.param('id'), 'fees');
    return c.json(await fees.dues(db, c.req.param('id')));
  });

  app.post('/payments/orders', async (c) => c.json(await payments.createOrder(db, c.get('actor'), await body(c, z.object({
    studentId: uuid, method: z.string(), idempotencyKey: z.string().min(8),
    items: z.array(z.object({ enrolmentId: uuid, bill: z.string().optional(), installment: z.string().optional(), amountPaise: z.number().int().min(1).optional() }).refine((x) => x.bill || x.installment, 'Choose what to pay.')).min(1),
  }))), 201));

  // ── Additional charges (CBSE, trips, events) and refunds ──
  const chargeBody = z.object({
    schoolId: uuid, year: z.string(), head: z.string(), title: z.string().min(3).max(120), details: z.string().max(1000).optional(), amountPaise: z.number().int().positive(),
    mode: z.enum(['COMPULSORY', 'OPTIONAL']), classCodes: z.array(z.string()).min(1), sectionIds: z.array(uuid).nullable().optional(), dueOn: date,
    respondBy: date.nullable().optional(), capacity: z.number().int().positive().nullable().optional(), refundableUntil: date.nullable().optional(), inChargeId: uuid.nullable().optional(),
  });
  app.get('/fee-heads', async (c) => c.json(await db.query(`select code, name, kind, income_account, refundable from fee_head order by alloc_priority`)));
  app.get('/schools/:id/charges', async (c) => c.json(await charges.list(db, c.get('actor'), c.req.param('id'), c.req.query('year') ?? currentYear())));
  app.post('/charges', async (c) => c.json(await charges.draft(db, c.get('actor'), await body(c, chargeBody)), 201));
  app.get('/charges/:id', async (c) => c.json(await charges.detail(db, c.get('actor'), c.req.param('id'))));
  app.post('/charges/:id/approve', async (c) => c.json(await charges.approve(db, c.get('actor'), c.req.param('id'))));
  app.post('/charges/:id/discard', async (c) => c.json(await charges.discard(db, c.get('actor'), c.req.param('id'))));
  app.post('/charges/:id/refresh', async (c) => c.json(await charges.refresh(db, c.get('actor'), c.req.param('id'))));
  app.post('/charges/:id/close', async (c) => c.json(await charges.close(db, c.get('actor'), c.req.param('id'))));
  app.post('/charges/:id/reopen', async (c) => c.json(await charges.reopen(db, c.get('actor'), c.req.param('id'), (await body(c, z.object({ respondBy: date }))).respondBy)));
  app.post('/charges/:id/cancel', async (c) => c.json(await charges.cancel(db, c.get('actor'), c.req.param('id'), (await body(c, z.object({ reason: z.string().max(300) }))).reason)));
  app.post('/charges/:id/reply', async (c) => {
    const b = await body(c, z.object({ studentId: uuid, going: z.boolean(), note: z.string().max(200).optional() }));
    return c.json(await charges.respond(db, c.get('actor'), c.req.param('id'), b.studentId, b.going, b.note ?? ''));
  });
  app.post('/charges/:id/excuse', async (c) => {
    const b = await body(c, z.object({ studentId: uuid, reason: z.string().max(300) }));
    return c.json(await charges.excuse(db, c.get('actor'), c.req.param('id'), b.studentId, b.reason));
  });
  app.post('/charges/:id/payouts', async (c) => c.json(await charges.payout(db, c.get('actor'), c.req.param('id'), await body(c, z.object({
    amountPaise: z.number().int().positive(), paidOn: date, payee: z.string().min(2).max(120), reference: z.string().max(80) }))), 201));
  app.get('/students/:id/charges', async (c) => c.json(await charges.forStudent(db, c.get('actor'), c.req.param('id'))));
  app.get('/students/:id/credits', async (c) => {
    await students.assertStudentAccess(db, c.get('actor'), c.req.param('id'), 'fees');
    return c.json(await refunds.creditsFor(db, c.req.param('id')));
  });
  app.get('/schools/:id/refunds', async (c) => c.json(await refunds.list(db, c.get('actor'), c.req.param('id'))));
  app.post('/refunds', async (c) => c.json(await refunds.request(db, c.get('actor'), await body(c, z.object({ enrolmentId: uuid, bill: z.string(), reason: z.string().max(300) }))), 201));
  app.post('/refunds/:id/pay', async (c) => c.json(await refunds.pay(db, c.get('actor'), c.req.param('id'), await body(c, z.object({
    method: z.enum(['BANK_TRANSFER', 'CHEQUE', 'CASH']), reference: z.string().max(80) })))));
  app.post('/payments/orders/:id/sandbox', async (c) => {
    const b = await body(c, z.object({ outcome: z.enum(['success', 'failure']) }));
    return c.json(await payments.sandboxPay(db, c.get('actor'), c.req.param('id'), b.outcome));
  });
  app.get('/payments/receipts/:no{.+}', async (c) => c.json(await payments.receipt(db, c.get('actor'), decodeURIComponent(c.req.param('no')))));
  app.get('/schools/:id/fees/standing', async (c) => c.json(await payments.standing(db, c.get('actor'), c.req.param('id'), c.req.query('year') ?? currentYear(), localToday())));
  app.get('/payments/collections', async (c) => c.json(await payments.collections(db, c.get('actor'), c.req.query('schoolId')!)));
  app.get('/ledger/trial-balance', async (c) => {
    requireRole(c.get('actor'), 'NES_ADMIN', 'SCHOOL_ADMIN', 'ACCOUNTANT');
    await assertUnitInScope(db, c.get('actor'), c.req.query('schoolId') ?? '');
    return c.json(await trialBalance(db, c.req.query('schoolId')!));
  });

  app.get('/messages', async (c) => c.json(await messaging.inbox(db, c.get('actor'))));
  app.post('/messages', async (c) => c.json(await messaging.createThread(db, c.get('actor'), await body(c, z.object({
    sectionId: uuid, subject: z.string().min(3), body: z.string().min(1), replyMode: z.enum(['NONE', 'ALLOWED', 'REQUIRED']), options: z.array(z.string()).max(6).optional(),
  }))), 201));
  app.get('/messages/:id', async (c) => c.json(await messaging.thread(db, c.get('actor'), c.req.param('id'))));
  app.post('/messages/:id/reply', async (c) => c.json(await messaging.reply(db, c.get('actor'), c.req.param('id'),
    await body(c, z.object({ body: z.string().optional(), choice: z.string().optional(), studentId: uuid.optional() }))), 201));
  app.get('/messages/:id/responses', async (c) => c.json(await messaging.responses(db, c.get('actor'), c.req.param('id'))));

  app.get('/sections', async (c) => c.json(await attendance.mySections(db, c.get('actor'))));
  app.get('/schools/:id/attendance/day', async (c) => c.json(await attendance.schoolDay(db, c.get('actor'), c.req.param('id'), c.req.query('date') ?? localToday())));
  app.get('/sections/:id/attendance', async (c) => c.json(await attendance.roster(db, c.get('actor'), c.req.param('id'), c.req.query('date') ?? localToday())));
  app.put('/sections/:id/attendance', async (c) => {
    const b = await body(c, z.object({ date, absent: z.array(z.object({ enrolmentId: uuid, status: z.enum(['A', 'L']) })) }));
    return c.json(await attendance.mark(db, c.get('actor'), c.req.param('id'), b.date, b.absent));
  });

  // ── Notifications ──
  app.get('/notifications', async (c) => c.json(await notify.mine(db, c.get('actor'))));
  app.post('/notifications/read', async (c) => {
    const b = await body(c, z.object({ ids: z.array(z.number().int()).max(500).optional(), all: z.boolean().optional() }));
    return c.json(await notify.markRead(db, c.get('actor'), b.all ? 'all' : b.ids ?? []));
  });

  // ── School life: homework, notices, calendar, leave, timetable ──
  app.get('/subjects', async (c) => c.json(await homework.subjects(db)));
  app.get('/my/sections', async (c) => c.json(await attendance.mySections(db, c.get('actor'))));
  app.get('/my/timetable', async (c) => c.json(await timetable.forTeacher(db, c.get('actor'), c.req.query('date') ?? today())));
  app.post('/homework', async (c) => c.json(await homework.create(db, c.get('actor'), await body(c, z.object({
    sectionId: uuid, subjectCode: z.string(), title: z.string().trim().min(3).max(160), details: z.string().max(4000).optional(), dueOn: date,
  }))), 201));
  app.get('/sections/:id/homework', async (c) => c.json(await homework.forSection(db, c.get('actor'), c.req.param('id'))));
  app.post('/homework/:id/withdraw', async (c) => c.json(await homework.withdraw(db, c.get('actor'), c.req.param('id'))));
  app.get('/students/:id/homework', async (c) => c.json(await homework.forStudent(db, c.get('actor'), c.req.param('id'))));
  app.put('/homework/:id/done', async (c) => {
    const b = await body(c, z.object({ studentId: uuid, done: z.boolean() }));
    return c.json(await homework.setDone(db, c.get('actor'), c.req.param('id'), b.studentId, b.done));
  });

  app.get('/notices', async (c) => c.json(await notices.forStaff(db, c.get('actor'))));
  app.post('/notices', async (c) => c.json(await notices.create(db, c.get('actor'), await body(c, z.object({
    unitId: uuid, title: z.string().trim().min(3).max(160), body: z.string().trim().min(1).max(8000),
    kind: z.enum(['CIRCULAR', 'NOTICE', 'EVENT', 'URGENT']), audience: z.enum(['ALL', 'PARENTS', 'STAFF']),
    classCodes: z.array(z.string()).max(20).optional(), isPublic: z.boolean().optional(),
  }))), 201));
  app.get('/notices/:id', async (c) => c.json(await notices.one(db, c.get('actor'), c.req.param('id'), c.req.query('studentId'))));
  app.post('/notices/:id/withdraw', async (c) => c.json(await notices.withdraw(db, c.get('actor'), c.req.param('id'))));
  app.get('/students/:id/notices', async (c) => c.json(await notices.forStudent(db, c.get('actor'), c.req.param('id'))));

  app.get('/calendar', async (c) => c.json(await notices.eventsForStaff(db, c.get('actor'), c.req.query('from') ?? today(), c.req.query('to') ?? plusDays(120))));
  app.post('/calendar', async (c) => c.json(await notices.addEvent(db, c.get('actor'), await body(c, z.object({
    unitId: uuid, title: z.string().trim().min(2).max(120), kind: z.enum(['HOLIDAY', 'VACATION', 'EXAM', 'EVENT', 'PTM']),
    from: date, to: date, details: z.string().max(1000).optional(), notify: z.boolean().optional(),
  }))), 201));
  app.delete('/calendar/:id', async (c) => c.json(await notices.removeEvent(db, c.get('actor'), c.req.param('id'))));
  app.get('/students/:id/calendar', async (c) => {
    await students.assertStudentAccess(db, c.get('actor'), c.req.param('id'));
    const e = await db.maybeOne<{ school_id: string }>(`select school_id from enrolment where student_id = $1 and upper_inf(period)`, [c.req.param('id')]);
    if (!e) return c.json([]);
    return c.json(await notices.eventsForSchool(db, e.school_id, c.req.query('from') ?? today(), c.req.query('to') ?? plusDays(180)));
  });

  app.post('/leave', async (c) => c.json(await leave.apply(db, c.get('actor'), await body(c, z.object({
    studentId: uuid, from: date, to: date, reason: z.string().trim().min(3).max(1000),
  }))), 201));
  app.post('/leave/:id/cancel', async (c) => c.json(await leave.cancel(db, c.get('actor'), c.req.param('id'))));
  app.post('/leave/:id/decide', async (c) => {
    const b = await body(c, z.object({ approve: z.boolean(), note: z.string().max(400).optional() }));
    return c.json(await leave.decide(db, c.get('actor'), c.req.param('id'), b.approve, b.note));
  });
  app.get('/leave', async (c) => c.json(await leave.forStaff(db, c.get('actor'), c.req.query('schoolId'))));
  app.get('/students/:id/leave', async (c) => c.json(await leave.forStudent(db, c.get('actor'), c.req.param('id'))));

  app.get('/sections/:id/timetable', async (c) => c.json(await timetable.forSection(db, c.get('actor'), c.req.param('id'), c.req.query('date') ?? today())));
  const hhmm = z.string().regex(/^\d{2}:\d{2}$/, 'Use HH:MM.');
  const lesson = z.object({ weekday: z.number().int().min(1).max(6), period: z.number().int().min(1).max(12), subjectCode: z.string(), teacherId: uuid.nullable().optional(), room: z.string().max(20).nullable().optional() });
  app.put('/sections/:id/timetable', async (c) => {
    const b = await body(c, z.object({ from: date, slots: z.array(lesson).max(72) }));
    return c.json(await timetable.publish(db, c.get('actor'), c.req.param('id'), b.from, b.slots));
  });
  app.get('/sections/:id/day', async (c) => c.json(await timetable.dayForSection(db, c.get('actor'), c.req.param('id'), c.req.query('date') ?? today())));
  app.get('/students/:id/day', async (c) => c.json(await timetable.dayForStudent(db, c.get('actor'), c.req.param('id'), c.req.query('date') ?? today())));
  app.get('/my/day', async (c) => c.json(await cover.teacherDay(db, c.get('actor'), c.req.query('date') ?? today())));

  // School timings (bell schedules)
  app.get('/schools/:id/bells', async (c) => c.json(await timetable.bells(db, c.get('actor'), c.req.param('id'), c.req.query('on') ?? today())));
  app.post('/schools/:id/bells', async (c) => c.json(await timetable.publishBell(db, c.get('actor'), c.req.param('id'), await body(c, z.object({
    name: z.string().trim().min(2).max(60), classCodes: z.array(z.string()).min(1).max(20), from: date,
    slots: z.array(z.object({ weekday: z.number().int().min(1).max(6), kind: z.enum(['PERIOD', 'ASSEMBLY', 'BREAK', 'LUNCH', 'ACTIVITY', 'CLASS_TEACHER']),
      label: z.string().trim().min(1).max(40), periodNo: z.number().int().min(1).max(12).nullable().optional(), starts: hhmm, ends: hhmm })).min(1).max(150),
  }))), 201));

  // Cover for absent teachers
  app.get('/schools/:id/cover', async (c) => c.json(await cover.board(db, c.get('actor'), c.req.param('id'), c.req.query('date') ?? today())));
  app.get('/schools/:id/cover/candidates', async (c) => c.json(await cover.candidates(db, c.get('actor'), c.req.param('id'), c.req.query('date') ?? today(), c.req.query('sectionId') ?? '', Number(c.req.query('period')))));
  app.post('/schools/:id/cover/auto', async (c) => {
    const b = await body(c, z.object({ date }));
    return c.json(await cover.autoAssign(db, c.get('actor'), c.req.param('id'), b.date));
  });
  app.post('/schools/:id/cover', async (c) => {
    const b = await body(c, z.object({ date, sectionId: uuid, period: z.number().int(), kind: z.enum(['PROXY', 'MERGE', 'STUDY']), substituteId: uuid.optional(), mergedWith: uuid.optional() }));
    return c.json(await cover.assign(db, c.get('actor'), { schoolId: c.req.param('id'), ...b }));
  });
  app.delete('/schools/:id/cover', async (c) => c.json(await cover.unassign(db, c.get('actor'), c.req.param('id'), c.req.query('date') ?? '', c.req.query('sectionId') ?? '', Number(c.req.query('period')))));
  app.post('/schools/:id/absences', async (c) => {
    const b = await body(c, z.object({ teacherId: uuid, from: date, to: date, periods: z.array(z.number().int().min(1).max(12)).max(12).nullable().optional(), reason: z.string().trim().min(2).max(200) }));
    return c.json(await cover.markAbsent(db, c.get('actor'), { schoolId: c.req.param('id'), ...b }), 201);
  });
  app.post('/absences/:id/withdraw', async (c) => c.json(await cover.withdrawAbsence(db, c.get('actor'), c.req.param('id'))));
  app.get('/schools/:id/timetable-settings', async (c) => {
    await assertUnitInScope(db, c.get('actor'), c.req.param('id'));
    return c.json(await cover.settings(db, c.req.param('id')));
  });
  app.put('/schools/:id/timetable-settings', async (c) => c.json(await cover.saveSettings(db, c.get('actor'), c.req.param('id'), await body(c, z.object({
    max_proxy_day: z.number().int().min(0).max(8), max_proxy_week: z.number().int().min(0).max(30), max_periods_day: z.number().int().min(1).max(12),
  })))));
  app.get('/schools/:id/proxy-register', async (c) => c.json(await cover.register(db, c.get('actor'), c.req.param('id'), c.req.query('month') ?? today().slice(0, 7))));

  // Special days
  app.get('/schools/:id/day-plans', async (c) => c.json(await cover.dayPlans(db, c.get('actor'), c.req.param('id'), c.req.query('from') ?? today())));
  app.post('/schools/:id/day-plans', async (c) => c.json(await cover.addDayPlan(db, c.get('actor'), { schoolId: c.req.param('id'), ...(await body(c, z.object({
    date, classCodes: z.array(z.string()).max(20).nullable(), kind: z.enum(['EVENT', 'EXAM', 'SHORT_DAY', 'NO_CLASSES']), title: z.string().trim().min(2).max(120),
    cancelledPeriods: z.array(z.number().int().min(1).max(12)).max(12).optional(),
    shortDay: z.object({ firstStart: hhmm, minutes: z.number().int().min(15).max(60), periods: z.number().int().min(1).max(12), breakAfter: z.number().int().min(0).max(12), breakMinutes: z.number().int().min(0).max(60) }).optional(),
    notifyParents: z.boolean().optional(),
  }))) }), 201));
  app.post('/day-plans/:id/withdraw', async (c) => c.json(await cover.withdrawDayPlan(db, c.get('actor'), c.req.param('id'))));

  // Teaching load and the generator
  app.get('/schools/:id/loads', async (c) => c.json(await generator.loads(db, c.get('actor'), c.req.param('id'), c.req.query('year') ?? currentYear())));
  app.put('/sections/:id/load', async (c) => {
    const b = await body(c, z.object({ rows: z.array(z.object({ subjectCode: z.string(), teacherId: uuid.nullable(), periodsPerWeek: z.number().int().min(1).max(12), maxPerDay: z.number().int().min(1).max(4) })).max(20) }));
    return c.json(await generator.saveLoad(db, c.get('actor'), c.req.param('id'), b.rows));
  });
  app.get('/sections/:id/load/from-timetable', async (c) => c.json(await generator.loadFromTimetable(db, c.get('actor'), c.req.param('id'), c.req.query('on') ?? today())));
  app.post('/schools/:id/generate', async (c) => {
    const b = await body(c, z.object({ sectionIds: z.array(uuid).min(1).max(60), from: date, attempts: z.number().int().min(1).max(200).optional() }));
    return c.json(await generator.generate(db, c.get('actor'), c.req.param('id'), b));
  });
  app.post('/schools/:id/generate/publish', async (c) => {
    const b = await body(c, z.object({ from: date, sections: z.array(z.object({ sectionId: uuid, slots: z.array(lesson.extend({ teacherId: uuid.nullable() })).max(72) })).min(1).max(60) }));
    return c.json(await generator.publishProposal(db, c.get('actor'), c.req.param('id'), b));
  });

  app.get('/students/:id/timetable', async (c) => c.json(await timetable.forStudent(db, c.get('actor'), c.req.param('id'), c.req.query('date') ?? today())));
  app.get('/schools/:id/teachers', async (c) => c.json(await timetable.teachers(db, c.get('actor'), c.req.param('id'))));

  app.get('/students/:id/overview', async (c) => c.json(await studentApp.overview(db, c.get('actor'), c.req.param('id'))));
  app.get('/students/:id/guardians', async (c) => c.json(await studentApp.guardians(db, c.get('actor'), c.req.param('id'))));
  app.get('/students/:id/attendance', async (c) => {
    await students.assertStudentAccess(db, c.get('actor'), c.req.param('id'), 'attendance');
    const month = c.req.query('month') ?? today().slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(month)) throw new AppError(422, 'invalid', 'Use YYYY-MM.');
    return c.json(await attendance.forStudentMonth(db, c.req.param('id'), month));
  });

  // ── Academics: assessments, marks, HPC, results ──
  const marksEntry = z.array(z.object({ enrolmentId: uuid, marks: z.number().min(0).max(200).nullable(), absent: z.boolean() })).max(80);
  app.get('/schools/:id/assessments', async (c) => c.json(await academics.list(db, c.get('actor'), c.req.param('id'), c.req.query('year') ?? currentYear())));
  app.post('/schools/:id/assessments', async (c) => {
    const b = await body(c, z.object({ year: z.string(), code: z.string() }));
    return c.json(await academics.createFromPlan(db, c.get('actor'), c.req.param('id'), b.year, b.code), 201);
  });
  app.get('/assessments/:id', async (c) => c.json(await academics.one(db, c.get('actor'), c.req.param('id'))));
  app.get('/assessments/:id/papers', async (c) => c.json(await academics.papers(db, c.get('actor'), c.req.param('id'))));
  app.put('/assessments/:id/papers', async (c) => c.json(await academics.setPaper(db, c.get('actor'), c.req.param('id'), await body(c, z.object({
    classCode: z.string(), subjectCode: z.string(), maxMarks: z.number().positive().max(200).nullable(), examDate: date.nullable().optional(),
  })))));
  app.get('/assessments/:id/progress', async (c) => c.json(await academics.progress(db, c.get('actor'), c.req.param('id'))));
  app.post('/assessments/:id/open', async (c) => c.json(await academics.open(db, c.get('actor'), c.req.param('id'))));
  app.post('/assessments/:id/lock', async (c) => c.json(await academics.lock(db, c.get('actor'), c.req.param('id'))));
  app.post('/assessments/:id/reopen', async (c) => {
    const b = await body(c, z.object({ reason: z.string().trim().min(5).max(500) }));
    return c.json(await academics.reopen(db, c.get('actor'), c.req.param('id'), b.reason));
  });
  app.post('/assessments/:id/publish', async (c) => c.json(await academics.publish(db, c.get('actor'), c.req.param('id'))));
  app.get('/assessments/:id/analysis', async (c) => c.json(await academics.analysis(db, c.get('actor'), c.req.param('id'))));
  app.get('/assessments/:id/sections/:sectionId/results', async (c) => c.json(await academics.sectionResults(db, c.get('actor'), c.req.param('id'), c.req.param('sectionId'))));
  app.get('/assessments/:id/sections/:sectionId/marks/:subject', async (c) => c.json(await academics.sheet(db, c.get('actor'), c.req.param('id'), c.req.param('sectionId'), c.req.param('subject'))));
  app.put('/assessments/:id/sections/:sectionId/marks/:subject', async (c) => {
    const b = await body(c, z.object({ entries: marksEntry }));
    return c.json(await academics.saveMarks(db, c.get('actor'), c.req.param('id'), c.req.param('sectionId'), c.req.param('subject'), b.entries));
  });
  app.get('/assessments/:id/sections/:sectionId/hpc', async (c) => c.json(await academics.hpcSheet(db, c.get('actor'), c.req.param('id'), c.req.param('sectionId'))));
  app.put('/assessments/:id/sections/:sectionId/hpc/:enrolmentId', async (c) => {
    const b = await body(c, z.object({
      entries: z.array(z.object({ domain: z.string(), level: z.enum(['BEGINNER', 'PROGRESSING', 'PROFICIENT', 'ADVANCED']), remark: z.string().max(500).optional() })).max(12),
      remark: z.string().max(800).optional(),
    }));
    return c.json(await academics.saveHpc(db, c.get('actor'), c.req.param('id'), c.req.param('sectionId'), c.req.param('enrolmentId'), b));
  });
  // Holistic Progress Card (Balvatika to Class V): NES templates, ratings per term, All About Me, glimpses, signatures.
  app.get('/hpc/templates', async (c) => c.json(await hpc.templates(db, c.get('actor'))));
  app.get('/hpc/templates/:classCode', async (c) => c.json(await hpc.template(db, c.req.param('classCode'))));
  const hpcItem = z.object({ id: z.string().max(12), text: z.string().trim().min(2).max(600) });
  const hpcGroup = z.object({ id: z.string().max(12), title: z.string().trim().min(2).max(300), items: z.array(hpcItem).min(1).max(40) });
  const hpcPart = z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('STARS'), id: z.string(), tag: z.string().trim().min(2).max(120), groups: z.array(hpcGroup).min(1).max(20) }),
    z.object({ kind: z.literal('GOALS'), id: z.string(), tag: z.string().trim().min(2).max(120), groups: z.array(hpcGroup).min(1).max(30) }),
    z.object({ kind: z.literal('SMILEYS'), id: z.string(), title: z.string().trim().min(2).max(120), groups: z.array(hpcGroup).min(1).max(10) }),
    z.object({ kind: z.literal('CHOICE'), id: z.string(), tag: z.string().max(40).optional(), title: z.string().trim().min(2).max(120), scale: z.array(z.string().trim().min(1).max(20)).min(2).max(5), items: z.array(hpcItem).min(1).max(20) }),
    z.object({ kind: z.literal('SUBJECT'), id: z.string(), tag: z.string().max(40).optional(), title: z.string().trim().min(2).max(120), groups: z.array(hpcGroup).min(1).max(15) }),
    z.object({ kind: z.literal('YESNO'), id: z.string(), tag: z.string().max(40).optional(), title: z.string().trim().min(2).max(120), items: z.array(hpcItem).min(1).max(20) }),
    z.object({ kind: z.literal('TEXT'), id: z.string(), title: z.string().trim().min(2).max(120), items: z.array(hpcItem).min(1).max(10) }),
  ]);
  app.put('/hpc/templates/:classCode', async (c) => c.json(await hpc.saveTemplate(db, c.get('actor'), c.req.param('classCode'), await body(c, z.object({
    stage: z.enum(['BALVATIKA', 'FOUNDATIONAL', 'PREPARATORY']), favourites: z.array(hpcItem).max(12),
    glimpses: z.array(z.enum(['FAMILY', 'SELF', 'PORTFOLIO'])).max(3), parts: z.array(hpcPart).min(1).max(30) })))));
  app.delete('/hpc/templates/:classCode', async (c) => c.json(await hpc.resetTemplate(db, c.get('actor'), c.req.param('classCode'))));
  app.get('/assessments/:id/sections/:sectionId/holistic', async (c) => c.json(await hpc.sheet(db, c.get('actor'), c.req.param('id'), c.req.param('sectionId'))));
  app.get('/assessments/:id/holistic/:enrolmentId', async (c) => c.json(await hpc.child(db, c.get('actor'), c.req.param('id'), c.req.param('enrolmentId'))));
  app.put('/assessments/:id/holistic/:enrolmentId', async (c) => c.json(await hpc.save(db, c.get('actor'), c.req.param('id'), c.req.param('enrolmentId'), await body(c, z.object({
    ratings: z.record(z.string().max(12), z.string().max(400).nullable()), remark: z.string().max(800).optional() })))));
  app.get('/students/:id/about-me', async (c) => c.json(await hpc.profile(db, c.get('actor'), c.req.param('id'))));
  app.put('/students/:id/about-me', async (c) => c.json(await hpc.saveProfile(db, c.get('actor'), c.req.param('id'), (await body(c, z.object({ answers: z.record(z.string().max(8), z.string().max(200)) }))).answers)));
  app.post('/students/:id/glimpses', async (c) => c.json(await hpc.addPhoto(db, c.get('actor'), c.req.param('id'), await body(c, z.object({
    kind: z.enum(['FAMILY', 'SELF', 'PORTFOLIO']), caption: z.string().max(80).optional(), dataBase64: z.string().max(2_100_000) }))), 201));
  app.get('/glimpses/:id', async (c) => image(c, await hpc.photoFile(db, c.get('actor'), c.req.param('id'))));
  app.delete('/glimpses/:id', async (c) => c.json(await hpc.removePhoto(db, c.get('actor'), c.req.param('id'))));
  app.get('/me/signature', async (c) => image(c, await hpc.mySignature(db, c.get('actor'))));
  app.put('/me/signature', async (c) => c.json(await hpc.setSignature(db, c.get('actor'), (await body(c, z.object({ dataBase64: z.string().max(400_000) }))).dataBase64)));
  app.delete('/me/signature', async (c) => c.json(await hpc.removeSignature(db, c.get('actor'))));
  app.get('/my/marking', async (c) => c.json(await academics.mySheets(db, c.get('actor'))));
  app.get('/my/report-cards', async (c) => c.json(await academics.myCards(db, c.get('actor'))));
  app.get('/schools/:id/assessment-plan', async (c) => c.json(await academics.planFor(db, c.get('actor'), c.req.param('id'), c.req.query('year') ?? currentYear())));
  app.get('/students/:id/exam-schedule', async (c) => c.json(await academics.examSchedule(db, c.get('actor'), c.req.param('id'))));
  app.get('/assessments/:id/sections/:sectionId/report-cards', async (c) => {
    const r = await reportCards.forSection(db, c.get('actor'), c.req.param('id'), c.req.param('sectionId'));
    return pdfOut(c, r.pdf, 'report-cards.pdf', { 'x-count': String(r.count) });
  });
  app.get('/students/:id/report-card/:assessmentId', async (c) => pdfOut(c, (await reportCards.forStudent(db, c.get('actor'), c.req.param('id'), c.req.param('assessmentId'))).pdf, 'report-card.pdf'));
  app.get('/students/:id/results', async (c) => {
    const r = await academics.forStudent(db, c.get('actor'), c.req.param('id'));
    return c.json({ ...r, awards: await awards.forStudent(db, c.req.param('id')), board: await exams.boardResultFor(db, c.req.param('id')) });
  });
  app.get('/results/across-schools', async (c) => c.json(await academics.acrossSchools(db, c.get('actor'), c.req.query('year') ?? currentYear(), c.req.query('code') ?? 'HY')));

  // ── Awards ──
  app.get('/awards/schemes', async (c) => c.json(await awards.schemes(db)));
  app.post('/awards/schemes', async (c) => c.json(await awards.createScheme(db, c.get('actor'), await body(c, z.object({
    code: z.string().regex(/^[A-Z0-9_]{3,30}$/, 'Use capitals, digits and underscores.'), name: z.string().trim().min(3).max(120),
    kind: z.enum(['STUDENT', 'TEACHER']), amountPaise: z.number().int().min(0).max(100_000_000), criteria: z.string().max(1000).optional(), from: date,
  }))), 201));
  app.get('/awards', async (c) => c.json(await awards.list(db, c.get('actor'))));
  app.post('/awards', async (c) => c.json(await awards.nominate(db, c.get('actor'), await body(c, z.object({
    schemeId: uuid, schoolId: uuid, year: z.string(), studentId: uuid.optional(), teacherId: uuid.optional(),
    citation: z.string().trim().min(10).max(1500), evidence: z.record(z.string(), z.unknown()).optional(),
  }))), 201));
  app.post('/awards/:id/decide', async (c) => {
    const b = await body(c, z.object({ approve: z.boolean(), note: z.string().max(400).optional() }));
    return c.json(await awards.decide(db, c.get('actor'), c.req.param('id'), b.approve, b.note));
  });
  app.post('/awards/:id/pay', async (c) => {
    const b = await body(c, z.object({ paymentRef: z.string().trim().min(4).max(60) }));
    return c.json(await awards.pay(db, c.get('actor'), c.req.param('id'), b.paymentRef));
  });

  // ── Foundations: settings, duties, approvals, attachments, import and export ──
  app.get('/settings/:unitId', async (c) => c.json(await settings.forUnit(db, c.get('actor'), c.req.param('unitId'))));
  app.put('/settings/:unitId', async (c) => {
    const b = await body(c, z.object({ key: z.string(), value: z.unknown(), from: date, locked: z.boolean().optional(), note: z.string().max(200).optional() }));
    return c.json(await settings.set(db, c.get('actor'), c.req.param('unitId'), b));
  });
  app.delete('/settings/:unitId/:key', async (c) => c.json(await settings.clear(db, c.get('actor'), c.req.param('unitId'), c.req.param('key'), c.req.query('from') ?? today())));
  app.get('/settings/:unitId/:key/history', async (c) => c.json(await settings.history(db, c.get('actor'), c.req.param('unitId'), c.req.param('key'))));

  app.get('/schools/:id/class-teachers', async (c) => c.json(await classTeachers.board(db, c.get('actor'), c.req.param('id'), c.req.query('year') ?? currentYear(), c.req.query('on') ?? today())));
  app.post('/class-teachers', async (c) => c.json(await classTeachers.assign(db, c.get('actor'), await body(c, z.object({
    sectionId: uuid, userId: uuid, kind: z.enum(['CLASS', 'CO']), from: date, move: z.boolean().optional() }))), 201));
  app.post('/class-teachers/:id/end', async (c) => {
    const b = await body(c, z.object({ on: date }));
    return c.json(await classTeachers.end(db, c.get('actor'), c.req.param('id'), b.on));
  });
  app.get('/my/class-teacher', async (c) => c.json(await classTeachers.forTeacher(db, c.get('actor'))));
  app.get('/access/catalogue', async (c) => c.json({ grants: access.GRANTS, roles: access.ROLE_GRANTS, classTeacher: access.CLASS_TEACHER_GRANTS, subjectTeacher: access.SUBJECT_TEACHER_GRANTS, duties: access.DUTY_GRANTS, permissions: access.PERMISSIONS }));

  app.get('/duties/catalogue', (c) => c.json(duties.DUTIES));
  app.get('/schools/:id/duties', async (c) => c.json(await duties.list(db, c.get('actor'), c.req.param('id'))));
  app.get('/schools/:id/staff', async (c) => c.json(await duties.staff(db, c.get('actor'), c.req.param('id'))));
  app.post('/schools/:id/duties', async (c) => {
    const b = await body(c, z.object({ userId: uuid, code: z.string(), from: date, to: date.nullable().optional() }));
    return c.json(await duties.assign(db, c.get('actor'), c.req.param('id'), b), 201);
  });
  app.post('/duties/:id/end', async (c) => {
    const b = await body(c, z.object({ on: date }));
    return c.json(await duties.end(db, c.get('actor'), c.req.param('id'), b.on));
  });

  app.get('/approvals', async (c) => c.json(await approvals.inbox(db, c.get('actor'))));
  app.post('/approvals/:id/decide', async (c) => {
    const b = await body(c, z.object({ approve: z.boolean(), note: z.string().max(400).optional() }));
    return c.json(await approvals.decide(db, c.get('actor'), c.req.param('id'), b.approve, b.note ?? ''));
  });

  const refKind = z.enum(['homework', 'notice', 'leave', 'student', 'meeting', 'action', 'inspection']);
  app.post('/attachments', async (c) => {
    const b = await body(c, z.object({ refKind, refId: uuid, name: z.string().max(200), dataBase64: z.string().max(7_200_000) }));
    return c.json(await attachments.upload(db, c.get('actor'), b), 201);
  });
  app.get('/attachments', async (c) => c.json(await attachments.list(db, c.get('actor'), refKind.parse(c.req.query('refKind')), c.req.query('refId') ?? '')));
  app.get('/attachments/:id/file', async (c) => {
    const a = await attachments.download(db, c.get('actor'), c.req.param('id'));
    return c.body(Buffer.from(a.bytes), 200, {
      'content-type': a.content_type, 'content-disposition': `inline; filename="${a.name.replace(/"/g, '')}"`,
      'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'", 'cache-control': 'private, no-store',
    });
  });
  app.delete('/attachments/:id', async (c) => c.json(await attachments.remove(db, c.get('actor'), c.req.param('id'))));

  const csv = (c: Context, text: string, name: string) => c.body(text, 200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${name}"`, 'cache-control': 'no-store' });
  app.get('/export/students', async (c) => csv(c, await dataio.exportStudents(db, c.get('actor'), c.req.query('schoolId') ?? ''), 'students.csv'));
  app.get('/export/attendance', async (c) => {
    const month = c.req.query('month') ?? today().slice(0, 7);
    return csv(c, await dataio.attendanceRegister(db, c.get('actor'), c.req.query('sectionId') ?? '', month), `attendance-${month}.csv`);
  });
  app.get('/import/students/template', (c) => csv(c, dataio.IMPORT_TEMPLATE, 'students-import-template.csv'));
  app.post('/import/students/preview', async (c) => {
    const b = await body(c, z.object({ schoolId: uuid, year: z.string(), csv: z.string().max(3_000_000) }));
    return c.json(await dataio.previewStudents(db, c.get('actor'), b.schoolId, b.year, b.csv));
  });
  app.post('/import/students', async (c) => {
    const b = await body(c, z.object({ schoolId: uuid, year: z.string(), csv: z.string().max(3_000_000) }));
    return c.json(await dataio.importStudents(db, c.get('actor'), b.schoolId, b.year, b.csv), 201);
  });

  // ── Website builder ──
  app.get('/sites', async (c) => c.json(await site.list(db, c.get('actor'))));
  app.get('/schools/:id/site', async (c) => c.json(await site.draft(db, c.get('actor'), c.req.param('id'))));
  app.put('/schools/:id/site', async (c) => {
    const b = await body(c, z.object({ draftVersion: z.number().int(), doc: z.unknown() }));
    return c.json(await site.save(db, c.get('actor'), c.req.param('id'), b.draftVersion, b.doc));
  });
  app.post('/schools/:id/site/publish', async (c) => {
    const b = await body(c, z.object({ draftVersion: z.number().int(), note: z.string().max(200).default('') }));
    return c.json(await site.publish(db, c.get('actor'), c.req.param('id'), b.draftVersion, b.note));
  });
  app.get('/schools/:id/site/releases', async (c) => c.json(await site.releases(db, c.get('actor'), c.req.param('id'))));
  app.post('/schools/:id/site/restore', async (c) => {
    const b = await body(c, z.object({ version: z.number().int().positive(), draftVersion: z.number().int() }));
    return c.json(await site.restore(db, c.get('actor'), c.req.param('id'), b.version, b.draftVersion));
  });
  app.post('/schools/:id/site/start-from', async (c) => { const b = await body(c, z.object({ template: z.enum(['basic', 'full']), draftVersion: z.number().int() }));
    return c.json(await site.startFrom(db, c.get('actor'), c.req.param('id'), b.draftVersion, b.template)); });
  app.get('/schools/:id/site/assets', async (c) => c.json(await site.assets(db, c.get('actor'), c.req.param('id'))));
  app.post('/schools/:id/site/assets', async (c) => {
    const b = await body(c, z.object({ name: z.string().max(120), dataBase64: z.string().max(14_500_000) }));
    return c.json(await site.upload(db, c.get('actor'), c.req.param('id'), b), 201);
  });
  app.get('/schools/:id/site/enquiries', async (c) => c.json(await site.enquiries(db, c.get('actor'), c.req.param('id'))));
  app.post('/site-enquiries/:id/status', async (c) => {
    const b = await body(c, z.object({ status: z.enum(['NEW', 'REPLIED', 'CLOSED']) }));
    return c.json(await site.setEnquiryStatus(db, c.get('actor'), c.req.param('id'), b.status));
  });

  // ── Printing: printers, calibration, label sheets, school images, photos, staff details ──
  const pdfOut = (c: Context, buf: Buffer, name: string, headers: Record<string, string> = {}) =>
    c.body(new Uint8Array(buf), 200, { 'content-type': 'application/pdf', 'content-disposition': `inline; filename="${name}"`, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers });
  const image = (c: Context, a: { content_type: string; data: Buffer }) =>
    c.body(new Uint8Array(a.data), 200, { 'content-type': a.content_type, 'cache-control': 'private, max-age=300', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'" });
  const publicUrl = process.env.NES_PUBLIC_URL ?? 'http://localhost:5173';
  const purpose = z.enum(['LABELS', 'CARDS', 'DOCUMENTS']);
  app.get('/schools/:id/printers', async (c) => c.json(await printing.printers(db, c.get('actor'), c.req.param('id'))));
  app.post('/schools/:id/printers', async (c) => c.json(await printing.savePrinter(db, c.get('actor'), c.req.param('id'), await body(c, z.object({
    id: uuid.optional(), version: z.number().int().optional(), name: z.string().trim().min(2).max(60), purpose,
    offsetX: z.number().min(-25).max(25).optional(), offsetY: z.number().min(-25).max(25).optional(), scale: z.number().min(90).max(110).optional(), notes: z.string().max(300).optional() })))));
  app.delete('/printers/:id', async (c) => c.json(await printing.removePrinter(db, c.get('actor'), c.req.param('id'))));
  app.get('/schools/:id/printers/:printerId/calibration', async (c) => pdfOut(c, await printing.calibrationPdf(db, c.get('actor'), c.req.param('id'), c.req.param('printerId'),
    z.enum(['A4', 'CARD', 'LABEL']).parse(c.req.query('paper') ?? 'A4'), c.req.query('sheetId')), 'calibration.pdf'));
  app.get('/schools/:id/label-sheets', async (c) => c.json(await printing.labelSheets(db, c.get('actor'), c.req.param('id'))));
  app.post('/schools/:id/label-sheets', async (c) => c.json(await printing.addLabelSheet(db, c.get('actor'), c.req.param('id'), await body(c, z.object({
    name: z.string().trim().min(3).max(80), page_w: z.number().positive().max(500), page_h: z.number().positive().max(500), cols: z.number().int().min(1).max(10), rows: z.number().int().min(1).max(30),
    label_w: z.number().positive(), label_h: z.number().positive(), margin_left: z.number().min(0), margin_top: z.number().min(0), gap_x: z.number().min(0), gap_y: z.number().min(0) }))), 201));
  const assetKind = z.enum(['LOGO', 'SIGNATURE', 'STAMP', 'HPC_COVER']);
  app.get('/schools/:id/print-assets', async (c) => c.json(await printing.assetList(db, c.get('actor'), c.req.param('id'))));
  app.put('/schools/:id/print-assets/:kind', async (c) => c.json(await printing.setAsset(db, c.get('actor'), c.req.param('id'), assetKind.parse(c.req.param('kind')),
    (await body(c, z.object({ dataBase64: z.string().max(1_500_000) }))).dataBase64)));
  app.get('/schools/:id/print-assets/:kind/file', async (c) => image(c, await printing.assetFile(db, c.get('actor'), c.req.param('id'), assetKind.parse(c.req.param('kind')))));
  const ownerKind = z.enum(['STUDENT', 'STAFF']);
  app.put('/photos/:kind/:ownerId', async (c) => c.json(await printing.setPhoto(db, c.get('actor'), ownerKind.parse(c.req.param('kind')), c.req.param('ownerId'),
    (await body(c, z.object({ dataBase64: z.string().max(1_500_000) }))).dataBase64)));
  app.get('/photos/:kind/:ownerId', async (c) => image(c, await printing.photo(db, c.get('actor'), ownerKind.parse(c.req.param('kind')), c.req.param('ownerId'))));
  app.post('/schools/:id/photos/bulk', async (c) => {
    const b = await body(c, z.object({ kind: ownerKind, files: z.array(z.object({ name: z.string().max(120), dataBase64: z.string().max(1_500_000) })).min(1).max(60) }));
    return c.json(await printing.bulkPhotos(db, c.get('actor'), c.req.param('id'), b.kind, b.files));
  });
  app.get('/schools/:id/staff-details', async (c) => c.json(await printing.staffList(db, c.get('actor'), c.req.param('id'))));
  app.put('/schools/:id/staff-details/:userId', async (c) => c.json(await printing.saveStaff(db, c.get('actor'), c.req.param('id'), c.req.param('userId'), await body(c, z.object({
    employeeNo: z.string().trim().min(1).max(20), bloodGroup: z.string().nullable().optional(), phone: z.string().nullable().optional(), dob: date.nullable().optional(),
    joinedOn: date.nullable().optional(), emergencyContact: z.string().max(80).nullable().optional() })))));
  app.post('/schools/:id/staff-details/import', async (c) => c.json(await printing.importStaff(db, c.get('actor'), c.req.param('id'), (await body(c, z.object({ csv: z.string().max(5_000_000) }))).csv)));
  app.post('/sections/:id/roll-numbers', async (c) => c.json(await sections.assignRollNumbers(db, c.get('actor'), c.req.param('id'))));

  // ── Library ──
  const bookBody = z.object({ title: z.string().trim().min(1).max(300), author: z.string().max(200).optional(), publisher: z.string().max(200).optional(), edition: z.string().max(40).optional(),
    year: z.number().int().min(1800).max(2100).nullable().optional(), isbn: z.string().max(20).nullable().optional(), subject: z.string().max(80).optional(), language: z.string().max(40).optional(),
    callNumber: z.string().max(40).optional(), pricePaise: z.number().int().min(0).optional() });
  const copyBody = z.object({ copies: z.number().int().min(1).max(200), location: z.string().max(60).optional(), source: z.enum(['PURCHASE', 'DONATION', 'OTHER']).optional(), acquiredOn: date.optional() });
  app.get('/schools/:id/library/summary', async (c) => c.json(await library.summary(db, c.get('actor'), c.req.param('id'))));
  app.get('/schools/:id/library/books', async (c) => c.json(await library.search(db, c.get('actor'), c.req.param('id'), c.req.query('q') ?? '')));
  app.post('/schools/:id/library/books', async (c) => c.json(await library.addBook(db, c.get('actor'), c.req.param('id'), await body(c, bookBody.merge(copyBody))), 201));
  app.get('/library/books/:id', async (c) => c.json(await library.book(db, c.get('actor'), c.req.param('id'))));
  app.put('/library/books/:id', async (c) => c.json(await library.updateBook(db, c.get('actor'), c.req.param('id'), await body(c, bookBody))));
  app.post('/library/books/:id/copies', async (c) => c.json(await library.addCopies(db, c.get('actor'), c.req.param('id'), await body(c, copyBody)), 201));
  app.post('/library/copies/:id/status', async (c) => {
    const b = await body(c, z.object({ status: z.enum(['AVAILABLE', 'DAMAGED', 'WITHDRAWN']), location: z.string().max(60).optional() }));
    return c.json(await library.setCopyStatus(db, c.get('actor'), c.req.param('id'), b.status, b.location));
  });
  app.get('/schools/:id/library/borrower', async (c) => c.json(await library.borrower(db, c.get('actor'), c.req.param('id'), c.req.query('code') ?? '')));
  app.post('/schools/:id/library/issue', async (c) => c.json(await library.issue(db, c.get('actor'), c.req.param('id'), await body(c, z.object({ borrower: z.string().min(1).max(200), barcodes: z.array(z.string().min(1).max(200)).min(1).max(10) })))));
  app.post('/schools/:id/library/return', async (c) => c.json(await library.returnBook(db, c.get('actor'), c.req.param('id'), await body(c, z.object({ barcode: z.string().min(1).max(200), waive: z.string().max(200).nullable().optional() })))));
  app.post('/schools/:id/library/loans/:loanId/renew', async (c) => c.json(await library.renew(db, c.get('actor'), c.req.param('id'), c.req.param('loanId'))));
  app.post('/schools/:id/library/lost', async (c) => {
    const b = await body(c, z.object({ barcode: z.string().min(1).max(200), note: z.string().max(200).optional() }));
    return c.json(await library.markLost(db, c.get('actor'), c.req.param('id'), b.barcode, b.note ?? ''));
  });
  app.get('/schools/:id/library/overdue', async (c) => c.json(await library.overdue(db, c.get('actor'), c.req.param('id'))));
  app.get('/schools/:id/library/register', async (c) => {
    const rows = await library.register(db, c.get('actor'), c.req.param('id'));
    const heads = ['accession_no', 'barcode', 'acquired_on', 'title', 'author', 'publisher', 'edition', 'year', 'isbn', 'call_number', 'subject', 'language', 'price', 'source', 'location', 'status'];
    return csv(c, dataio.toCsv(heads.map((h) => h.replace(/_/g, ' ')), rows.map((r) => heads.map((h) => String(r[h] ?? '')))), 'accession-register.csv');
  });
  app.post('/schools/:id/library/labels', async (c) => {
    const b = await body(c, z.object({ copyIds: z.array(uuid).max(2000).optional(), unprinted: z.boolean().optional(), fromAccession: z.number().int().optional(), toAccession: z.number().int().optional(),
      sheetId: uuid, startAt: z.number().int().min(1).max(300).optional(), printerId: uuid.nullable().optional() }));
    const r = await library.labelsPdf(db, c.get('actor'), c.req.param('id'), b);
    return pdfOut(c, r.pdf, 'library-labels.pdf', { 'x-count': String(r.count), 'x-pages': String(r.pages) });
  });
  const mappingBody = z.record(z.string(), z.number().int().min(0).nullable()).optional();
  app.get('/library/import-template', (c) => csv(c, library.IMPORT_TEMPLATE, 'library-import-template.csv'));
  app.post('/schools/:id/library/import/preview', async (c) => {
    const b = await body(c, z.object({ csv: z.string().max(20_000_000), mapping: mappingBody }));
    return c.json(await library.previewImport(db, c.get('actor'), c.req.param('id'), b.csv, b.mapping));
  });
  app.post('/schools/:id/library/import', async (c) => {
    const b = await body(c, z.object({ csv: z.string().max(20_000_000), mapping: mappingBody }));
    return c.json(await library.importBooks(db, c.get('actor'), c.req.param('id'), b.csv, b.mapping));
  });
  app.post('/schools/:id/library/import-loans', async (c) => c.json(await library.importLoans(db, c.get('actor'), c.req.param('id'), (await body(c, z.object({ csv: z.string().max(5_000_000) }))).csv)));
  app.get('/students/:id/library', async (c) => c.json(await library.forStudent(db, c.get('actor'), c.req.param('id'))));
  app.get('/my/library', async (c) => c.json(await library.mine(db, c.get('actor'))));

  // ── ID cards ──
  const cardKind = z.enum(['STUDENT', 'STAFF']);
  app.get('/schools/:id/cards/:kind/design', async (c) => c.json(await cards.design(db, c.get('actor'), c.req.param('id'), cardKind.parse(c.req.param('kind')))));
  app.put('/schools/:id/cards/:kind/design', async (c) => {
    const b = await body(c, z.object({ design: z.unknown(), version: z.number().int().min(0) }));
    return c.json(await cards.saveDesign(db, c.get('actor'), c.req.param('id'), cardKind.parse(c.req.param('kind')), b.design, b.version));
  });
  app.get('/schools/:id/cards/:kind/status', async (c) => c.json(await cards.status(db, c.get('actor'), c.req.param('id'), cardKind.parse(c.req.param('kind')))));
  app.get('/schools/:id/cards/:kind/missing-photos', async (c) => c.json(await cards.missingPhotos(db, c.get('actor'), c.req.param('id'), cardKind.parse(c.req.param('kind')),
    c.req.query('sectionIds')?.split(',').filter(Boolean))));
  app.post('/schools/:id/cards/:kind/print', async (c) => {
    const b = await body(c, z.object({ sectionIds: z.array(uuid).optional(), ids: z.array(uuid).optional(), layout: z.enum(['CARD_PRINTER', 'A4', 'SHEET']), sheetId: uuid.nullable().optional(),
      sides: z.enum(['FRONT', 'BACK', 'BOTH']), printerId: uuid.nullable().optional(), onlyWithoutCard: z.boolean().optional(), preview: z.boolean().optional() }));
    const r = await cards.pdf(db, c.get('actor'), c.req.param('id'), { kind: cardKind.parse(c.req.param('kind')), ...b });
    return pdfOut(c, r.pdf, 'id-cards.pdf', { 'x-count': String(r.count), 'x-without-photo': String(r.withoutPhoto.length) });
  });

  // ── Certificates ──
  const certKind = z.enum(['TC', 'BONAFIDE', 'CHARACTER', 'STUDY', 'FEE_PAID', 'CEA']);
  app.get('/certificates/kinds', (c) => c.json(Object.fromEntries(Object.entries(certificates.KINDS).map(([k, v]) => [k, v.title]))));
  const certFilter = z.object({ kind: certKind.optional(), year: z.string().regex(/^\d{4}-\d{2}$/).optional(), classCode: z.string().max(10).optional(), sectionId: uuid.optional(),
    from: date.optional(), to: date.optional(), includeCancelled: z.boolean().optional() });
  app.get('/schools/:id/certificates', async (c) => {
    const q = c.req.query();
    const f = certFilter.parse({ kind: q.kind || undefined, year: q.year || undefined, classCode: q.classCode || undefined, sectionId: q.sectionId || undefined, from: q.from || undefined, to: q.to || undefined });
    return c.json(await certificates.list(db, c.get('actor'), c.req.param('id'), q.status || undefined, f));
  });
  app.post('/schools/:id/certificates/archive', async (c) => {
    const b = await body(c, z.object({ filter: certFilter, format: z.enum(['PDF', 'CSV', 'COUNT']) }));
    const r = await certificates.archive(db, c.get('actor'), c.req.param('id'), b.filter, b.format, publicUrl);
    if ('pdf' in r) return pdfOut(c, r.pdf!, 'certificates.pdf', { 'x-count': String(r.count) });
    if ('csv' in r) return csv(c, r.csv!, 'certificate-register.csv');
    return c.json(r);
  });
  app.post('/certificates/prepare', async (c) => c.json(await certificates.prepare(db, c.get('actor'), await body(c, z.object({
    requestId: uuid.optional(), studentId: uuid.optional(), kind: certKind.optional(), purpose: z.string().max(200).optional(), leavingDate: date.optional(), reason: z.string().max(200).optional(),
    fy: z.string().regex(/^\d{4}-\d{2}$/).optional(), year: z.string().regex(/^\d{4}-\d{2}$/).optional() }))), 201));
  app.post('/schools/:id/certificates/bulk', async (c) => c.json(await certificates.prepareBulk(db, c.get('actor'), c.req.param('id'), await body(c, z.object({
    kind: z.enum(['CEA', 'BONAFIDE']), sectionIds: z.array(uuid).min(1), year: z.string().regex(/^\d{4}-\d{2}$/).optional(), purpose: z.string().max(200).optional() }))), 201));
  app.post('/schools/:id/certificates/issue', async (c) => c.json(await certificates.issueBulk(db, c.get('actor'), c.req.param('id'), (await body(c, z.object({ ids: z.array(uuid).min(1).max(500) }))).ids)));
  app.post('/schools/:id/certificates/print', async (c) => {
    const b = await body(c, z.object({ ids: z.array(uuid).min(1).max(500), printerId: uuid.nullable().optional() }));
    const r = await certificates.pdfBulk(db, c.get('actor'), c.req.param('id'), b.ids, { printerId: b.printerId, publicUrl });
    return pdfOut(c, r.pdf, 'certificates.pdf', { 'x-count': String(r.count) });
  });
  app.get('/certificates/:id', async (c) => c.json(await certificates.one(db, c.get('actor'), c.req.param('id'))));
  app.put('/certificates/:id', async (c) => c.json(await certificates.update(db, c.get('actor'), c.req.param('id'), await body(c, z.object({
    data: z.record(z.string(), z.string().max(400)), purpose: z.string().max(200).optional() })))));
  app.post('/certificates/:id/submit', async (c) => c.json(await certificates.submit(db, c.get('actor'), c.req.param('id'))));
  app.post('/certificates/:id/reject', async (c) => c.json(await certificates.reject(db, c.get('actor'), c.req.param('id'), (await body(c, z.object({ reason: z.string().max(300) }))).reason)));
  app.post('/certificates/:id/cancel', async (c) => c.json(await certificates.cancel(db, c.get('actor'), c.req.param('id'), (await body(c, z.object({ reason: z.string().max(300) }))).reason)));
  app.get('/certificates/:id/pdf', async (c) => pdfOut(c, await certificates.pdf(db, c.get('actor'), c.req.param('id'), { printerId: c.req.query('printerId'), publicUrl }), 'certificate.pdf'));
  app.post('/students/:id/certificates', async (c) => {
    const b = await body(c, z.object({ kind: certKind, purpose: z.string().max(200), leavingDate: date.optional(), reason: z.string().max(200).optional(), destinationSchoolId: uuid.nullable().optional() }));
    return c.json(await certificates.request(db, c.get('actor'), { studentId: c.req.param('id'), ...b }), 201);
  });
  app.get('/students/:id/certificates', async (c) => c.json(await certificates.forStudent(db, c.get('actor'), c.req.param('id'))));

  // ── Staff, pay and leave (R4). Each school keeps its own staff and pays them its own way. ──
  const monthStart = z.string().regex(/^\d{4}-\d{2}-01$/, 'Use the first of the month.');
  const paise = z.number().int().min(0).max(10_000_000_00);
  const employment = z.enum(['PERMANENT', 'CONTRACT', 'TEMPORARY', 'PART_TIME', 'GUEST', 'DAILY_WAGE', 'DEPUTATION']);
  app.get('/staff/employment', (c) => c.json(staff.EMPLOYMENT));
  app.get('/schools/:id/staff-records', async (c) => c.json(await staff.directory(db, c.get('actor'), c.req.param('id'))));
  app.get('/schools/:id/staff-records/form', async (c) => c.json(await staff.formOptions(db, c.get('actor'), c.req.param('id'))));
  app.get('/schools/:id/staff-records/due', async (c) => c.json(await staff.dueSoon(db, c.get('actor'), c.req.param('id'))));
  const blood = z.enum(['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-']);
  app.post('/schools/:id/staff-records', async (c) => c.json(await staff.enrol(db, c.get('actor'), c.req.param('id'), await body(c, z.object({
    userId: uuid.optional(), name: z.string().min(2).max(120).optional(), title: z.string().max(80).optional(), category: z.enum(['TEACHING', 'NON_TEACHING']), employment,
    gender: z.enum(['F', 'M', 'X']).nullable().optional(), joinedService: date, contractUntil: date.nullable().optional(), probationUntil: date.nullable().optional(),
    retirementOn: date.nullable().optional(), orderRef: z.string().min(2).max(120),
    phone: z.string().max(16).nullable().optional(), email: z.string().email().max(120).nullable().optional(), dob: date.nullable().optional(), bloodGroup: blood.nullable().optional(),
    emergencyContact: z.string().max(120).nullable().optional(), employeeNo: z.string().max(20).nullable().optional(), postId: uuid.nullable().optional(),
    teaches: z.array(z.object({ sectionId: uuid, subjectCode: z.string().max(12), periodsPerWeek: z.number().int().min(1).max(12).optional() })).max(40).optional(),
    classTeacherOf: z.object({ sectionId: uuid, kind: z.enum(['CLASS', 'CO']) }).nullable().optional(), duties: z.array(z.string().max(30)).max(10).optional(),
    pay: z.object({ structureId: uuid, scaleId: uuid.nullable().optional(), step: z.number().int().min(1).max(60).nullable().optional(), basePaise: paise.nullable().optional(), from: date.optional() }).nullable().optional(),
    bank: z.object({ account: z.string().max(20), ifsc: z.string().max(11), bankName: z.string().max(80), holderName: z.string().max(120).optional() }).nullable().optional(),
    identity: z.object({ pan: z.string().max(10).optional(), aadhaar: z.string().max(14).optional(), uan: z.string().regex(/^\d{12}$/).nullable().optional(), esiNo: z.string().regex(/^\d{10,17}$/).nullable().optional() }).nullable().optional(),
  }))), 201));
  app.put('/staff/:id/teaching', async (c) => {
    const b = await body(c, z.object({ schoolId: uuid, rows: z.array(z.object({ sectionId: uuid, subjectCode: z.string().max(12), periodsPerWeek: z.number().int().min(1).max(12).optional() })).max(40) }));
    return c.json(await staff.assignTeaching(db, c.get('actor'), b.schoolId, c.req.param('id'), b.rows));
  });
  app.get('/staff/:id', async (c) => c.json(await staff.profile(db, c.get('actor'), c.req.param('id'))));
  app.put('/staff/:id', async (c) => c.json(await staff.updateDetails(db, c.get('actor'), c.req.param('id'), await body(c, z.object({
    name: z.string().min(2).max(120).optional(), phone: z.string().max(16).nullable().optional(), email: z.string().email().max(120).nullable().optional(), dob: date.nullable().optional(),
    bloodGroup: blood.nullable().optional(), emergencyContact: z.string().max(120).nullable().optional(), title: z.string().max(80).nullable().optional(), employeeNo: z.string().max(20).nullable().optional(),
    gender: z.enum(['F', 'M', 'X']).nullable().optional(), category: z.enum(['TEACHING', 'NON_TEACHING']).optional(), uan: z.string().regex(/^\d{12}$/).nullable().optional(),
    esiNo: z.string().regex(/^\d{10,17}$/).nullable().optional(), retirementOn: date.nullable().optional() })))));
  app.put('/staff/:id/identity', async (c) => c.json(await staff.setIdentity(db, c.get('actor'), c.req.param('id'), await body(c, z.object({
    pan: z.string().max(10).optional(), aadhaar: z.string().max(14).optional() })))));
  app.post('/staff/:id/identity/reveal', async (c) => {
    const b = await body(c, z.object({ field: z.enum(['PAN', 'AADHAAR']), purpose: z.string().min(5).max(200) }));
    return c.json(await staff.revealIdentity(db, c.get('actor'), c.req.param('id'), b.field, b.purpose));
  });
  app.post('/staff/:id/events', async (c) => c.json(await staff.addEvent(db, c.get('actor'), c.req.param('id'), await body(c, z.object({
    kind: z.string().max(30), onDate: date, summary: z.string().max(500), orderRef: z.string().max(120).nullable().optional(), corrects: uuid.nullable().optional(),
    contractUntil: date.nullable().optional(), toSchoolId: uuid.nullable().optional(), reason: z.string().max(200).nullable().optional() }))), 201));
  app.get('/schools/:id/posts', async (c) => c.json(await staff.posts(db, c.get('actor'), c.req.param('id'))));
  app.get('/post-types', async (c) => c.json(await staff.postTypes(db)));
  app.post('/schools/:id/posts', async (c) => c.json(await staff.addPost(db, c.get('actor'), c.req.param('id'), await body(c, z.object({
    postType: z.string().max(30), subjectCode: z.string().max(20).nullable().optional(), payLevel: z.number().int().min(1).max(18).nullable().optional(),
    from: date, orderRef: z.string().min(2).max(120), count: z.number().int().min(1).max(50).optional() }))), 201));
  app.post('/posts/:id/abolish', async (c) => c.json(await staff.abolishPost(db, c.get('actor'), c.req.param('id'), (await body(c, z.object({ onDate: date }))).onDate)));
  app.post('/posts/:id/appoint', async (c) => c.json(await staff.appoint(db, c.get('actor'), c.req.param('id'), await body(c, z.object({ userId: uuid, from: date, orderRef: z.string().min(2).max(120) }))), 201));
  app.post('/staff/:id/bank', async (c) => c.json(await staff.requestBank(db, c.get('actor'), c.req.param('id'), await body(c, z.object({
    account: z.string().max(20), ifsc: z.string().max(11), bankName: z.string().max(80), holderName: z.string().max(120) }))), 201));
  app.post('/staff-banks/:id/decide', async (c) => {
    const b = await body(c, z.object({ approve: z.boolean(), note: z.string().max(300).optional() }));
    return c.json(await staff.verifyBank(db, c.get('actor'), c.req.param('id'), b.approve, b.note));
  });
  app.get('/schools/:id/staff-banks', async (c) => c.json(await staff.pendingBanks(db, c.get('actor'), c.req.param('id'))));

  app.get('/schools/:id/pay-structures', async (c) => c.json(await staff.structures(db, c.get('actor'), c.req.param('id'))));
  const structureBody = z.object({ name: z.string().max(80), description: z.string().max(300).optional(), pf: z.enum(['NONE', 'CEILING', 'ACTUAL']), esi: z.boolean(), pt: z.boolean(), tds: z.boolean(),
    copyFrom: uuid.nullable().optional(), from: date.optional() });
  app.post('/schools/:id/pay-structures', async (c) => c.json(await staff.createStructure(db, c.get('actor'), c.req.param('id'), await body(c, structureBody)), 201));
  app.post('/pay-templates', async (c) => c.json(await staff.createStructure(db, c.get('actor'), null, await body(c, structureBody)), 201));
  app.post('/pay-structures/:id/components', async (c) => c.json(await staff.proposeComponent(db, c.get('actor'), c.req.param('id'), await body(c, z.object({
    code: z.string().max(30), name: z.string().max(80), kind: z.enum(['EARNING', 'DEDUCTION']), calc: z.enum(['BASE', 'PERCENT', 'FLAT', 'PER_UNIT']),
    percent: z.number().min(0).max(1000).nullable().optional(), ofCodes: z.array(z.string().max(30)).max(10).nullable().optional(), amountPaise: paise.nullable().optional(),
    unit: z.enum(['PERIODS', 'DAYS_PRESENT', 'HOURS']).nullable().optional(), taxable: z.boolean(), pfWage: z.boolean(), prorate: z.boolean(), ordinal: z.number().int().min(0).max(999), from: date }))), 201));
  app.post('/pay-components/:id/decide', async (c) => c.json(await staff.decideComponent(db, c.get('actor'), c.req.param('id'), (await body(c, z.object({ approve: z.boolean() }))).approve)));
  app.post('/schools/:id/pay-scales', async (c) => c.json(await staff.addScale(db, c.get('actor'), c.req.param('id'), await body(c, z.object({
    name: z.string().max(80), stepsPaise: z.array(paise).min(1).max(60), incrementMonth: z.number().int().min(1).max(12), from: date }))), 201));
  app.post('/pay-scales/:id/approve', async (c) => c.json(await staff.approveScale(db, c.get('actor'), c.req.param('id'))));
  app.post('/staff/:id/pay', async (c) => c.json(await staff.setPay(db, c.get('actor'), c.req.param('id'), await body(c, z.object({
    structureId: uuid, from: date, basePaise: paise.nullable().optional(), scaleId: uuid.nullable().optional(), step: z.number().int().min(1).max(60).nullable().optional(),
    orderRef: z.string().min(2).max(120), summary: z.string().max(300).optional() }))), 201));
  app.get('/schools/:id/increments', async (c) => c.json(await staff.incrementsDue(db, c.get('actor'), c.req.param('id'), c.req.query('month') ?? today().slice(0, 8) + '01')));
  app.post('/schools/:id/increments', async (c) => {
    const b = await body(c, z.object({ month: monthStart, userIds: z.array(uuid).min(1).max(500) }));
    return c.json(await staff.grantIncrements(db, c.get('actor'), c.req.param('id'), b.month, b.userIds));
  });
  app.post('/staff/:id/components', async (c) => c.json(await staff.addPersonComponent(db, c.get('actor'), c.req.param('id'), await body(c, z.object({
    code: z.string().max(30), name: z.string().max(80), kind: z.enum(['EARNING', 'DEDUCTION']), taxable: z.boolean(), amountPaise: paise, from: date, to: date.nullable().optional(), note: z.string().max(300) }))), 201));
  app.post('/staff-components/:id/approve', async (c) => c.json(await staff.approvePersonComponent(db, c.get('actor'), c.req.param('id'))));
  app.post('/staff/:id/loans', async (c) => c.json(await staff.proposeLoan(db, c.get('actor'), c.req.param('id'), await body(c, z.object({
    kind: z.enum(['FESTIVAL', 'SALARY_ADVANCE', 'SOCIETY', 'OTHER']), principalPaise: paise, instalmentPaise: paise, firstMonth: monthStart, note: z.string().max(300).optional() }))), 201));
  app.post('/staff-loans/:id/decide', async (c) => c.json(await staff.decideLoan(db, c.get('actor'), c.req.param('id'), (await body(c, z.object({ approve: z.boolean() }))).approve)));
  app.get('/schools/:id/staff-loans', async (c) => c.json(await staff.loans(db, c.get('actor'), c.req.param('id'))));

  app.get('/staff-leave/types', async (c) => c.json(await staffLeave.types(db)));
  app.get('/staff-leave/mine', async (c) => c.json(await staffLeave.mine(db, c.get('actor'))));
  app.post('/staff-leave', async (c) => c.json(await staffLeave.apply(db, c.get('actor'), await body(c, z.object({
    leaveCode: z.string().max(8), from: date, to: date, halfDay: z.boolean().optional(), reason: z.string().max(500), forUserId: uuid.optional() }))), 201));
  app.post('/staff-leave/:id/decide', async (c) => {
    const b = await body(c, z.object({ approve: z.boolean(), note: z.string().max(300).optional() }));
    return c.json(await staffLeave.decide(db, c.get('actor'), c.req.param('id'), b.approve, b.note));
  });
  app.post('/staff-leave/:id/cancel', async (c) => c.json(await staffLeave.cancel(db, c.get('actor'), c.req.param('id'))));
  app.get('/schools/:id/staff-leave', async (c) => c.json(await staffLeave.requests(db, c.get('actor'), c.req.param('id'), c.req.query('status'))));
  app.post('/schools/:id/staff-leave/credit', async (c) => c.json(await staffLeave.creditYear(db, c.get('actor'), c.req.param('id'), (await body(c, z.object({ year: z.number().int().min(2020).max(2100) }))).year)));
  app.get('/schools/:id/staff-register', async (c) => c.json(await staffLeave.register(db, c.get('actor'), c.req.param('id'), c.req.query('date') ?? today())));
  app.put('/schools/:id/staff-register', async (c) => {
    const b = await body(c, z.object({ date, entries: z.array(z.object({ userId: uuid, status: z.enum(['P', 'A', 'H', 'D']) })).max(500) }));
    return c.json(await staffLeave.mark(db, c.get('actor'), c.req.param('id'), b.date, b.entries));
  });

  app.get('/schools/:id/payroll', async (c) => c.json(await payroll.runs(db, c.get('actor'), c.req.param('id'))));
  app.post('/schools/:id/payroll', async (c) => c.json(await payroll.createRun(db, c.get('actor'), c.req.param('id'), (await body(c, z.object({ month: monthStart }))).month), 201));
  app.post('/schools/:id/payroll/arrears', async (c) => c.json(await payroll.arrears(db, c.get('actor'), c.req.param('id'), (await body(c, z.object({ fromMonth: monthStart }))).fromMonth), 201));
  app.get('/schools/:id/payroll-inputs', async (c) => c.json(await payroll.inputsNeeded(db, c.get('actor'), c.req.param('id'), c.req.query('month') ?? today().slice(0, 8) + '01')));
  app.put('/schools/:id/payroll-inputs', async (c) => {
    const b = await body(c, z.object({ month: monthStart, entries: z.array(z.object({ userId: uuid, unit: z.enum(['PERIODS', 'HOURS', 'DAYS_PRESENT']), quantity: z.number().min(0).max(1000), note: z.string().max(200).optional() })).max(500) }));
    return c.json(await payroll.setInputs(db, c.get('actor'), c.req.param('id'), b.month, b.entries));
  });
  app.post('/schools/:id/challans', async (c) => c.json(await payroll.recordChallan(db, c.get('actor'), c.req.param('id'), await body(c, z.object({
    kind: z.enum(['PF', 'ESI', 'PT', 'TDS']), period: monthStart, amountPaise: paise, reference: z.string().max(60), paidOn: date }))), 201));
  app.post('/staff/:id/final-settlement', async (c) => c.json(await payroll.finalSettlement(db, c.get('actor'), c.req.param('id')), 201));
  app.get('/payroll/:id', async (c) => c.json(await payroll.run(db, c.get('actor'), c.req.param('id'))));
  app.post('/payroll/:id/recompute', async (c) => c.json(await payroll.recompute(db, c.get('actor'), c.req.param('id'))));
  app.delete('/payroll/:id', async (c) => c.json(await payroll.discard(db, c.get('actor'), c.req.param('id'))));
  app.post('/payroll/:id/submit', async (c) => c.json(await payroll.submit(db, c.get('actor'), c.req.param('id'))));
  app.post('/payroll/:id/send-back', async (c) => c.json(await payroll.sendBack(db, c.get('actor'), c.req.param('id'), (await body(c, z.object({ note: z.string().min(3).max(300) }))).note)));
  app.post('/payroll/:id/approve', async (c) => c.json(await payroll.approve(db, c.get('actor'), c.req.param('id'))));
  app.post('/payroll/:id/paid', async (c) => c.json(await payroll.markPaid(db, c.get('actor'), c.req.param('id'), (await body(c, z.object({ bankRef: z.string().max(60) }))).bankRef)));
  app.get('/payroll/:id/bank-file', async (c) => { const r = await payroll.bankFile(db, c.get('actor'), c.req.param('id')); return csv(c, r.csv, 'salary-bank-file.csv'); });
  app.get('/payroll/:id/pf-ecr', async (c) => { const r = await payroll.pfEcr(db, c.get('actor'), c.req.param('id')); return c.body(r.text, 200, { 'content-type': 'text/plain; charset=utf-8', 'content-disposition': 'attachment; filename="pf-ecr.txt"', 'x-missing-uan': String(r.missingUan.length) }); });
  app.get('/payroll/:id/statutory', async (c) => c.json(await payroll.statutorySummary(db, c.get('actor'), c.req.param('id'))));
  app.get('/payroll/:id/slips/:userId', async (c) => c.json(await payroll.slip(db, c.get('actor'), c.req.param('id'), c.req.param('userId'))));
  app.get('/payroll/:id/slips/:userId/pdf', async (c) => pdfOut(c, await payroll.slipPdf(db, c.get('actor'), c.req.param('id'), c.req.param('userId')), 'payslip.pdf'));
  app.get('/payroll/:id/slips.pdf', async (c) => pdfOut(c, await payroll.slipsPdf(db, c.get('actor'), c.req.param('id')), 'payslips.pdf'));
  app.get('/my/pay', async (c) => c.json(await payroll.myPay(db, c.get('actor'))));
  app.put('/my/tax-declaration', async (c) => c.json(await payroll.setDeclaration(db, c.get('actor'), await body(c, z.object({
    regime: z.enum(['NEW', 'OLD']), items: z.record(z.string(), z.number().int().min(0).max(100_000_000_00)).optional() })))));
  app.get('/staff/:id/tax/:fy', async (c) => c.json(await payroll.annualTax(db, c.get('actor'), c.req.param('id'), c.req.param('fy'))));
  app.get('/staff/:id/form16/:fy', async (c) => pdfOut(c, await payroll.form16Pdf(db, c.get('actor'), c.req.param('id'), c.req.param('fy')), 'form16-part-b.pdf'));
  app.get('/schools/:id/tds-return', async (c) => {
    const q = c.req.query('quarter') as 'Q1' | 'Q2' | 'Q3' | 'Q4';
    if (!['Q1', 'Q2', 'Q3', 'Q4'].includes(q)) throw new AppError(422, 'invalid', 'Choose a quarter.');
    const r = await payroll.tdsReturn(db, c.get('actor'), c.req.param('id'), c.req.query('fy') ?? currentYear(), q);
    return c.body(r.csv, 200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="form24q-${q}.csv"`, 'cache-control': 'no-store',
      'x-shortfall': String(r.shortfall), 'x-pan-missing': String(r.panMissing), 'x-tan-missing': String(r.tanMissing) });
  });
  app.get('/pay/overview', async (c) => c.json(await payroll.overview(db, c.get('actor'))));

  // ── Transport (stop times by default; GPS optional) ──
  const hm = z.string().regex(/^\d{2}:\d{2}$/, 'Use HH:MM.');
  const leg = z.enum(['MORNING', 'AFTERNOON']);
  app.get('/schools/:id/transport', async (c) => c.json(await transport.overview(db, c.get('actor'), c.req.param('id'))));
  app.get('/schools/:id/transport/today', async (c) => c.json(await transport.today(db, c.get('actor'), c.req.param('id'))));
  app.post('/schools/:id/vehicles', async (c) => c.json(await transport.saveVehicle(db, c.get('actor'), c.req.param('id'), await body(c, z.object({
    id: uuid.optional(), regNo: z.string().max(16), kind: z.enum(['BUS', 'MINIBUS', 'VAN']), seats: z.number().int().min(4).max(80), owner: z.enum(['SCHOOL', 'CONTRACTOR', 'NAVY']), contractor: z.string().max(120).nullable().optional(),
    fitnessUntil: date.nullable().optional(), insuranceUntil: date.nullable().optional(), permitUntil: date.nullable().optional(), pucUntil: date.nullable().optional(), gpsDevice: z.string().max(60).nullable().optional(), active: z.boolean().optional() })))));
  app.post('/schools/:id/transport-crew', async (c) => c.json(await transport.saveCrew(db, c.get('actor'), c.req.param('id'), await body(c, z.object({
    id: uuid.optional(), userId: uuid.nullable().optional(), name: z.string().max(120).nullable().optional(), phone: z.string().max(16).nullable().optional(), role: z.enum(['DRIVER', 'ATTENDANT']),
    licenceNo: z.string().max(30).nullable().optional(), licenceUntil: date.nullable().optional(), policeVerifiedOn: date.nullable().optional(), active: z.boolean().optional() })))));
  app.post('/schools/:id/transport-fares', async (c) => c.json(await transport.setFare(db, c.get('actor'), c.req.param('id'), await body(c, z.object({
    zone: z.string().max(6), name: z.string().max(80), monthlyPaise: z.number().int().min(0).max(10_000_000), from: date })))));
  app.post('/schools/:id/routes', async (c) => c.json(await transport.saveRoute(db, c.get('actor'), c.req.param('id'), await body(c, z.object({
    id: uuid.optional(), code: z.string().max(10), name: z.string().max(80), vehicleId: uuid.nullable().optional(), driverId: uuid.nullable().optional(), attendantId: uuid.nullable().optional(),
    tracking: z.enum(['TIMES', 'TAPS', 'PHONE', 'DEVICE']).optional(), active: z.boolean().optional() })))));
  app.put('/routes/:id/stops', async (c) => c.json(await transport.saveStops(db, c.get('actor'), c.req.param('id'), (await body(c, z.object({ stops: z.array(z.object({
    id: uuid.optional(), name: z.string().max(80), landmark: z.string().max(120).nullable().optional(), morning: hm.nullable().optional(), afternoon: hm.nullable().optional(), fareZone: z.string().max(6) })).min(1).max(60) }))).stops)));
  app.get('/routes/:id/roster', async (c) => c.json(await transport.roster(db, c.get('actor'), c.req.param('id'), c.req.query('date') ?? today())));
  app.post('/routes/:id/events', async (c) => c.json(await transport.tripEvent(db, c.get('actor'), c.req.param('id'), await body(c, z.object({
    leg, kind: z.enum(['STARTED', 'AT_STOP', 'DELAY', 'REACHED', 'CANCELLED', 'BREAKDOWN']), stopId: uuid.nullable().optional(), minutes: z.number().int().min(1).max(240).optional(), note: z.string().max(200).optional(), atTime: hm.optional(), lat: z.number().min(-90).max(90).optional(), lng: z.number().min(-180).max(180).optional() })))));
  app.post('/routes/:id/boarding', async (c) => c.json(await transport.board(db, c.get('actor'), c.req.param('id'), await body(c, z.object({
    leg, entries: z.array(z.object({ studentId: uuid, status: z.enum(['BOARDED', 'DROPPED', 'NOT_BOARDED', 'HANDED_TO_PARENT']) })).max(80) })))));
  app.post('/routes/:id/position', async (c) => c.json(await transport.position(db, c.get('actor'), c.req.param('id'), await body(c, z.object({ leg, lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) })))));
  app.post('/vehicles/:id/tracker-token', async (c) => c.json(await transport.trackerToken(db, c.get('actor'), c.req.param('id'))));
  app.post('/transport/allocate', async (c) => c.json(await transport.allocate(db, c.get('actor'), await body(c, z.object({ studentId: uuid, pickupStopId: uuid.nullable().optional(), dropStopId: uuid.nullable().optional(), from: date })))));
  app.post('/transport/stop', async (c) => { const b = await body(c, z.object({ studentId: uuid, from: date })); return c.json(await transport.stopTransport(db, c.get('actor'), b.studentId, b.from)); });
  app.post('/transport/requests', async (c) => c.json(await transport.request(db, c.get('actor'), await body(c, z.object({
    studentId: uuid, kind: z.enum(['START', 'CHANGE', 'STOP']), pickupStopId: uuid.nullable().optional(), dropStopId: uuid.nullable().optional(), fromDate: date, note: z.string().max(300).optional() }))), 201));
  app.post('/transport/requests/:id/decide', async (c) => { const b = await body(c, z.object({ approve: z.boolean(), note: z.string().max(300).optional() })); return c.json(await transport.decideRequest(db, c.get('actor'), c.req.param('id'), b.approve, b.note)); });
  app.get('/my/bus', async (c) => c.json(await transport.myBus(db, c.get('actor'))));
  app.get('/students/:id/bus', async (c) => c.json(await transport.forParent(db, c.get('actor'), c.req.param('id'))));

  // ── Accounts: the school's books, bank reconciliation, reports (NES and Commands see them added up) ──
  app.post('/schools/:id/bank-statements', async (c) => c.json(await accounts.importStatement(db, c.get('actor'), c.req.param('id'), await body(c, z.object({ bankLabel: z.string().max(80), csv: z.string().max(5_000_000) }))), 201));
  app.get('/schools/:id/bank-lines', async (c) => c.json(await accounts.bankLines(db, c.get('actor'), c.req.param('id'), c.req.query('status') ?? 'UNMATCHED')));
  app.post('/bank-lines/:id/match', async (c) => c.json(await accounts.matchLine(db, c.get('actor'), c.req.param('id'), (await body(c, z.object({ journalId: uuid }))).journalId)));
  app.post('/bank-lines/:id/post', async (c) => c.json(await accounts.postLine(db, c.get('actor'), c.req.param('id'), await body(c, z.object({ kind: z.enum(['GATEWAY', 'CHARGES', 'INTEREST', 'CASH_DEPOSIT']), chargesPaise: z.number().int().min(0).optional() })))));
  app.post('/bank-lines/:id/ignore', async (c) => c.json(await accounts.ignoreLine(db, c.get('actor'), c.req.param('id'), (await body(c, z.object({ note: z.string().max(300) }))).note)));
  app.get('/schools/:id/reconciliation', async (c) => c.json(await accounts.reconciliation(db, c.get('actor'), c.req.param('id'), c.req.query('on') ?? today())));
  app.get('/units/:id/income-expenditure', async (c) => {
    const r = await accounts.incomeExpenditure(db, c.get('actor'), c.req.param('id'), c.req.query('from') ?? `${currentYear().slice(0, 4)}-04-01`, c.req.query('to') ?? today());
    if (c.req.query('format') === 'csv') return csv(c, accounts.toCsv(['Code', 'Account', 'Type', ...r.schools.map((s) => s.name), 'Total (Rs)'],
      [...r.income, ...r.expenditure].map((a) => [a.code, a.name, a.type, ...r.schools.map((s) => ((a.bySchool[s.id] ?? 0) / 100).toFixed(2)), (a.total / 100).toFixed(2)])), 'income-expenditure.csv');
    return c.json(r);
  });
  app.get('/units/:id/balance-sheet', async (c) => c.json(await accounts.balanceSheet(db, c.get('actor'), c.req.param('id'), c.req.query('on') ?? today())));
  app.get('/schools/:id/books/:code', async (c) => {
    const r = await accounts.accountBook(db, c.get('actor'), c.req.param('id'), c.req.param('code'), c.req.query('from') ?? `${currentYear().slice(0, 4)}-04-01`, c.req.query('to') ?? today());
    if (c.req.query('format') === 'csv') return csv(c, accounts.toCsv(['Date', 'Particulars', 'Debit (Rs)', 'Credit (Rs)', 'Balance (Rs)'],
      [['', 'Opening balance', '', '', (r.opening / 100).toFixed(2)], ...r.lines.map((l) => [l.on_date, l.narration, l.debit ? (l.debit / 100).toFixed(2) : '', l.credit ? (l.credit / 100).toFixed(2) : '', (l.balance / 100).toFixed(2)])]), `${r.code}-book.csv`);
    return c.json(r);
  });

  // ── Help (every user), the support desk, fixes and the message log ──
  const ticketBody = z.object({ category: z.enum(['PROBLEM', 'DATA', 'REQUEST', 'ACCESS']), module: z.string().max(30).optional(), title: z.string().min(4).max(160),
    description: z.string().min(10).max(5000), severity: z.enum(['LOW', 'NORMAL', 'HIGH', 'URGENT']).optional(), page: z.string().max(300).optional(),
    refs: z.array(z.object({ entityType: z.enum(['STUDENT', 'GUARDIAN', 'STAFF', 'PAYROLL_RUN', 'ROUTE', 'SCHOOL', 'VACANCY', 'APPLICATION']), entityId: uuid, field: z.string().max(30).optional(), correctValue: z.string().max(300).optional() })).max(5).optional() });
  app.get('/help/modules', (c) => c.json(support.MODULES));
  app.post('/help/tickets', async (c) => c.json(await support.createTicket(db, c.get('actor'), await body(c, ticketBody)), 201));
  app.get('/help/tickets', async (c) => c.json(await support.myTickets(db, c.get('actor'))));
  app.get('/help/tickets/:number', async (c) => c.json(await support.ticket(db, c.get('actor'), c.req.param('number'))));
  app.post('/help/tickets/:number/reopen', async (c) => c.json(await support.reopen(db, c.get('actor'), c.req.param('number'), (await body(c, z.object({ reason: z.string().min(5).max(2000) }))).reason)));
  app.post('/help/tickets/:number/rate', async (c) => c.json(await support.rate(db, c.get('actor'), c.req.param('number'), (await body(c, z.object({ rating: z.number().int().min(1).max(5) }))).rating)));
  app.get('/support/tickets', async (c) => c.json(await support.deskList(db, c.get('actor'), { status: c.req.query('status'), category: c.req.query('category'), module: c.req.query('module'), agent: c.req.query('agent'), sort: c.req.query('sort'), search: c.req.query('q') })));
  app.get('/support/tickets/:number', async (c) => c.json(await support.ticket(db, c.get('actor'), c.req.param('number'))));
  app.post('/support/tickets/:number/take', async (c) => c.json(await support.deskTake(db, c.get('actor'), c.req.param('number'))));
  app.post('/support/tickets/:number/note', async (c) => c.json(await support.deskNote(db, c.get('actor'), c.req.param('number'), (await body(c, z.object({ body: z.string().min(2).max(5000) }))).body)));
  app.post('/support/tickets/:number/triage', async (c) => c.json(await support.deskTriage(db, c.get('actor'), c.req.param('number'), await body(c, z.object({
    category: z.enum(['PROBLEM', 'DATA', 'REQUEST', 'ACCESS']).optional(), module: z.string().max(30).optional(), severity: z.enum(['LOW', 'NORMAL', 'HIGH', 'URGENT']).optional(),
    summary: z.string().max(1000).optional(), needsDeveloper: z.boolean().optional(), reason: z.string().max(500).optional() })))));
  app.post('/support/tickets/:number/proposals', async (c) => c.json(await support.deskPropose(db, c.get('actor'), c.req.param('number'), await body(c, z.object({
    kind: z.enum(['DATA_CORRECTION', 'REPAIR', 'SETTING', 'CODE_CHANGE']), ref: z.string().max(20).optional(), field: z.string().max(60).optional(), newValue: z.string().max(500).optional(),
    action: z.string().max(40).optional(), summary: z.string().min(5).max(300), details: z.string().max(20000).optional(), risk: z.enum(['LOW', 'MEDIUM', 'HIGH']).optional() }))), 201));
  app.post('/support/tickets/:number/resolve', async (c) => c.json(await support.deskResolve(db, c.get('actor'), c.req.param('number'), (await body(c, z.object({ resolution: z.string().min(5).max(2000) }))).resolution)));
  app.post('/support/tickets/:number/reject', async (c) => c.json(await support.deskReject(db, c.get('actor'), c.req.param('number'), (await body(c, z.object({ reason: z.string().min(5).max(2000) }))).reason)));
  app.get('/support/catalog', async (c) => c.json(await support.catalog()));
  app.get('/support/ai', async (c) => c.json({ on: await support.aiEnabled(db) }));
  app.post('/support/ai', async (c) => c.json(await support.setAi(db, c.get('actor'), (await body(c, z.object({ on: z.boolean() }))).on)));
  app.post('/support/tickets/:number/developer', async (c) => { const b = await body(c, z.object({ approve: z.boolean(), note: z.string().max(1000) })); return c.json(await support.developerDecide(db, c.get('actor'), c.req.param('number'), b.approve, b.note)); });
  app.get('/support/agent-stats', async (c) => c.json(await support.agentStats(db, c.get('actor'))));
  app.get('/support/agents', async (c) => c.json(await support.agents(db, c.get('actor'))));
  app.post('/support/agents', async (c) => c.json(await support.createAgent(db, c.get('actor'), await body(c, z.object({ name: z.string().min(2).max(60), kind: z.enum(['AI', 'HUMAN', 'DEVELOPER']), userId: uuid.nullable().optional(),
    scopes: z.array(z.enum(['READ', 'REPLY', 'PROPOSE'])).optional() }))), 201));
  app.post('/support/agents/:id/rotate', async (c) => c.json(await support.rotateAgent(db, c.get('actor'), c.req.param('id'))));
  app.post('/support/agents/:id/active', async (c) => c.json(await support.setAgentActive(db, c.get('actor'), c.req.param('id'), (await body(c, z.object({ active: z.boolean() }))).active)));
  app.get('/fixes/pending', async (c) => c.json(await support.approvals(db, c.get('actor'))));
  app.post('/fixes/:number/decide', async (c) => { const b = await body(c, z.object({ approve: z.boolean(), note: z.string().max(1000).optional() })); return c.json(await support.decideFix(db, c.get('actor'), c.req.param('number'), b.approve, b.note)); });
  app.get('/message-log', async (c) => c.json(await messagesMod.log(db, c.get('actor'), { schoolId: c.req.query('schoolId'), to: c.req.query('to'), context: c.req.query('context'), status: c.req.query('status'), refType: c.req.query('refType'), refId: c.req.query('refId') })));

  // ── Recruitment: the candidate's own profile and applications ──
  const edu = z.object({ level: z.enum(['SECONDARY', 'SR_SECONDARY', 'DIPLOMA', 'GRADUATION', 'POST_GRADUATION', 'BED', 'DELED', 'NTT', 'MED', 'MPHIL', 'PHD', 'OTHER']), degree: z.string().min(2).max(80),
    subjects: z.array(z.string().max(40)).max(8), institution: z.string().max(120).optional(), year: z.number().int().min(1960).max(2100).optional(), percentage: z.number().min(0).max(100).nullable().optional(), status: z.enum(['PASSED', 'APPEARING']).optional() });
  app.get('/candidate/profile', async (c) => c.json(await recruitment.myProfile(db, c.get('actor'))));
  app.put('/candidate/profile', async (c) => c.json(await recruitment.updateProfile(db, c.get('actor'), await body(c, z.object({ name: z.string().min(3).max(80), fatherName: z.string().max(80), motherName: z.string().max(80), spouseName: z.string().max(80),
    dob: date, gender: z.enum(['F', 'M', 'X']), category: z.enum(['GEN', 'OBC', 'SC', 'ST', 'EWS']), pwd: z.boolean(), pwdType: z.string().max(60).nullable(), exServiceman: z.boolean(),
    navyRelation: z.enum(['NONE', 'NAVY_SERVING', 'NAVY_RETIRED', 'NAVY_SPOUSE', 'NAVY_WARD', 'DEF_CIVILIAN']), nationality: z.string().max(40), address: z.string().max(300), city: z.string().max(60), state: z.string().max(60),
    pincode: z.string().regex(/^[1-9][0-9]{5}$/), aadhaar: z.string().max(14) }).partial()))));
  app.put('/candidate/qualifications', async (c) => c.json(await recruitment.setQualifications(db, c.get('actor'), await body(c, z.object({ education: z.array(edu).max(15).optional(),
    tests: z.array(z.object({ kind: z.enum(['CTET', 'STET', 'TET', 'NET', 'SET', 'OTHER']), paper: z.string().max(40).optional(), year: z.number().int().optional(), score: z.number().min(0).max(1000).nullable().optional(), qualified: z.boolean().optional(), validUntil: date.nullable().optional() })).max(10).optional(),
    experience: z.array(z.object({ organisation: z.string().min(2).max(120), post: z.string().min(2).max(80), subject: z.string().max(60).optional(), fromDate: date, toDate: date.nullable().optional(), teaching: z.boolean().optional(), cbse: z.boolean().optional() })).max(20).optional() })))));
  app.post('/candidate/documents', async (c) => c.json(await recruitment.uploadDocument(db, c.get('actor'), await body(c, z.object({ kind: z.enum(['PHOTO', 'SIGNATURE', 'THUMB', 'ID_PROOF', 'EDUCATION', 'CATEGORY', 'PWD', 'ESM', 'EXPERIENCE', 'TEST', 'OTHER']), refKey: z.string().regex(/^[A-Z_]{2,20}$/).optional(),
    name: z.string().min(1).max(120), contentType: z.enum(['image/jpeg', 'image/png', 'application/pdf']), dataBase64: z.string().max(3_000_000) }))), 201));
  app.delete('/candidate/documents/:id', async (c) => c.json(await recruitment.deleteDocument(db, c.get('actor'), c.req.param('id'))));
  const doc = async (c: Context) => { const d = await recruitment.document(db, c.get('actor'), c.req.param('id')!); return c.body(new Uint8Array(d.data), 200, { 'content-type': d.content_type, 'content-disposition': `inline; filename="${d.name.replace(/[^\w.-]/g, '_')}"`, 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'" }); };
  app.get('/candidate/documents/:id', doc);
  app.get('/candidate/vacancies/:id/check', async (c) => c.json(await recruitment.checkEligibility(db, c.get('actor'), c.req.param('id'))));
  app.post('/candidate/vacancies/:id/apply', async (c) => c.json(await recruitment.apply(db, c.get('actor'), c.req.param('id'), { ...(await body(c, z.object({ answers: z.record(z.string(), z.string().max(2000)).optional(), declaration: z.boolean() }))),
    from: c.req.header('x-forwarded-for')?.split(',')[0].trim() || 'local' }), 201));
  app.get('/candidate/applications', async (c) => c.json(await recruitment.myApplications(db, c.get('actor'))));
  app.post('/candidate/applications/:id/pay', async (c) => c.json(await recruitment.payFee(db, c.get('actor'), c.req.param('id'))));
  app.post('/candidate/payments/:id/sandbox', async (c) => c.json(await recruitment.capturePayment(db, c.get('actor'), c.req.param('id'), (await body(c, z.object({ outcome: z.enum(['success', 'failure']) }))).outcome)));
  app.post('/candidate/applications/:id/withdraw', async (c) => c.json(await recruitment.withdraw(db, c.get('actor'), c.req.param('id'))));
  app.post('/candidate/interviews/:id/confirm', async (c) => c.json(await recruitment.confirmInterview(db, c.get('actor'), c.req.param('id'))));

  // ── Recruitment: the school ──
  const filter = z.object({ status: z.array(z.string()).optional(), category: z.array(z.string()).optional(), gender: z.enum(['F', 'M', 'X']).optional(), pwd: z.boolean().optional(), exServiceman: z.boolean().optional(),
    navyRelation: z.array(z.string()).optional(), minQualPct: z.number().optional(), minTestScore: z.number().optional(), minExperienceMonths: z.number().int().optional(), maxAge: z.number().optional(), minAge: z.number().optional(),
    city: z.string().max(60).optional(), search: z.string().max(80).optional(), tag: z.string().max(30).optional(), feePaid: z.boolean().optional(), ids: z.array(uuid).max(5000).optional(), hasCwtMarks: z.boolean().optional(), minCwtMarks: z.number().optional() });
  const rules = z.object({ education: z.array(z.object({ levels: z.array(z.string()).min(1), subjects: z.array(z.string()).optional(), minPct: z.number().min(0).max(100).optional(), label: z.string().max(120).optional() })).optional(),
    tests: z.array(z.object({ kind: z.string(), paper: z.string().optional() })).optional(), age: z.object({ min: z.number().optional(), max: z.number().optional(), relax: z.record(z.string(), z.number()).optional() }).optional(),
    experienceMonths: z.number().int().optional(), gender: z.enum(['F', 'M']).nullable().optional(), minPctRelaxReserved: z.number().optional() });
  const vacancyBody = z.object({ postId: uuid.nullable().optional(), postType: z.string(), subjectCode: z.string().nullable().optional(), title: z.string().max(120).optional(), employment: z.string(), positions: z.number().int().min(1).max(500).optional(),
    payText: z.string().max(200).optional(), description: z.string().max(10000).optional(), eligibility: rules.optional(), fees: z.record(z.string(), z.number().int().min(0).nullable()).optional(),
    questions: z.array(z.object({ id: z.string().max(20), label: z.string().max(200), type: z.enum(['YESNO', 'TEXT', 'CHOICE']), options: z.array(z.string()).optional(), required: z.boolean().optional() })).max(10).optional(),
    weights: z.object({ cwt: z.number(), interview: z.number(), academic: z.number() }).optional(), declaration: z.string().max(3000).optional(), opensOn: date, closesOn: date, ageAsOn: date.optional(), cwt: z.boolean().optional(), interview: z.boolean().optional() });
  app.get('/recruitment/template', (c) => c.json(recruitment.templateFor(c.req.query('postType') ?? 'TGT', c.req.query('subject'))));
  app.get('/schools/:id/vacancies', async (c) => c.json(await recruitment.schoolVacancies(db, c.get('actor'), c.req.param('id'))));
  app.post('/schools/:id/vacancies', async (c) => c.json(await recruitment.createVacancy(db, c.get('actor'), c.req.param('id'), await body(c, vacancyBody)), 201));
  app.put('/vacancies/:id', async (c) => c.json(await recruitment.updateVacancy(db, c.get('actor'), c.req.param('id'), await body(c, vacancyBody.partial()))));
  app.post('/vacancies/:id/publish', async (c) => c.json(await recruitment.publishVacancy(db, c.get('actor'), c.req.param('id'))));
  app.post('/vacancies/:id/status', async (c) => c.json(await recruitment.setVacancyStatus(db, c.get('actor'), c.req.param('id'), (await body(c, z.object({ status: z.enum(['CLOSED', 'CANCELLED', 'FILLED']) }))).status)));
  app.get('/vacancies/:id/stats', async (c) => c.json(await recruitment.stats(db, c.get('actor'), c.req.param('id'))));
  app.post('/vacancies/:id/applications', async (c) => { const b = await body(c, z.object({ filter, sort: z.string().optional(), page: z.number().int().min(1).optional(), size: z.number().int().optional() }));
    return c.json(await recruitment.applications(db, c.get('actor'), c.req.param('id'), b.filter, b.sort, b.page, b.size)); });
  app.post('/vacancies/:id/export', async (c) => { const b = await body(c, z.object({ filter, sort: z.string().optional() })); return csv(c, await recruitment.exportCsv(db, c.get('actor'), c.req.param('id'), b.filter, b.sort), 'applications.csv'); });
  app.post('/vacancies/:id/bulk', async (c) => c.json(await recruitment.bulkAction(db, c.get('actor'), c.req.param('id'), await body(c, z.object({ filter, action: z.string(), note: z.string().max(500).optional(), notify: z.boolean().optional(), tag: z.string().max(30).optional() })))));
  app.post('/vacancies/:id/message', async (c) => c.json(await recruitment.sendMessage(db, c.get('actor'), c.req.param('id'), await body(c, z.object({ filter, subject: z.string().min(3).max(120), message: z.string().min(5).max(2000), channels: z.array(z.enum(['EMAIL', 'SMS'])).min(1) })))));
  app.post('/vacancies/:id/rounds', async (c) => c.json(await recruitment.scheduleRound(db, c.get('actor'), c.req.param('id'), await body(c, z.object({ kind: z.enum(['INTERVIEW', 'DEMO', 'DOCUMENTS']), title: z.string().min(3).max(80), date,
    start: z.string().regex(/^\d{2}:\d{2}$/), slotMinutes: z.number().int().min(5).max(240), perSlot: z.number().int().min(1).max(50).optional(), venue: z.string().min(3).max(200), bring: z.string().max(300).optional(), filter }))), 201));
  app.post('/interview-slots/:id/mark', async (c) => c.json(await recruitment.markSlot(db, c.get('actor'), c.req.param('id'), await body(c, z.object({ status: z.enum(['ATTENDED', 'ABSENT']), marks: z.number().min(0).max(100).nullable().optional(), note: z.string().max(500).optional() })))));
  app.get('/job-applications/:id', async (c) => c.json(await recruitment.application(db, c.get('actor'), c.req.param('id'))));
  app.get('/job-applications/documents/:id', doc);
  app.post('/job-applications/:id/appoint', async (c) => c.json(await recruitment.appoint(db, c.get('actor'), c.req.param('id'), await body(c, z.object({ joinedService: date, orderRef: z.string().min(2).max(60), contractUntil: date.nullable().optional() })))));

  // ── Health and safety ──
  const healthBody = z.object({ allergies: z.string().max(500), conditions: z.string().max(500), medication: z.string().max(500), diet: z.string().max(300), alert: z.string().max(160), doctor: z.string().max(100), doctorPhone: z.string().max(20) }).partial();
  app.get('/students/:id/health', async (c) => c.json(await health.record(db, c.get('actor'), c.req.param('id'))));
  app.put('/students/:id/health', async (c) => c.json(await health.update(db, c.get('actor'), c.req.param('id'), await body(c, healthBody))));
  app.post('/students/:id/immunisations', async (c) => c.json(await health.addImmunisation(db, c.get('actor'), c.req.param('id'), await body(c, z.object({ vaccine: z.string().min(2).max(80), dose: z.string().max(40).optional(), givenOn: date.nullable().optional(), dueOn: date.nullable().optional() }))), 201));
  app.get('/schools/:id/health', async (c) => c.json(await health.overview(db, c.get('actor'), c.req.param('id'))));
  app.get('/schools/:id/health/find', async (c) => c.json(await health.find(db, c.get('actor'), c.req.param('id'), c.req.query('q') ?? '')));
  app.get('/schools/:id/infirmary', async (c) => c.json(await health.visits(db, c.get('actor'), c.req.param('id'), c.req.query('on') ?? today())));
  app.post('/schools/:id/infirmary', async (c) => c.json(await health.recordVisit(db, c.get('actor'), c.req.param('id'), await body(c, z.object({ studentId: uuid.nullable().optional(), staffUserId: uuid.nullable().optional(),
    complaint: z.string().min(2).max(300), temperatureC: z.number().min(33).max(43).nullable().optional(), treatment: z.string().max(500).optional(),
    medicines: z.array(z.object({ name: z.string().min(1).max(80), dose: z.string().max(40).optional(), itemId: uuid.optional(), qty: z.number().positive().optional() })).max(10).optional(),
    outcome: z.enum(['BACK_TO_CLASS', 'RESTED', 'SENT_HOME', 'HOSPITAL']), tellParent: z.boolean().optional() }))), 201));
  app.get('/sections/:id/health-sheet', async (c) => c.json(await health.sectionSheet(db, c.get('actor'), c.req.param('id'))));
  app.get('/sections/:id/medical-alerts', async (c) => c.json(await health.classAlerts(db, c.get('actor'), c.req.param('id'))));
  app.post('/schools/:id/checkups', async (c) => c.json(await health.recordCheckups(db, c.get('actor'), c.req.param('id'), await body(c, z.object({ onDate: date, rows: z.array(z.object({ studentId: uuid,
    heightCm: z.number().min(40).max(230).nullable().optional(), weightKg: z.number().min(5).max(200).nullable().optional(), visionLeft: z.string().max(20).optional(), visionRight: z.string().max(20).optional(),
    dental: z.string().max(100).optional(), hearing: z.string().max(60).optional(), notes: z.string().max(300).optional() })).min(1).max(200) })))));
  app.get('/schools/:id/incidents', async (c) => c.json(await health.incidents(db, c.get('actor'), c.req.param('id'), c.req.query('status') ?? 'OPEN')));
  app.post('/schools/:id/incidents', async (c) => c.json(await health.reportIncident(db, c.get('actor'), c.req.param('id'), await body(c, z.object({ at: z.string().datetime({ offset: true }),
    kind: z.enum(['INJURY', 'ILLNESS', 'BEHAVIOUR', 'BULLYING', 'SAFETY', 'PROPERTY', 'CHILD_PROTECTION', 'OTHER']), severity: z.enum(['MINOR', 'MODERATE', 'SERIOUS']), place: z.string().min(2).max(120),
    description: z.string().min(10).max(4000), actionTaken: z.string().max(2000).optional(), studentIds: z.array(uuid).max(30).optional(), staffIds: z.array(uuid).max(30).optional(), confidential: z.boolean().optional(), tellParents: z.boolean().optional() }))), 201));
  app.post('/incidents/:id/updates', async (c) => c.json(await health.updateIncident(db, c.get('actor'), c.req.param('id'), await body(c, z.object({ note: z.string().min(3).max(2000), close: z.boolean().optional() })))));
  app.get('/schools/:id/drills', async (c) => c.json(await health.drills(db, c.get('actor'), c.req.param('id'))));
  app.post('/schools/:id/drills', async (c) => c.json(await health.recordDrill(db, c.get('actor'), c.req.param('id'), await body(c, z.object({ kind: z.enum(['FIRE', 'EARTHQUAKE', 'LOCKDOWN', 'EVACUATION', 'FIRST_AID', 'OTHER']), onDate: date,
    startedAt: z.string().regex(/^\d{2}:\d{2}$/).optional(), minutesToClear: z.number().min(0).max(120).nullable().optional(), participants: z.number().int().min(0).max(10000).nullable().optional(), observations: z.string().max(2000).optional(), actions: z.string().max(2000).optional() }))), 201));

  // ── The gate ──
  const photoB64 = z.string().max(1_500_000).nullable().optional();
  app.get('/schools/:id/gate', async (c) => c.json(await gate.register(db, c.get('actor'), c.req.param('id'), c.req.query('on') ?? today())));
  app.post('/schools/:id/visitors/expect', async (c) => c.json(await gate.expect(db, c.get('actor'), c.req.param('id'), await body(c, z.object({ name: z.string().min(2).max(80), phone: z.string().min(10).max(15), purpose: z.string().min(2).max(200), organisation: z.string().max(120).optional(), on: date }))), 201));
  app.post('/schools/:id/visitors/code', async (c) => { const b = await body(c, z.object({ code: z.string().regex(/^\d{6}$/), idKind: z.string().max(30).optional(), idLast4: z.string().max(4).optional(), vehicleNo: z.string().max(15).optional(), photoBase64: photoB64 }));
    return c.json(await gate.checkInByCode(db, c.get('actor'), c.req.param('id'), b.code, b)); });
  app.post('/schools/:id/visitors', async (c) => c.json(await gate.walkIn(db, c.get('actor'), c.req.param('id'), await body(c, z.object({ name: z.string().min(2).max(80), phone: z.string().max(15).optional(), purpose: z.string().min(2).max(200),
    organisation: z.string().max(120).optional(), hostUserId: uuid.nullable().optional(), idKind: z.string().max(30).optional(), idLast4: z.string().max(4).optional(), vehicleNo: z.string().max(15).optional(), photoBase64: photoB64 }))), 201));
  app.post('/visitors/:id/out', async (c) => c.json(await gate.checkOut(db, c.get('actor'), c.req.param('id'))));
  app.post('/visitors/:id/turn-away', async (c) => c.json(await gate.turnAway(db, c.get('actor'), c.req.param('id'), (await body(c, z.object({ note: z.string().max(300) }))).note)));
  app.get('/visitors/:id/badge', async (c) => file(c, await gate.badge(db, c.get('actor'), c.req.param('id')), 'application/pdf'));
  app.get('/visitors/:id/photo', async (c) => c.body(new Uint8Array(await gate.visitorPhoto(db, c.get('actor'), c.req.param('id'))), 200, { 'content-type': 'image/jpeg', 'cache-control': 'no-store' }));
  app.get('/students/:id/pickups', async (c) => c.json(await gate.pickups(db, c.get('actor'), c.req.param('id'))));
  app.post('/students/:id/pickups', async (c) => c.json(await gate.addPickup(db, c.get('actor'), c.req.param('id'), await body(c, z.object({ name: z.string().min(2).max(80), relation: z.string().min(2).max(40), phone: z.string().max(15).optional(), photoBase64: photoB64 }))), 201));
  app.delete('/pickups/:id', async (c) => c.json(await gate.removePickup(db, c.get('actor'), c.req.param('id'))));
  app.get('/pickups/:id/card', async (c) => file(c, await gate.pickupCard(db, c.get('actor'), c.req.param('id')), 'application/pdf'));
  app.get('/pickups/:id/photo', async (c) => { const p = await gate.pickupPhoto(db, c.get('actor'), c.req.param('id')); return c.body(new Uint8Array(p.data), 200, { 'content-type': p.type, 'cache-control': 'no-store' }); });
  app.get('/students/:id/gate-passes', async (c) => c.json(await gate.myPasses(db, c.get('actor'), c.req.param('id'))));
  app.post('/students/:id/gate-passes', async (c) => c.json(await gate.requestPass(db, c.get('actor'), c.req.param('id'), await body(c, z.object({ on: date, leaveAt: z.string().regex(/^\d{2}:\d{2}$/), reason: z.string().min(3).max(300), pickupId: uuid.nullable().optional() }))), 201));
  app.get('/gate-passes/to-decide', async (c) => c.json(await gate.passesToDecide(db, c.get('actor'), c.req.query('schoolId'))));
  app.post('/gate-passes/:id/decide', async (c) => { const b = await body(c, z.object({ approve: z.boolean(), note: z.string().max(300).optional() })); return c.json(await gate.decidePass(db, c.get('actor'), c.req.param('id'), b.approve, b.note)); });
  app.post('/gate-passes/:id/cancel', async (c) => c.json(await gate.cancelPass(db, c.get('actor'), c.req.param('id'))));
  app.get('/schools/:id/gate-passes', async (c) => c.json(await gate.passesToday(db, c.get('actor'), c.req.param('id'))));
  app.get('/schools/:id/gate-passes/verify', async (c) => c.json(await gate.verify(db, c.get('actor'), c.req.param('id'), c.req.query('code') ?? '')));
  app.post('/gate-passes/:id/left', async (c) => c.json(await gate.letGo(db, c.get('actor'), c.req.param('id'))));

  // ── Stores and assets ──
  const itemBody = z.object({ code: z.string().min(1).max(20), name: z.string().min(2).max(120), category: z.enum(['STATIONERY', 'IT', 'CONSUMABLE', 'LAB', 'SPORTS', 'MEDICINE', 'FURNITURE', 'CLEANING', 'UNIFORM', 'OTHER']),
    kind: z.enum(['CONSUMABLE', 'ASSET']), unit: z.string().max(15).optional(), reorderLevel: z.number().min(0).optional(), trackExpiry: z.boolean().optional(), lifeYears: z.number().int().min(1).max(50).nullable().optional(),
    attributes: z.record(z.string(), z.string().max(200)).optional(), id: uuid.optional(), active: z.boolean().optional() });
  app.get('/schools/:id/stores', async (c) => c.json(await stores.overview(db, c.get('actor'), c.req.param('id'))));
  app.get('/schools/:id/store-items', async (c) => c.json(await stores.items(db, c.get('actor'), c.req.param('id'))));
  app.post('/schools/:id/store-items', async (c) => c.json(await stores.saveItem(db, c.get('actor'), c.req.param('id'), await body(c, itemBody))));
  app.get('/store-items/:id/ledger', async (c) => c.json(await stores.ledgerOf(db, c.get('actor'), c.req.param('id'))));
  app.post('/schools/:id/stock/issue', async (c) => c.json(await stores.issue(db, c.get('actor'), c.req.param('id'), await body(c, z.object({ itemId: uuid, qty: z.number().positive(), department: z.string().min(2).max(60), issuedTo: uuid.nullable().optional(), note: z.string().max(300).optional() })))));
  app.post('/schools/:id/stock/adjust', async (c) => c.json(await stores.adjust(db, c.get('actor'), c.req.param('id'), await body(c, z.object({ itemId: uuid, kind: z.enum(['RETURN', 'ADJUST', 'OPENING']), qty: z.number(), batch: z.string().max(40).optional(),
    expiry: date.nullable().optional(), unitPaise: z.number().int().min(0).nullable().optional(), note: z.string().min(3).max(300) })))));
  app.get('/schools/:id/indents', async (c) => c.json(await stores.indents(db, c.get('actor'), c.req.param('id'))));
  app.post('/schools/:id/indents', async (c) => c.json(await stores.raiseIndent(db, c.get('actor'), c.req.param('id'), await body(c, z.object({ department: z.string().min(2).max(60), purpose: z.string().max(300).optional(), neededBy: date.nullable().optional(),
    lines: z.array(z.object({ itemId: uuid.nullable().optional(), description: z.string().max(120).optional(), qty: z.number().positive(), estPaise: z.number().int().min(0).optional() })).min(1).max(40) }))), 201));
  app.post('/indents/:id/decide', async (c) => { const b = await body(c, z.object({ approve: z.boolean(), note: z.string().max(300).optional() })); return c.json(await stores.decideIndent(db, c.get('actor'), c.req.param('id'), b.approve, b.note)); });
  app.post('/indents/:id/issue', async (c) => c.json(await stores.issueIndent(db, c.get('actor'), c.req.param('id'))));
  app.get('/schools/:id/suppliers', async (c) => c.json(await stores.suppliers(db, c.get('actor'), c.req.param('id'))));
  app.post('/schools/:id/suppliers', async (c) => c.json(await stores.saveSupplier(db, c.get('actor'), c.req.param('id'), await body(c, z.object({ id: uuid.optional(), name: z.string().min(2).max(120), gstin: z.string().max(15).nullable().optional(),
    phone: z.string().max(20).optional(), email: z.string().max(120).optional(), address: z.string().max(300).optional() })))));
  app.get('/schools/:id/purchase-orders', async (c) => c.json(await stores.orders(db, c.get('actor'), c.req.param('id'))));
  app.post('/schools/:id/purchase-orders', async (c) => c.json(await stores.createPo(db, c.get('actor'), c.req.param('id'), await body(c, z.object({ supplierId: uuid, indentId: uuid.nullable().optional(), terms: z.string().max(1000).optional(),
    lines: z.array(z.object({ itemId: uuid, qty: z.number().positive(), unitPaise: z.number().int().min(0), gstPct: z.number().min(0).max(28).optional() })).min(1).max(60) }))), 201));
  app.post('/purchase-orders/:id/approve', async (c) => c.json(await stores.approvePo(db, c.get('actor'), c.req.param('id'))));
  app.get('/purchase-orders/:id/pdf', async (c) => file(c, await stores.poPdf(db, c.get('actor'), c.req.param('id')), 'application/pdf'));
  app.post('/purchase-orders/:id/receive', async (c) => c.json(await stores.receive(db, c.get('actor'), c.req.param('id'), await body(c, z.object({ receivedOn: date, invoiceNo: z.string().min(1).max(40), invoiceDate: date.optional(),
    lines: z.array(z.object({ lineId: uuid, qty: z.number().min(0), batch: z.string().max(40).optional(), expiry: date.nullable().optional(), serials: z.array(z.string().max(60)).optional(), location: z.string().max(80).optional() })).min(1) }))), 201));
  app.post('/goods-receipts/:id/pay', async (c) => c.json(await stores.paySupplier(db, c.get('actor'), c.req.param('id'), await body(c, z.object({ amountPaise: z.number().int().positive(), paidOn: date, utr: z.string().min(4).max(40) }))), 201));
  app.get('/schools/:id/assets', async (c) => c.json(await stores.assets(db, c.get('actor'), c.req.param('id'), { status: c.req.query('status'), search: c.req.query('q') })));
  app.post('/schools/:id/assets', async (c) => c.json(await stores.addAsset(db, c.get('actor'), c.req.param('id'), await body(c, z.object({ name: z.string().min(2).max(120), itemId: uuid.nullable().optional(), serialNo: z.string().max(60).optional(),
    location: z.string().min(1).max(80), acquiredOn: date, costPaise: z.number().int().min(0), lifeYears: z.number().int().min(1).max(50).optional(), custodian: uuid.nullable().optional() }))), 201));
  app.post('/assets/:id', async (c) => c.json(await stores.updateAsset(db, c.get('actor'), c.req.param('id'), await body(c, z.object({ location: z.string().max(80).optional(), custodian: uuid.nullable().optional(), status: z.enum(['IN_USE', 'IN_REPAIR', 'MISSING']).optional() })))));
  app.get('/assets/tag/:tag', async (c) => c.json(await stores.byTag(db, c.get('actor'), c.req.param('tag'))));
  app.post('/schools/:id/asset-tags', async (c) => file(c, await stores.tagLabels(db, c.get('actor'), c.req.param('id'), (await body(c, z.object({ ids: z.array(uuid).max(2000).optional() }))).ids), 'application/pdf'));
  app.post('/assets/:id/services', async (c) => c.json(await stores.scheduleService(db, c.get('actor'), c.req.param('id'), await body(c, z.object({ kind: z.string().min(2).max(80), everyMonths: z.number().int().min(1).max(60).nullable().optional(), dueOn: date, vendor: z.string().max(120).optional() }))), 201));
  app.post('/services/:id/done', async (c) => c.json(await stores.serviceDone(db, c.get('actor'), c.req.param('id'), await body(c, z.object({ doneOn: date, costPaise: z.number().int().min(0).nullable().optional(), note: z.string().max(300).optional() })))));
  app.post('/assets/:id/dispose', async (c) => c.json(await stores.dispose(db, c.get('actor'), c.req.param('id'), await body(c, z.object({ on: date, salePaise: z.number().int().min(0).optional(), note: z.string().min(5).max(300) })))));
  app.get('/schools/:id/stock-audits', async (c) => c.json(await stores.audits(db, c.get('actor'), c.req.param('id'))));
  app.post('/schools/:id/stock-audits', async (c) => c.json(await stores.startAudit(db, c.get('actor'), c.req.param('id'), (await body(c, z.object({ title: z.string().min(3).max(120) }))).title), 201));
  app.post('/stock-audits/:id/scan', async (c) => { const b = await body(c, z.object({ tag: z.string().min(3).max(40), location: z.string().max(80).optional() })); return c.json(await stores.scan(db, c.get('actor'), c.req.param('id'), b.tag, b.location)); });
  app.get('/stock-audits/:id', async (c) => c.json(await stores.auditReport(db, c.get('actor'), c.req.param('id'))));
  app.post('/stock-audits/:id/close', async (c) => c.json(await stores.closeAudit(db, c.get('actor'), c.req.param('id'))));
  app.post('/schools/:id/depreciation', async (c) => c.json(await stores.depreciate(db, c.get('actor'), c.req.param('id'), (await body(c, z.object({ fy: z.string() }))).fy)));

  // ── Alumni ──
  app.get('/alumni-me', async (c) => c.json(await alumni.profile(db, c.get('actor'))));
  app.put('/alumni-me', async (c) => c.json(await alumni.updateProfile(db, c.get('actor'), await body(c, z.object({ city: z.string().max(60), occupation: z.string().max(80), organisation: z.string().max(120), inDirectory: z.boolean() }).partial()))));
  app.get('/alumni-me/directory', async (c) => c.json(await alumni.directory(db, c.get('actor'), { year: c.req.query('year') ? Number(c.req.query('year')) : undefined, search: c.req.query('q') })));
  app.get('/alumni-me/events', async (c) => c.json(await alumni.myEvents(db, c.get('actor'))));
  app.post('/alumni-me/events/:id/rsvp', async (c) => c.json(await alumni.rsvp(db, c.get('actor'), c.req.param('id'), await body(c, z.object({ answer: z.enum(['YES', 'NO', 'MAYBE']), guests: z.number().int().min(0).max(5).optional() })))));
  app.get('/schools/:id/alumni', async (c) => c.json(await alumni.list(db, c.get('actor'), c.req.param('id'), { status: c.req.query('status'), year: c.req.query('year') ? Number(c.req.query('year')) : undefined, search: c.req.query('q') })));
  app.get('/alumni/:id/matches', async (c) => c.json(await alumni.candidates(db, c.get('actor'), c.req.param('id'))));
  app.post('/alumni/:id/verify', async (c) => c.json(await alumni.verify(db, c.get('actor'), c.req.param('id'), await body(c, z.object({ approve: z.boolean(), studentId: uuid.nullable().optional(), note: z.string().max(300).optional() })))));
  app.get('/schools/:id/alumni-events', async (c) => c.json(await alumni.events(db, c.get('actor'), c.req.param('id'))));
  app.post('/schools/:id/alumni-events', async (c) => c.json(await alumni.sendEvent(db, c.get('actor'), c.req.param('id'), await body(c, z.object({ title: z.string().min(3).max(120), kind: z.enum(['REUNION', 'NEWSLETTER', 'TALK', 'OTHER']),
    onDate: date.nullable().optional(), venue: z.string().max(200).optional(), body: z.string().min(10).max(10000), batches: z.array(z.number().int().min(1950).max(2100)).max(80).optional() }))), 201));

  // ── Exams: rooms, seating, invigilation, moderation, scripts, the board ──
  const session = z.enum(['MORNING', 'AFTERNOON']);
  app.get('/schools/:id/rooms', async (c) => c.json(await exams.rooms(db, c.get('actor'), c.req.param('id'))));
  app.post('/schools/:id/rooms', async (c) => c.json(await exams.saveRoom(db, c.get('actor'), c.req.param('id'), await body(c, z.object({ id: uuid.optional(), campusId: uuid, name: z.string().min(1).max(40),
    kind: z.enum(['CLASSROOM', 'LAB', 'HALL', 'LIBRARY', 'OTHER']), capacity: z.number().int().min(1).max(1000), examSeats: z.number().int().min(0).max(1000), active: z.boolean().optional() })))));
  app.get('/assessments/:id/days', async (c) => c.json(await exams.days(db, c.get('actor'), c.req.param('id'))));
  app.post('/assessments/:id/seating', async (c) => { const b = await body(c, z.object({ examDate: date, session })); return c.json(await exams.plan(db, c.get('actor'), c.req.param('id'), b.examDate, b.session)); });
  app.get('/assessments/:id/seating', async (c) => c.json(await exams.seating(db, c.get('actor'), c.req.param('id'), c.req.query('date') ?? '', c.req.query('session') ?? 'MORNING')));
  app.get('/assessments/:id/seating.pdf', async (c) => file(c, await exams.seatingPdf(db, c.get('actor'), c.req.param('id'), c.req.query('date') ?? '', c.req.query('session') ?? 'MORNING'), 'application/pdf'));
  app.get('/my/invigilation', async (c) => c.json(await exams.myDuties(db, c.get('actor'))));
  app.post('/assessments/:id/sheets/:sectionId/:subject/submit', async (c) => c.json(await exams.submitSheet(db, c.get('actor'), c.req.param('id'), c.req.param('sectionId'), c.req.param('subject'))));
  app.get('/assessments/:id/sheets/:sectionId/:subject/status', async (c) => c.json({ status: await exams.sheetStatus(db, c.req.param('id'), c.req.param('sectionId'), c.req.param('subject')) }));
  app.get('/schools/:id/moderation', async (c) => c.json(await exams.toModerate(db, c.get('actor'), c.req.param('id'))));
  app.post('/assessments/:id/sheets/:sectionId/:subject/moderate', async (c) => c.json(await exams.moderate(db, c.get('actor'), c.req.param('id'), c.req.param('sectionId'), c.req.param('subject'), await body(c, z.object({
    changes: z.array(z.object({ enrolmentId: uuid, marks: z.number().min(0).max(200), reason: z.string().min(4).max(300) })).max(60).optional(), accept: z.boolean(), note: z.string().max(500).optional() })))));
  app.get('/assessments/:id/moderation-log', async (c) => c.json(await exams.moderationLog(db, c.get('actor'), c.req.param('id'))));
  app.get('/assessments/:id/bundles', async (c) => c.json(await exams.bundles(db, c.get('actor'), c.req.param('id'))));
  app.post('/assessments/:id/bundles', async (c) => c.json(await exams.issueBundle(db, c.get('actor'), c.req.param('id'), await body(c, z.object({ sectionId: uuid, subjectCode: z.string().max(4), scripts: z.number().int().min(1).max(200), evaluator: uuid }))), 201));
  app.post('/bundles/:id/return', async (c) => c.json(await exams.returnBundle(db, c.get('actor'), c.req.param('id'), await body(c, z.object({ count: z.number().int().min(0).max(200), note: z.string().max(300).optional() })))));
  app.get('/schools/:id/board/uploads', async (c) => c.json(await exams.boardUploads(db, c.get('actor'), c.req.param('id'))));
  app.get('/schools/:id/board/:class', async (c) => { const rows = await exams.boardData(db, c.get('actor'), c.req.param('id'), c.req.param('class'));
    return c.req.query('format') === 'csv' ? csv(c, exams.boardCsv(rows), `cbse-${c.req.param('class')}.csv`) : c.json(rows); });
  app.post('/schools/:id/board/numbers', async (c) => c.json(await exams.setBoardNumbers(db, c.get('actor'), c.req.param('id'), (await body(c, z.object({ rows: z.array(z.object({ admissionNo: z.string().min(1).max(30), regNo: z.string().max(30).optional(), rollNo: z.string().max(30).optional() })).min(1).max(2000) }))).rows)));
  app.post('/schools/:id/board/results', async (c) => c.json(await exams.importBoardResults(db, c.get('actor'), c.req.param('id'), await body(c, z.object({
    year: z.number().int().min(2000).max(2100), classCode: z.enum(['X', 'XII']), content: z.string().min(10).max(5_000_000), fileName: z.string().max(200).optional(), dryRun: z.boolean().optional() })))));
  app.post('/schools/:id/board/results/:year/:class/publish', async (c) => c.json(await exams.publishBoardResults(db, c.get('actor'), c.req.param('id'), Number(c.req.param('year')), z.enum(['X', 'XII']).parse(c.req.param('class')))));
  // The Performance Index per the NES policy letter; the HQ consolidation; earlier years; the NES dashboard.
  app.get('/schools/:id/pi', async (c) => {
    const s = await pi.schoolSheet(db, c.get('actor'), c.req.param('id'), c.req.query('year') ?? currentYear(), c.req.query('code') ?? 'ANNUAL');
    return c.req.query('format') === 'csv' ? csv(c, pi.sheetCsv(s), `pi-${s.year}.csv`) : c.json(s);
  });
  app.post('/schools/:id/pi/report', async (c) => c.json(await pi.freeze(db, c.get('actor'), c.req.param('id'), (await body(c, z.object({ year: z.string(), code: z.string().optional() }))).year, c.req.query('code') ?? 'ANNUAL')));
  app.post('/schools/:id/pi/reopen', async (c) => c.json(await pi.unfreeze(db, c.get('actor'), c.req.param('id'), (await body(c, z.object({ year: z.string() }))).year)));
  app.get('/pi/consolidation', async (c) => {
    const r = await pi.consolidation(db, c.get('actor'), c.req.query('year') ?? currentYear(), c.req.query('code') ?? 'ANNUAL');
    return c.req.query('format') === 'csv' ? csv(c, pi.consolidationCsv(r), `pi-consolidation-${r.year}.csv`) : c.json(r);
  });
  app.post('/pi/history', async (c) => { const b = await body(c, z.object({ year: z.string(), csv: z.string().min(10).max(1_000_000) })); return c.json(await pi.importHistory(db, c.get('actor'), b.year, b.csv)); });
  app.get('/analytics/results', async (c) => c.json(await analytics.results(db, c.get('actor'), { years: (c.req.query('years') ?? '').split(',').filter(Boolean), code: c.req.query('code') ?? 'ANNUAL' })));
  app.get('/schools/:id/board/results/:year/:class', async (c) => c.json(await exams.boardAnalysis(db, c.get('actor'), c.req.param('id'), Number(c.req.param('year')), c.req.param('class'))));

  // ── Promotion to the next year ──
  app.post('/academic-years', async (c) => c.json(await promotion.openYear(db, c.get('actor'), (await body(c, z.object({ code: z.string() }))).code), 201));
  app.get('/schools/:id/promotion', async (c) => c.json(await promotion.view(db, c.get('actor'), c.req.param('id'))));
  app.post('/schools/:id/promotion', async (c) => c.json(await promotion.prepare(db, c.get('actor'), c.req.param('id'))));
  app.post('/promotion/:id/lines/:enrolmentId', async (c) => c.json(await promotion.setLine(db, c.get('actor'), c.req.param('id'), c.req.param('enrolmentId'), await body(c, z.object({ decision: z.enum(['PROMOTE', 'DETAIN', 'COMPLETE', 'LEAVE']), toSection: uuid.nullable().optional(), reason: z.string().max(300).optional() })))));
  app.post('/promotion/:id/apply', async (c) => c.json(await promotion.apply(db, c.get('actor'), c.req.param('id'))));
  app.post('/sections/:id/stream', async (c) => c.json(await promotion.setStream(db, c.get('actor'), c.req.param('id'), (await body(c, z.object({ stream: z.enum(['SCIENCE_PCM', 'SCIENCE_PCB', 'COMMERCE', 'HUMANITIES']).nullable() }))).stream)));
  app.get('/students/:id/streams', async (c) => c.json(await promotion.myStreamChoice(db, c.get('actor'), c.req.param('id'))));
  app.post('/students/:id/streams', async (c) => c.json(await promotion.chooseStreams(db, c.get('actor'), c.req.param('id'), (await body(c, z.object({ choices: z.array(z.string()).min(1).max(4) }))).choices)));

  // ── The Common Written Test ──
  const ipOf = (c: Context) => c.req.header('x-forwarded-for')?.split(',')[0].trim() || 'local';
  const file = (c: Context, f: { name: string; data: Buffer }, type: string) => c.body(new Uint8Array(f.data), 200, { 'content-type': type, 'content-disposition': `attachment; filename="${f.name.replace(/[^\w .()-]/g, '_')}"`, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  const upload = z.object({ name: z.string().min(1).max(120), contentType: z.string(), dataBase64: z.string().max(21_000_000) });
  app.get('/candidate/applications/:id/admit-card', async (c) => file(c, await cwt.admitCard(db, c.get('actor'), c.req.param('id')), 'application/pdf'));
  app.get('/job-applications/:id/admit-card', async (c) => file(c, await cwt.admitCard(db, c.get('actor'), c.req.param('id')), 'application/pdf'));
  app.get('/cwt/cycles', async (c) => c.json(await cwt.cycles(db, c.get('actor'))));
  app.post('/cwt/cycles', async (c) => c.json(await cwt.createCycle(db, c.get('actor'), await body(c, z.object({ title: z.string().min(5).max(120), examDate: date, startsAt: z.string().regex(/^\d{2}:\d{2}$/).optional(),
    durationMin: z.number().int().min(30).max(300).optional(), requirementsBy: date, papersDue: date, releaseAt: z.string().datetime({ offset: true }).optional() }))), 201));
  app.get('/cwt/cycles/:id', async (c) => c.json(await cwt.cycle(db, c.get('actor'), c.req.param('id'))));
  app.post('/cwt/cycles/:id/request-all', async (c) => c.json(await cwt.requestAll(db, c.get('actor'), c.req.param('id'), (await body(c, z.object({ per: z.number().int().min(1).max(6).optional() }))).per)));
  app.post('/cwt/cycles/:id/rolls', async (c) => c.json(await cwt.assignRollNumbers(db, c.get('actor'), c.req.param('id'))));
  app.post('/cwt/cycles/:id/release', async (c) => c.json(await cwt.release(db, c.get('actor'), c.req.param('id'))));
  app.get('/cwt/cycles/:id/downloads', async (c) => c.json(await cwt.downloads(db, c.get('actor'), c.req.param('id'))));
  app.get('/cwt/papers/:id/setters', async (c) => c.json(await cwt.suggestSetters(db, c.get('actor'), c.req.param('id'))));
  app.post('/cwt/papers/:id/requests', async (c) => c.json(await cwt.requestPapers(db, c.get('actor'), c.req.param('id'), await body(c, z.object({ schoolIds: z.array(uuid).min(1).max(6), dueOn: date.optional() })))));
  app.get('/cwt/requests/:id/:which{question|key}', async (c) => { const f = await cwt.reviewFile(db, c.get('actor'), c.req.param('id'), c.req.param('which') as 'question' | 'key', ipOf(c)); return file(c, f, f.type); });
  app.post('/cwt/requests/:id/score', async (c) => c.json(await cwt.scoreRequest(db, c.get('actor'), c.req.param('id'), await body(c, z.object({ score: z.number().int().min(1).max(5), note: z.string().max(1000).optional() })))));
  app.post('/cwt/requests/:id/select', async (c) => c.json(await cwt.selectPaper(db, c.get('actor'), c.req.param('id'), (await body(c, z.object({ maxMarks: z.number().int().min(10).max(500).optional() }))).maxMarks)));
  app.post('/cwt/requests/:id/submit', async (c) => c.json(await cwt.submitPaper(db, c.get('actor'), c.req.param('id'), await body(c, z.object({ question: upload, key: upload, note: z.string().max(1000).optional() })))));
  app.post('/cwt/requests/:id/decline', async (c) => c.json(await cwt.declineRequest(db, c.get('actor'), c.req.param('id'), (await body(c, z.object({ note: z.string().min(5).max(500) }))).note)));
  app.post('/vacancies/:id/cwt', async (c) => c.json(await cwt.sendRequirement(db, c.get('actor'), (await body(c, z.object({ cycleId: uuid }))).cycleId, c.req.param('id'))));
  app.delete('/vacancies/:id/cwt', async (c) => c.json(await cwt.withdrawRequirement(db, c.get('actor'), c.req.param('id'))));
  app.get('/schools/:id/cwt-setter', async (c) => c.json(await cwt.setterRequests(db, c.get('actor'), c.req.param('id'))));
  app.get('/schools/:id/cwt-centre', async (c) => c.json(await cwt.centreView(db, c.get('actor'), c.req.param('id'))));
  app.get('/schools/:id/cwt/:cycleId/:kind{papers|keys}', async (c) => file(c, await cwt.centreDownload(db, c.get('actor'), c.req.param('id'), c.req.param('cycleId'), c.req.param('kind') === 'papers' ? 'PAPERS' : 'KEYS', ipOf(c)), 'application/zip'));
  app.post('/schools/:id/cwt/:cycleId/password', async (c) => c.json(await cwt.resendPassword(db, c.get('actor'), c.req.param('id'), c.req.param('cycleId'), (await body(c, z.object({ kind: z.enum(['PAPERS', 'KEYS']) }))).kind)));
  app.get('/schools/:id/cwt/:cycleId/candidates', async (c) => c.json(await cwt.centreCandidates(db, c.get('actor'), c.req.param('id'), c.req.param('cycleId'))));
  app.post('/schools/:id/cwt/:cycleId/marks', async (c) => c.json(await cwt.enterMarks(db, c.get('actor'), c.req.param('id'), c.req.param('cycleId'), (await body(c, z.object({
    rows: z.array(z.object({ roll: z.string().min(3).max(40), marks: z.number().min(0).max(500).nullable().optional(), absent: z.boolean().optional() })).min(1).max(20000) }))).rows)));

  // ── R6: governance, inspections, insights ──
  const member = z.object({ userId: uuid.optional(), name: z.string().max(120).optional(), detail: z.string().max(160).optional(), email: z.string().email().max(160).optional(), role: z.enum(['CHAIR', 'CONVENER', 'MEMBER', 'INVITEE']) });
  const decisionBody = z.object({ agendaItemId: uuid.nullable().optional(), title: z.string().min(3).max(200), body: z.string().min(5).max(5000), reason: z.string().max(2000).optional(),
    outcome: z.enum(['DECIDED', 'DEFERRED', 'NEEDS_MEETING']).optional(), ownerId: uuid.nullable().optional(), dueOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
    schoolIds: z.array(uuid).max(200).optional(), confidential: z.boolean().optional(),
    actions: z.array(z.object({ title: z.string().min(3).max(200), ownerId: uuid, dueOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) })).max(30).optional() });
  const a = (c: Context) => c.get('actor') as Actor;
  app.get('/governance/committees', async (c) => c.json(await governance.committees(db, a(c))));
  app.post('/governance/committees', async (c) => c.json(await governance.createCommittee(db, a(c), await body(c, z.object({ unitId: uuid, kind: z.enum(Object.keys(governance.KINDS) as [governance.Kind, ...governance.Kind[]]),
    name: z.string().max(120).optional(), purpose: z.string().max(4000).optional(), quorum: z.number().int().min(1).max(100), endsOn: z.string().nullable().optional(), confidential: z.boolean().optional(), members: z.array(member).min(2).max(80) }))), 201));
  app.get('/governance/committees/:id', async (c) => c.json(await governance.committee(db, a(c), c.req.param('id'))));
  app.patch('/governance/committees/:id', async (c) => c.json(await governance.updateCommittee(db, a(c), c.req.param('id'), await body(c, z.object({ name: z.string().max(120).optional(), purpose: z.string().max(4000).optional(),
    quorum: z.number().int().min(1).max(100).optional(), endsOn: z.string().nullable().optional(), confidential: z.boolean().optional(), active: z.boolean().optional() })))));
  app.post('/governance/committees/:id/members', async (c) => c.json(await governance.addMember(db, a(c), c.req.param('id'), await body(c, member.extend({ from: z.string().optional() })))));
  app.post('/governance/members/:id/end', async (c) => c.json(await governance.endMember(db, a(c), c.req.param('id'), (await body(c, z.object({ on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }))).on)));
  app.get('/governance/people', async (c) => c.json(await governance.people(db, a(c), c.req.query('unitId') ?? '', c.req.query('q') ?? '')));
  app.post('/governance/committees/:id/agenda', async (c) => c.json(await governance.submitItem(db, a(c), c.req.param('id'), await body(c, z.object({ title: z.string().min(3).max(200), details: z.string().max(5000).optional(), meetingId: uuid.nullable().optional(), confidential: z.boolean().optional() }))), 201));
  app.post('/governance/agenda/:id/triage', async (c) => c.json(await governance.triageItem(db, a(c), c.req.param('id'), await body(c, z.object({ action: z.enum(['ACCEPT', 'DEFER', 'MERGE', 'REJECT']), meetingId: uuid.nullable().optional(), mergeInto: uuid.optional(), note: z.string().max(1000).optional() })))));
  app.post('/governance/committees/:id/meetings', async (c) => c.json(await governance.scheduleMeeting(db, a(c), c.req.param('id'), await body(c, z.object({ title: z.string().max(200).optional(), kind: z.enum(['ORDINARY', 'SPECIAL', 'SESSION']).optional(),
    startsAt: z.string(), endsAt: z.string().nullable().optional(), venue: z.string().max(300).optional(), videoLink: z.string().max(500).optional(), agendaCloses: z.string().nullable().optional() }))), 201));
  app.get('/governance/meetings/:id', async (c) => c.json(await governance.meeting(db, a(c), c.req.param('id'))));
  app.patch('/governance/meetings/:id', async (c) => c.json(await governance.updateMeeting(db, a(c), c.req.param('id'), await body(c, z.object({ title: z.string().max(200).optional(), startsAt: z.string().optional(), endsAt: z.string().nullable().optional(), venue: z.string().max(300).optional(), videoLink: z.string().max(500).optional(), agendaCloses: z.string().optional() })))));
  app.post('/governance/meetings/:id/cancel', async (c) => c.json(await governance.cancelMeeting(db, a(c), c.req.param('id'), (await body(c, z.object({ reason: z.string().max(500) }))).reason)));
  app.put('/governance/meetings/:id/attendance', async (c) => c.json(await governance.attendance(db, a(c), c.req.param('id'), (await body(c, z.object({ marks: z.array(z.object({ memberId: uuid, status: z.enum(['PRESENT', 'ABSENT', 'LEAVE']) })).max(200) }))).marks)));
  app.put('/governance/meetings/:id/minutes', async (c) => c.json(await governance.saveMinutes(db, a(c), c.req.param('id'), await body(c, z.object({ note: z.string().max(20000).optional(), items: z.array(z.object({ id: uuid, discussion: z.string().max(20000) })).max(100).optional() })))));
  app.post('/governance/meetings/:id/circulate', async (c) => c.json(await governance.circulate(db, a(c), c.req.param('id'))));
  app.post('/governance/meetings/:id/comments', async (c) => c.json(await governance.comment(db, a(c), c.req.param('id'), (await body(c, z.object({ body: z.string().min(2).max(2000) }))).body)));
  app.post('/governance/meetings/:id/confirm', async (c) => c.json(await governance.confirm(db, a(c), c.req.param('id'))));
  app.get('/governance/meetings/:id/minutes.pdf', async (c) => file(c, { name: 'minutes.pdf', data: await governance.minutesPdf(db, a(c), c.req.param('id')) }, 'application/pdf'));
  app.post('/governance/meetings/:id/decisions', async (c) => c.json(await governance.recordDecision(db, a(c), c.req.param('id'), await body(c, decisionBody)), 201));
  app.post('/governance/committees/:id/circulation', async (c) => c.json(await governance.proposeByCirculation(db, a(c), c.req.param('id'), await body(c, decisionBody.extend({ closesOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }))), 201));
  app.get('/governance/decisions', async (c) => c.json(await governance.decisions(db, a(c), { committeeId: c.req.query('committeeId') || undefined, status: c.req.query('status') || undefined, q: c.req.query('q') || undefined, overdue: c.req.query('overdue') === '1' })));
  app.get('/governance/decisions/:id', async (c) => c.json(await governance.decision(db, a(c), c.req.param('id'))));
  app.patch('/governance/decisions/:id', async (c) => c.json(await governance.editDecision(db, a(c), c.req.param('id'), await body(c, decisionBody.partial()))));
  app.delete('/governance/decisions/:id', async (c) => c.json(await governance.dropDecision(db, a(c), c.req.param('id'))));
  app.post('/governance/decisions/:id/status', async (c) => c.json(await governance.setDecision(db, a(c), c.req.param('id'), await body(c, z.object({ status: z.enum(['IMPLEMENTED', 'CLOSED', 'NEEDS_MEETING']).optional(), ownerId: uuid.optional(), dueOn: z.string().optional(), note: z.string().max(2000).optional() })))));
  app.post('/governance/decisions/:id/vote', async (c) => c.json(await governance.vote(db, a(c), c.req.param('id'), await body(c, z.object({ vote: z.enum(['YES', 'NO', 'ABSTAIN']), note: z.string().max(500).optional() })))));
  app.post('/governance/decisions/:id/count', async (c) => c.json(await governance.countVotes(db, a(c), c.req.param('id'))));
  app.post('/governance/decisions/:id/actions', async (c) => c.json(await governance.addAction(db, a(c), c.req.param('id'), await body(c, z.object({ title: z.string().min(3).max(200), ownerId: uuid, dueOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) })))));
  app.post('/governance/actions/:id/update', async (c) => c.json(await governance.updateAction(db, a(c), c.req.param('id'), await body(c, z.object({ percent: z.number().min(0).max(100), note: z.string().min(2).max(2000), status: z.enum(['DONE', 'DROPPED']).optional() })))));
  app.post('/governance/decisions/:id/schools/:schoolId/acknowledge', async (c) => c.json(await governance.acknowledge(db, a(c), c.req.param('id'), c.req.param('schoolId'))));
  app.post('/governance/decisions/:id/schools/:schoolId/report', async (c) => c.json(await governance.reportAction(db, a(c), c.req.param('id'), c.req.param('schoolId'), (await body(c, z.object({ report: z.string().max(5000) }))).report)));
  app.get('/governance/dashboard', async (c) => c.json(await governance.dashboard(db, a(c))));
  app.get('/governance/mine', async (c) => c.json(await governance.mine(db, a(c))));
  app.get('/governance/search', async (c) => c.json(await governance.search(db, a(c), c.req.query('q') ?? '')));

  const checklist = z.array(z.object({ title: z.string().max(200), items: z.array(z.object({ text: z.string().max(500), weight: z.number().min(1).max(5).optional() })).max(80) })).min(1).max(30);
  app.get('/inspections/templates', async (c) => c.json(await inspections.templates(db, a(c))));
  app.post('/inspections/templates', async (c) => c.json(await inspections.saveTemplate(db, a(c), await body(c, z.object({ id: uuid.optional(), unitId: uuid, name: z.string().min(3).max(120), purpose: z.string().max(2000).optional(), scale: z.union([z.literal(3), z.literal(4), z.literal(5)]), sections: checklist, active: z.boolean().optional() })))));
  app.get('/inspections', async (c) => c.json(await inspections.list(db, a(c), { schoolId: c.req.query('schoolId') || undefined, status: c.req.query('status') || undefined })));
  app.post('/inspections', async (c) => c.json(await inspections.plan(db, a(c), await body(c, z.object({ schoolId: uuid, templateId: uuid, kind: z.enum(['ANNUAL', 'SURPRISE', 'THEMATIC', 'SELF']), title: z.string().max(200).optional(),
    scheduledOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), leadId: uuid.optional(), teamIds: z.array(uuid).max(20).optional() }))), 201));
  app.get('/inspections/:id', async (c) => c.json(await inspections.inspection(db, a(c), c.req.param('id'))));
  app.post('/inspections/:id/start', async (c) => c.json(await inspections.start(db, a(c), c.req.param('id'))));
  app.put('/inspections/:id/ratings', async (c) => c.json(await inspections.rate(db, a(c), c.req.param('id'), (await body(c, z.object({ entries: z.array(z.object({ itemId: z.string().max(10), rating: z.number().int().min(1).max(5).nullable().optional(), notApplicable: z.boolean().optional(), remark: z.string().max(1000).optional() })).max(500) }))).entries)));
  app.post('/inspections/:id/findings', async (c) => c.json(await inspections.addFinding(db, a(c), c.req.param('id'), await body(c, z.object({ itemId: z.string().max(10).nullable().optional(), severity: z.enum(['ADVISORY', 'MINOR', 'MAJOR', 'CRITICAL']), body: z.string().min(5).max(3000), dueOn: z.string().nullable().optional() })))));
  app.delete('/inspections/findings/:id', async (c) => c.json(await inspections.removeFinding(db, a(c), c.req.param('id'))));
  app.post('/inspections/:id/report', async (c) => c.json(await inspections.report(db, a(c), c.req.param('id'), (await body(c, z.object({ summary: z.string().max(10000) }))).summary)));
  app.post('/inspections/findings/:id/respond', async (c) => c.json(await inspections.respond(db, a(c), c.req.param('id'), (await body(c, z.object({ response: z.string().max(5000) }))).response)));
  app.post('/inspections/findings/:id/decide', async (c) => c.json(await inspections.decideFinding(db, a(c), c.req.param('id'), await body(c, z.object({ accept: z.boolean(), note: z.string().max(2000).optional() })))));
  app.post('/inspections/:id/cancel', async (c) => c.json(await inspections.cancel(db, a(c), c.req.param('id'), (await body(c, z.object({ reason: z.string().max(500) }))).reason)));
  app.get('/inspections/:id/report.pdf', async (c) => file(c, { name: 'inspection-report.pdf', data: await inspections.reportPdfFor(db, a(c), c.req.param('id')) }, 'application/pdf'));

  app.get('/insights', async (c) => c.json(await insights.overview(db, a(c), c.req.query('unitId') || undefined)));
  app.get('/insights/mis.pdf', async (c) => file(c, { name: 'mis-pack.pdf', data: await insights.misPack(db, a(c), c.req.query('unitId') || undefined) }, 'application/pdf'));

  app.get('/audit', async (c) => {
    const a = c.get('actor');
    if (a.role !== 'NES_ADMIN') throw new AppError(403, 'forbidden', 'Only NES administrators can read the audit log.');
    return c.json(await db.query('select id, at, actor, entity, entity_id, action, hash from audit_log order by id desc limit 100'));
  });

  return app;
}
