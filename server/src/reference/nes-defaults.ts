/**
 * NES default reference data: the admission category scheme, fee bands and the fee schedule
 * used for the demo and tests. In production these are entered and versioned through the
 * app (they are data, not code); this file only provides a starting point.
 */
export const ADMISSION_RULES = [
  { code: '1', label: 'Serving Navy, posted in station; or died in service', priority: 1, requiredDocs: ['FORM_2A', 'POSTING_ORDER'],
    condition: { all: [{ ne: ['relationship', 'GRANDPARENT'] }, { any: [
      { all: [{ eq: ['service', 'NAVY'] }, { eq: ['status', 'SERVING'] }, { eq: ['posted_in_station', true] }] },
      { all: [{ eq: ['service', 'NAVY'] }, { eq: ['status', 'DIED_IN_SERVICE'] }] }] }] } },
  { code: '1A', label: 'Army or Air Force on deputation to Navy', priority: 2, requiredDocs: ['FORM_2A', 'POSTING_ORDER'],
    condition: { all: [{ ne: ['relationship', 'GRANDPARENT'] }, { in: ['service', ['ARMY', 'AIR_FORCE', 'COAST_GUARD']] }, { eq: ['status', 'DEPUTATION_NAVY'] }] } },
  { code: '2', label: 'Navy ex-serviceman with pension', priority: 3, requiredDocs: ['ESM_CARD', 'PPO'],
    condition: { all: [{ ne: ['relationship', 'GRANDPARENT'] }, { eq: ['service', 'NAVY'] }, { eq: ['status', 'ESM_PENSION'] }] } },
  { code: '2B', label: 'Defence civilian with the Navy, in station', priority: 4, requiredDocs: ['STAFF_ID'],
    condition: { all: [{ ne: ['relationship', 'GRANDPARENT'] }, { eq: ['service', 'DEF_CIV_NAVY'] }, { eq: ['posted_in_station', true] }] } },
  { code: '3', label: 'Navy ex-serviceman without pension', priority: 5, requiredDocs: ['ESM_CARD'],
    condition: { all: [{ ne: ['relationship', 'GRANDPARENT'] }, { eq: ['service', 'NAVY'] }, { eq: ['status', 'ESM_NO_PENSION'] }] } },
  { code: '3B', label: 'Personnel of the three Services', priority: 6, requiredDocs: ['FORM_2A'],
    condition: { all: [{ ne: ['relationship', 'GRANDPARENT'] }, { in: ['service', ['NAVY', 'ARMY', 'AIR_FORCE', 'COAST_GUARD']] }] } },
  { code: '3C', label: 'Defence civilian with Army or Air Force, in station', priority: 7, requiredDocs: ['STAFF_ID'],
    condition: { all: [{ ne: ['relationship', 'GRANDPARENT'] }, { eq: ['service', 'DEF_CIV_ARMY_AF'] }, { eq: ['posted_in_station', true] }] } },
  { code: '4A', label: 'Grandchild of service personnel', priority: 8, requiredDocs: ['FORM_2A'],
    condition: { all: [{ eq: ['relationship', 'GRANDPARENT'] }, { in: ['service', ['NAVY', 'ARMY', 'AIR_FORCE', 'COAST_GUARD']] }] } },
  { code: '4B', label: 'All others', priority: 9, requiredDocs: [], condition: { always: true } },
];
export const FEE_BAND_RULES = [
  { code: 'OFFICER', label: 'Officers (incl. defence civilian officers)', priority: 1,
    condition: { any: [{ eq: ['rank_band', 'OFFICER'] }, { eq: ['civil_officer', true] }] } },
  { code: 'CPO_AND_ABOVE', label: 'CPOs and above', priority: 2, condition: { eq: ['rank_band', 'CPO_AND_ABOVE'] } },
  { code: 'PO_AND_BELOW', label: 'POs and below', priority: 3, condition: { eq: ['rank_band', 'PO_AND_BELOW'] } },
  { code: 'NES_STAFF', label: 'NES staff', priority: 4, condition: { eq: ['service', 'NES_STAFF'] } },
  { code: 'OTHERS', label: 'Others', priority: 5, condition: { always: true } },
];

export const TUITION_OFFICER: Record<string, number> = { PRE: 7200, PRIMARY: 8400, MIDDLE: 9600, SECONDARY: 10800, SENIOR: 12000 };
export const BAND_FACTOR: Record<string, number> = { OFFICER: 1, CPO_AND_ABOVE: 0.85, PO_AND_BELOW: 0.7, NES_STAFF: 0.5, OTHERS: 1.2 };

/**
 * NES default assessment plan for a school year. Weights are each exam's share of the final
 * result. Schools create their assessments from this plan and can change papers and dates.
 */
export const ASSESSMENT_PLAN = [
  { code: 'PT1', name: 'Periodic Test 1', kind: 'PERIODIC', weight: 10, maxMarks: 40, starts: '2026-07-06', ends: '2026-07-11' },
  { code: 'HY', name: 'Half-Yearly Examination', kind: 'TERM', weight: 30, maxMarks: 80, starts: '2026-09-14', ends: '2026-09-26' },
  { code: 'PT2', name: 'Periodic Test 2', kind: 'PERIODIC', weight: 10, maxMarks: 40, starts: '2026-11-30', ends: '2026-12-05' },
  { code: 'ANNUAL', name: 'Annual Examination', kind: 'ANNUAL', weight: 50, maxMarks: 80, starts: '2027-02-22', ends: '2027-03-10' },
] as const;

/** Subjects each class sits (CBSE scheme). Bal Vatika is assessed through the HPC only. */
export const SUBJECTS_BY_CLASS: Record<string, string[]> = {
  I: ['ENG', 'HIN', 'MAT', 'EVS'], II: ['ENG', 'HIN', 'MAT', 'EVS'],
  III: ['ENG', 'HIN', 'MAT', 'EVS', 'CS'], IV: ['ENG', 'HIN', 'MAT', 'EVS', 'CS'], V: ['ENG', 'HIN', 'MAT', 'EVS', 'CS'],
  VI: ['ENG', 'HIN', 'SAN', 'MAT', 'SCI', 'SST', 'CS'], VII: ['ENG', 'HIN', 'SAN', 'MAT', 'SCI', 'SST', 'CS'], VIII: ['ENG', 'HIN', 'SAN', 'MAT', 'SCI', 'SST', 'CS'],
  IX: ['ENG', 'HIN', 'MAT', 'SCI', 'SST', 'CS'], X: ['ENG', 'HIN', 'MAT', 'SCI', 'SST', 'CS'],
  XI: ['ENG', 'PHY', 'CHE', 'MAT', 'CS'], XII: ['ENG', 'PHY', 'CHE', 'MAT', 'CS'],
};
