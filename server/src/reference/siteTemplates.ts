import type { Block, SiteDoc } from '../lib/siteSchema.js';

/** Starting content for school websites. Schools edit everything after this in the builder. */
let n = 0;
const id = () => `b${(++n).toString(36).padStart(6, '0')}`;
type NoId<T> = T extends unknown ? Omit<T, 'id'> : never;
const b = (x: NoId<Block>): Block => ({ id: id(), ...x }) as Block;
const page = (slug: string, title: string, blocks: Block[], inNav = true, group?: string) => ({ id: id(), slug, title, inNav, blocks, ...(group ? { group } : {}) });
const header = (eyebrow: string, title: string, subtitle?: string) => b({ type: 'hero', style: 'plain', eyebrow, title, subtitle });

export function starterSite(name: string, address: string): SiteDoc {
  const short = name.replace(/^Navy Children School,?\s*/i, 'NCS ').replace(/^Naval Kindergarten,?\s*/i, 'NKG ');
  return {
    settings: { name, shortName: short.slice(0, 30), tagline: 'A Navy Education Society school.', accent: '#0071E3', address, footer: 'A school of the Navy Education Society. Affiliated to CBSE, New Delhi.' },
    pages: [
      page('home', 'Home', [
        b({ type: 'hero', style: 'sea', eyebrow: 'Navy Education Society', title: name, subtitle: 'For the children of those who serve. Add a line about your school here.', primary: { label: 'Admissions', href: '/admissions' }, secondary: { label: 'About us', href: '/about' } }),
        b({ type: 'text', eyebrow: 'Welcome', title: 'About our school', body: 'Write a short welcome for parents and visitors. You can change every word on this website from the ERP: Website → Pages.' }),
        b({ type: 'notices', eyebrow: 'Notices', title: "What's happening", limit: 5 }),
        b({ type: 'calendar', eyebrow: 'Calendar', title: 'Coming up', limit: 5 }),
      ]),
      page('about', 'About', [header('About the school', `About ${short}`), b({ type: 'text', title: 'Our story', body: 'Add your school history, vision and mission.' })]),
      page('admissions', 'Admissions', [header('Admissions', 'Joining the school'), b({ type: 'steps', title: 'How to apply', items: [{ title: 'Apply online' }, { title: 'Submit documents at the office' }, { title: 'Pay fees and join' }] })]),
      page('contact', 'Contact', [header('Contact', "We're here to help"), b({ type: 'contact', places: [{ name, address: address || 'Add your address', phones: [] }] }), b({ type: 'enquiry', title: 'Send an enquiry' })]),
    ],
  };
}

/**
 * A complete school website laid out like the present Navy Children School sites (menus for About,
 * Student corner, Academics, Admissions, Beyond the classroom, Gallery), with a place for the
 * school's own photos wherever photos belong: a slider of the campus, buildings and facilities,
 * events, toppers and staff. Every word and photo is changed in the builder.
 */
export function fullSchoolSite(name: string, address: string): SiteDoc {
  const short = name.replace(/^Navy Children School,?\s*/i, 'NCS ').replace(/^Nav(y|al) Kindergarten,?\s*/i, 'NKG ');
  const slides = (n: number) => Array.from({ length: n }, () => ({ assetId: '', caption: '' }));
  const photos = (n: number) => Array.from({ length: n }, () => ({ assetId: '', caption: '' }));
  const event = (slug: string, title: string, intro: string) => page(slug, title, [header('Beyond the classroom', title, intro),
    b({ type: 'text', title: 'About the event', body: 'Write what happened, who took part and what students achieved.', image: '', imageSide: 'right' }),
    b({ type: 'gallery', title: 'Photos', layout: 'mosaic', images: photos(6) })], true, 'Beyond the classroom');
  return {
    settings: { name, shortName: short.slice(0, 30), tagline: 'A Navy Education Society school.', accent: '#0A5A96', address,
      ribbon: { text: 'Admissions are open for the new session.', link: { label: 'How to apply', href: '/admission-procedure' } },
      footer: 'A school of the Navy Education Society. Affiliated to CBSE, New Delhi.' },
    pages: [
      page('home', 'Home', [
        b({ type: 'slider', title: name, subtitle: 'For the children of those who serve.', primary: { label: 'Admissions', href: '/admission-procedure' }, height: 'tall', seconds: 6, slides: slides(4) }),
        b({ type: 'stats', items: [{ value: '1984', label: 'established' }, { value: '100+', label: 'teachers' }, { value: '2,000', label: 'students' }, { value: 'CBSE', label: 'affiliated' }] }),
        b({ type: 'text', eyebrow: 'Welcome', title: `About ${short}`, body: 'A short welcome for parents and visitors: the school’s history, what it offers and what makes it special.', image: '', imageSide: 'right' }),
        b({ type: 'liveToppers', eyebrow: 'Results', title: 'Class toppers', perClass: 1 }),
        b({ type: 'toppers', eyebrow: 'Board results', title: 'Our toppers', groups: [{ title: 'Class X', list: [{ name: 'Name', score: '00.0%', photo: '' }] }, { title: 'Class XII · Science', list: [{ name: 'Name', score: '00.0%', photo: '' }] },
          { title: 'Class XII · Commerce', list: [{ name: 'Name', score: '00.0%', photo: '' }] }, { title: 'Class XII · Humanities', list: [{ name: 'Name', score: '00.0%', photo: '' }] }] }),
        b({ type: 'showcase', eyebrow: 'Life at school', title: 'Learning beyond the classroom', items: [
          { title: 'Sports', text: 'Annual sports meet, inter-house matches and coaching.', image: '', link: { label: 'Sports meet', href: '/sports-meet' } },
          { title: 'NCC and service', text: 'NCC, scouts and guides, and community service.', image: '', link: { label: 'NCC', href: '/ncc' } },
          { title: 'Arts and culture', text: 'Music, dance, drama and art through the year.', image: '', link: { label: 'Annual day', href: '/annual-day' } }] }),
        b({ type: 'notices', eyebrow: 'Notices', title: 'What’s happening', limit: 5 }),
        b({ type: 'calendar', eyebrow: 'Calendar', title: 'Holidays and events', limit: 6 }),
        b({ type: 'gallery', eyebrow: 'Gallery', title: 'Moments from the year', layout: 'mosaic', images: photos(6) }),
        b({ type: 'cta', title: 'Fees, attendance and messages in one app.', text: 'Parents use the NavShiksha app to pay fees, see attendance and hear from teachers.', button: { label: 'Contact the school', href: '/contact' }, tone: 'dark' }),
      ]),
      page('about', 'About the school', [header('About', `About ${short}`, 'Our history, vision and mission.'),
        b({ type: 'text', title: 'Our story', body: 'The school’s history and what it stands for.', image: '', imageSide: 'right' }),
        b({ type: 'cards', title: 'Vision and mission', columns: 2, items: [{ tag: 'Vision', title: 'Write the school’s vision.', tone: 'navy' }, { tag: 'Mission', title: 'Write the school’s mission.', tone: 'light' }] })], true, 'About'),
      page('principal', 'Message desk', [header('About', 'Message desk'),
        b({ type: 'message', label: 'From the Chairman', quote: 'A short message.', name: 'Name', role: 'Chairman', photo: '' }),
        b({ type: 'message', label: 'From the Principal', quote: 'A short message.', body: 'More of the message.', name: 'Name', role: 'Principal', photo: '' })], true, 'About'),
      page('facilities', 'Facilities', [header('About', 'Facilities and infrastructure', 'Our buildings, labs, library and grounds.'),
        b({ type: 'showcase', items: [
          { title: 'Classrooms', text: 'Smart classrooms with digital boards.', image: '' }, { title: 'Science laboratories', text: 'Physics, chemistry and biology labs.', image: '' },
          { title: 'Library', text: 'Books, journals and a reading room.', image: '' }, { title: 'Computer labs', text: 'Computers for every student in the lab.', image: '' },
          { title: 'Playgrounds and sports', text: 'Fields, courts and coaching.', image: '' }] }),
        b({ type: 'gallery', title: 'Around the campus', layout: 'grid', images: photos(6) })], true, 'About'),
      page('staff', 'Our teachers', [header('About', 'Our teachers'), b({ type: 'people', title: 'Leadership', items: [{ name: 'Name', role: 'Principal', photo: '' }, { name: 'Name', role: 'Vice Principal', photo: '' }, { name: 'Name', role: 'Headmistress', photo: '' }] }),
        b({ type: 'table', title: 'Teaching staff', groups: [{ title: '', rows: [{ label: 'Name', value: 'Subject' }] }] })], true, 'About'),
      page('school-hours', 'School hours', [header('About', 'School and visiting hours'), b({ type: 'table', groups: [
        { title: 'School hours', rows: [{ label: 'Classes I–V', value: '7:40 am – 1:30 pm' }, { label: 'Classes VI–XII', value: '7:40 am – 2:00 pm' }] },
        { title: 'Visiting hours', rows: [{ label: 'Office', value: '9:30 am – 12:30 pm' }, { label: 'Principal', value: 'By appointment' }] }] })], true, 'About'),
      page('holidays', 'Holidays', [header('Student corner', 'Holidays and events'), b({ type: 'calendar', title: 'Coming up', limit: 20 })], true, 'Student corner'),
      page('news', 'News', [header('Student corner', 'News and notices'), b({ type: 'notices', title: 'Latest', limit: 20 })], true, 'Student corner'),
      page('uniform', 'School uniform', [header('Student corner', 'School uniform'), b({ type: 'showcase', items: [{ title: 'Summer uniform', text: 'Describe it here.', image: '' }, { title: 'Winter uniform', text: 'Describe it here.', image: '' }, { title: 'House uniform', text: 'Describe it here.', image: '' }] })], true, 'Student corner'),
      page('transfer-certificate', 'Transfer certificate', [header('Student corner', 'Transfer certificate'), b({ type: 'steps', title: 'How to get a TC', items: [{ title: 'Ask for it in the NavShiksha app or at the office' }, { title: 'Clear any dues' }, { title: 'Collect the certificate' }] })], true, 'Student corner'),
      page('student-council', 'Student council', [header('Student corner', 'Student council'), b({ type: 'people', title: 'Prefectorial board', items: [{ name: 'Name', role: 'Head Girl', photo: '' }, { name: 'Name', role: 'Head Boy', photo: '' }] })], true, 'Student corner'),
      page('academics', 'Curriculum', [header('Academics', 'Curriculum', 'CBSE curriculum from Balvatika to Class XII.'), b({ type: 'cards', columns: 3, items: [{ tag: 'Foundational', title: 'Balvatika to Class II' }, { tag: 'Preparatory and middle', title: 'Classes III to VIII' }, { tag: 'Secondary', title: 'Classes IX to XII' }] })], true, 'Academics'),
      page('downloads', 'Almanac and syllabus', [header('Academics', 'Almanac, syllabus and date sheets'), b({ type: 'documents', items: [{ assetId: '', title: 'School almanac', note: 'PDF' }, { assetId: '', title: 'Syllabus', note: 'PDF' }, { assetId: '', title: 'Examination date sheet', note: 'PDF' }] })], true, 'Academics'),
      page('admission-procedure', 'Admission procedure', [header('Admissions', 'Admission procedure'), b({ type: 'steps', title: 'How to apply', items: [{ title: 'Register online' }, { title: 'Submit the form and documents at the office' }, { title: 'Pay the fees and join' }] })], true, 'Admissions'),
      page('admission-categories', 'Categories of admission', [header('Admissions', 'Categories of admission'), b({ type: 'table', groups: [{ title: '', rows: [{ label: 'Category I', value: 'Wards of serving naval personnel' }] }] })], true, 'Admissions'),
      page('fees', 'Fees', [header('Admissions', 'Fees and payment'), b({ type: 'text', title: 'Paying fees', body: 'Fees are paid in the NavShiksha parent app, quarterly or for the whole year.' })], true, 'Admissions'),
      page('age-criteria', 'Age criteria', [header('Admissions', 'Age criteria'), b({ type: 'table', groups: [{ title: '', rows: [{ label: 'Balvatika 1', value: '3 years' }, { label: 'Class I', value: '6 years' }] }] })], true, 'Admissions'),
      page('faq', 'FAQ', [header('Admissions', 'Frequently asked questions'), b({ type: 'faq', items: [{ q: 'When do admissions open?', a: 'Write the answer here.' }, { q: 'Which documents are needed?', a: 'Write the answer here.' }] })], true, 'Admissions'),
      event('sports-meet', 'Annual sports meet', 'Two days of march past, drills and races.'),
      event('annual-day', 'Annual day', 'Music, dance and drama on stage.'),
      event('ncc', 'NCC', 'Camps, parades and achievements.'),
      event('trips', 'Educational trips', 'Visits, internships and workshops.'),
      page('photos', 'Photo gallery', [header('Gallery', 'Photo gallery'), b({ type: 'gallery', title: 'This year', layout: 'mosaic', images: photos(12) })], true, 'Gallery'),
      page('videos', 'Video gallery', [header('Gallery', 'Video gallery'), b({ type: 'video', items: [{ url: '', title: 'Annual day' }, { url: '', title: 'Sports meet' }] })], true, 'Gallery'),
      page('newsletter', 'Newsletter', [header('Gallery', 'School newsletter'), b({ type: 'documents', items: [{ assetId: '', title: 'Newsletter', note: 'PDF' }] })], true, 'Gallery'),
      page('mandatory-disclosure', 'Mandatory disclosure', [header('CBSE', 'Mandatory public disclosure'), b({ type: 'table', groups: [{ title: 'General information', rows: [{ label: 'Name of the school', value: name }, { label: 'Affiliation no.', value: 'Add' }, { label: 'School code', value: 'Add' }] }] }),
        b({ type: 'documents', title: 'Documents', items: [{ assetId: '', title: 'Affiliation letter' }, { assetId: '', title: 'Society registration' }, { assetId: '', title: 'Fire safety certificate' }, { assetId: '', title: 'Building safety certificate' }] })]),
      page('careers', 'Careers', [header('Careers', 'Work with us'), b({ type: 'text', title: 'Vacancies', body: 'Vacancies are advertised on NavShiksha Careers. Register there once and apply to any school.' }),
        b({ type: 'cta', title: 'See current vacancies', button: { label: 'NavShiksha Careers', href: '/navshiksha-careers' }, tone: 'light' })]),
      page('alumni', 'Alumni', [header('Alumni', 'Our proud alumni'), b({ type: 'people', items: [{ name: 'Name', role: 'Batch and achievement', photo: '' }] }),
        b({ type: 'cta', title: 'Studied here? Join the alumni network.', button: { label: 'Alumni portal', href: '/navshiksha-alumni' }, tone: 'light' })]),
      page('contact', 'Contact', [header('Contact', 'We’re here to help'), b({ type: 'contact', places: [{ name, address: address || 'Add your address', phones: [] }] }), b({ type: 'enquiry', title: 'Send an enquiry' })]),
    ],
  };
}

/** NCS Mumbai, from the details on the school's current website (ncsmumbai.nesnavy.in). */
export function ncsMumbaiSite(): SiteDoc {
  return {
    settings: {
      name: 'Navy Children School, Mumbai', shortName: 'NCS Mumbai', accent: '#0071E3',
      tagline: 'A future-ready school for the children of the Indian Navy, in Navy Nagar, Colaba.',
      ribbon: { text: 'School is closed for the autumn break, 16–23 October. Classes resume on 24 October.', link: { label: 'All notices', href: '/notices' } },
      address: 'Block VII, Navy Nagar, Colaba, Mumbai 400005', phone: '82916 14970 · 86928 00401', email: 'prin.ncs.mb@gmail.com',
      footer: 'A school of the Navy Education Society, administered by HQ Western Naval Command. Affiliated to CBSE, New Delhi (1180008).',
    },
    pages: [
      page('home', 'Home', [
        b({ type: 'hero', style: 'sea', eyebrow: 'Navy Education Society · Since 1984', title: 'Navy Children School Mumbai.', subtitle: 'A future-ready school for the children of the Indian Navy, in Navy Nagar, Colaba. Bal Vatika to Class XII, affiliated to CBSE.', primary: { label: 'Admissions', href: '/admissions' }, secondary: { label: 'Our story', href: '/about' } }),
        b({ type: 'stats', items: [{ value: '1984', label: 'established' }, { value: '100+', label: 'teachers' }, { value: '99.8%', label: 'top score, Class X 2026' }, { value: '2', label: 'campuses in Colaba' }] }),
        b({ type: 'message', label: 'From the Principal', quote: 'Education is not only about marks. It is about raising responsible, confident and kind young people.', body: 'NCS is a safe and welcoming place where every child feels valued. Integrity, discipline and empathy guide what we do — in class, on the field and on stage.', name: 'Dr (Mrs) Nandana Khare', role: 'Principal', link: { label: 'All messages', href: '/about' } }),
        b({ type: 'toppers', eyebrow: 'Board results 2026', title: 'Our toppers.', subtitle: 'Felicitated at the Investiture Ceremony by members of the Navy Wives Welfare Association.', groups: [
          { title: 'Class X', list: [{ name: 'Sachi Santosh Parage', score: '99.8%' }] }, { title: 'Class XII · Science', list: [{ name: 'Arnav Pandey', score: '98.6%' }] },
          { title: 'Class XII · Humanities', list: [{ name: 'Aaroh Rohith Pisharody', score: '98.0%' }] }, { title: 'Class XII · Commerce', list: [{ name: 'Rhea Kumar', score: '92.8%' }] }] }),
        b({ type: 'cards', eyebrow: 'This year', title: 'Life at NCS.', columns: 3, items: [
          { tag: 'Annual Sports Meet 2026–27', title: 'Two days of march past, drills and races.', tone: 'navy' },
          { tag: 'Investiture Ceremony', title: 'The 2026–27 Student Council takes its oath.', tone: 'dark' },
          { tag: 'Naval Dockyard internship', title: 'Classes XI and XII learn on the shop floor.', tone: 'navy' }] }),
        b({ type: 'notices', eyebrow: 'Notices', title: "What's happening.", limit: 4 }),
        b({ type: 'cta', title: 'Fees, attendance and messages. One app, every NES school.', text: 'Pay fees online at zero charge, see attendance every morning and reply to teachers directly. When you are transferred, the app moves with you.', button: { label: 'See what is inside', href: '/digital-campus' }, tone: 'dark' }),
      ]),
      page('about', 'About', [
        header('About the school', 'Forty years of Navy children.', 'Established in 1984 and commissioned on 14 November 1989 by Mrs Krishna Jain, President, NWWA. Run by the Navy Education Society and administered by Headquarters, Western Naval Command.'),
        b({ type: 'stats', items: [{ value: '1984', label: 'established' }, { value: '14 Nov 1989', label: 'commissioned' }, { value: '1180008', label: 'CBSE affiliation' }, { value: 'BV – XII', label: 'classes' }] }),
        b({ type: 'cards', eyebrow: 'Vision', columns: 2, items: [{ tag: 'Vision', title: 'A future-ready school that brings together academic excellence, lasting values and national pride — and helps every student grow as a whole person.', tone: 'navy' }] }),
        b({ type: 'steps', eyebrow: 'Mission', title: 'What we set out to do.', items: [
          { title: 'Holistic, value-based and inclusive education for the children of Indian Naval personnel.' }, { title: 'One balanced curriculum across Naval schools, so a transfer never interrupts learning.' },
          { title: 'Creativity, analytical thinking and problem-solving, with integrity, teamwork and patriotism.' }, { title: 'All-round growth through sports and co-curricular activities.' },
          { title: 'Continuous professional growth for our teachers.' }, { title: 'Modern, well-equipped learning spaces.' }, { title: 'Close alignment with national education bodies and policy.' }] }),
        b({ type: 'people', eyebrow: 'Leadership', title: 'The people who lead NCS.', items: [
          { name: 'Vice Admiral Rahul Vilas Gokhale, YSM, NM', role: 'Chairperson · Chief of Staff, Western Naval Command' }, { name: 'Cmde J P Chiplunkar', role: 'Vice-Chairperson' },
          { name: 'Cdr Vanya Shyam', role: 'Director' }, { name: 'Dr (Mrs) Nandana Khare', role: 'Principal' }, { name: 'Mrs Laveti Shailaja', role: 'Vice Principal' },
          { name: 'Mrs Ritu Uthra', role: 'Headmistress' }, { name: 'Mrs Rinti Sengupta', role: 'Headmistress, Bal Vatika' }] }),
        b({ type: 'message', label: 'Principal', quote: 'We believe education is not only about academic results.', body: 'It is about raising responsible, confident and compassionate young people. Integrity, discipline and empathy are our core values, and we aim to build curiosity, creativity and resilience in every student.', name: 'Dr (Mrs) Nandana Khare', role: 'Principal' }),
        b({ type: 'message', label: 'Vice Principal', quote: 'Learner-centred classrooms, in line with NEP 2020.', body: 'Experiential learning, competency-based teaching and continuous assessment, with equal weight to scholastic and co-scholastic growth.', name: 'Mrs Laveti Shailaja', role: 'Vice Principal' }),
        b({ type: 'cards', eyebrow: 'Houses', title: 'Four houses. One crew.', subtitle: 'Asvini House won the Best House Award for co-curricular activities in 2025–26, in both wings.', columns: 4, items: [
          { title: 'Angre', text: 'After Kanhoji Angre, admiral of the Maratha navy.' }, { title: 'Trata', text: 'From the Sanskrit for protector.' },
          { title: 'Kunjali', text: 'After the Kunjali Marakkars, naval chiefs of the Zamorin.' }, { title: 'Asvini', text: "After INHS Asvini, the Navy's hospital in Colaba.", tag: 'Best House 2025–26', tone: 'navy' }] }),
        b({ type: 'table', eyebrow: 'Student Council 2026–27', title: 'Leaders in the making.', subtitle: 'Invested by Surg RAdm Manish Honwad, VSM, Commanding Officer, INHS Asvini.', groups: [
          { title: 'Senior School', rows: [{ label: 'Head Girl', value: 'Tanisha Gupta' }, { label: 'Head Boy', value: 'Adiityaa Guptaa' }, { label: 'Deputy Head Girl', value: 'Laasya Reddy' }, { label: 'Deputy Head Boy', value: 'Abhinav P' }] },
          { title: 'Junior School', rows: [{ label: 'Head Girl', value: 'Aditee P. Wanjari' }, { label: 'Head Boy', value: 'Rudra Ravi Singh' }, { label: 'Deputy Head Girl', value: 'Dangeti Jahnavi' }, { label: 'Deputy Head Boy', value: 'Vedaansh Pal' }] }] }),
      ]),
      page('academics', 'Academics', [
        header('Academics', 'Five stages. One journey.', 'CBSE curriculum, aligned with NEP 2020. Learning by doing, assessment that tracks progress, and equal weight to scholastic and co-scholastic growth.'),
        b({ type: 'cards', columns: 3, items: [
          { tag: 'Foundational', title: 'Bal Vatika 1–3', text: 'At the NCS Foundation Wing, Old Navy Nagar. Play, stories and exploration.' }, { tag: 'Foundational', title: 'Classes I–II', text: 'Reading, numbers and curiosity, at a gentle pace.' },
          { tag: 'Preparatory', title: 'Classes III–V', text: 'Subjects take shape through projects and labs.' }, { tag: 'Middle', title: 'Classes VI–VIII', text: 'Experiments, coding and making things.' },
          { tag: 'Secondary', title: 'Classes IX–XII', text: 'Science, Commerce and Humanities, with career guidance and Naval Dockyard internships.' }] }),
        b({ type: 'table', eyebrow: 'School hours', title: 'A day at NCS.', groups: [
          { title: 'Monday to Friday', rows: [{ label: 'Bal Vatika 1–3', value: '8:30 am – 12:30 pm' }, { label: 'Classes I–II', value: '7:40 am – 1:30 pm' }, { label: 'Classes III–V', value: '7:40 am – 1:45 pm' }, { label: 'Classes VI–XII, Mon–Thu', value: '7:40 am – 2:00 pm' }, { label: 'Classes VI–XII, Friday', value: '7:40 am – 2:30 pm' }] },
          { title: 'Saturdays', rows: [{ label: '1st Saturday · Classes III–V', value: '7:40 am – 12:00 pm' }, { label: '1st Saturday · Classes VI–XII', value: '7:40 am – 1:05 pm' }, { label: '3rd Saturday · Classes VI–XII', value: '7:40 am – 1:05 pm' }] }],
          note: 'Bal Vatika: the last working day of each month is a half day, 8:30 to 10:30 am. Other Saturdays and Sundays are holidays.' }),
        b({ type: 'list', eyebrow: 'Facilities', title: 'Spaces built for learning.', groups: [
          { title: 'Classes I–XII', items: ['Library', 'Computer Lab', 'Samvad Auditorium', 'Physics Lab', 'Chemistry Lab', 'Biology Lab', 'Ramanujan Math Lab', 'STEM Innovation Lab', 'Psychology Lab', 'Science Park', 'Art Room', 'Pottery Room', 'Nishada Music Room', 'Nrityaangan Dance Room', 'Basketball Court', 'Volleyball Court', 'Playtopia Play Park', 'EduBites Cafeteria', 'Infirmary', 'Counsellor Room', 'CCTV across campus'] },
          { title: 'Bal Vatika', items: ['Jungle-Theme Library', 'Reading Corner', 'Obstacle Course', 'Sand Pit', 'Sailor Multi-Activity Play System', 'Dramatic Play Room', 'Activity Rooms', 'Sickbay'] }] }),
        b({ type: 'stats', items: [{ value: '16', label: 'post-graduate teachers' }, { value: '35', label: 'trained graduate teachers' }, { value: '53', label: 'primary teachers' }, { value: '4', label: 'counsellors' }] }),
      ]),
      page('admissions', 'Admissions', [
        header('Admissions', 'Joining NCS.', 'Apply online, then complete the formalities at the school office within seven days. Seats are allotted as per Navy Education Society admission rules.'),
        b({ type: 'steps', title: 'How to apply', items: [
          { title: 'Fill the online form', text: "Child's details, parent's service details and documents." },
          { title: 'Print and get it countersigned', text: "Print the submitted form on A4, back to back, and get it countersigned by the parent's Head of Department where required." },
          { title: 'Submit at the school office', text: 'Working days, 9:30 am to 12:30 pm, within seven days of applying.' },
          { title: 'Get your app login', text: 'Your NES Parent app login arrives by SMS. Fees, attendance and messages are all in the app.' }] }),
        b({ type: 'list', eyebrow: 'Documents', title: 'What to bring.', groups: [
          { title: 'Bal Vatika 1 & Class I', items: ['Original birth certificate, with a copy', 'Aadhaar card of the child and parents'] },
          { title: 'Classes II–IX & XI', items: ['Transfer certificate', 'Last report card', 'Service certificate or transfer order', 'Aadhaar card of the child and parents', 'PEN and APAAR ID'] },
          { title: 'IX–XII after CBSE registration', items: ['Request letter from the parent', 'Transfer certificate and last report card', 'CBSE registration number', "Parent's transfer order, attested by the HOD", 'Service certificate with local address', 'PEN and APAAR ID'] }] }),
        b({ type: 'cards', eyebrow: 'Fees', title: 'Pay online. No charges.', subtitle: 'Fees are collected through State Bank of India. Paying online costs nothing extra, and you can pay for the whole year in advance.', columns: 4, items: [
          { tag: 'Up to the 20th', title: 'No late fee' }, { tag: '21st to month-end', title: '₹100' }, { tag: 'Following month', title: '₹250' }, { tag: 'After two months', title: 'Re-admission' }] }),
      ]),
      page('beyond-the-classroom', 'Beyond the Classroom', [
        header('Beyond the classroom', 'Learning that leaves the room.', 'Sports, culture, service and the sea.'),
        b({ type: 'timeline', items: [
          { when: 'Aug 2026', title: 'Independence Day and Tiranga Yatra', text: 'A Tiranga Yatra on 12 August, then flag hoisting, songs and speeches on 15 August.' },
          { when: 'Aug 2026', title: 'Workshops for students and teachers', text: 'Health and wellness with CBSE, career guidance for Classes X and XII, and adolescent health with INHS Asvini.' },
          { when: 'Jun 2026', title: 'International Yoga Day', text: 'Students and staff practised asanas, pranayama and meditation together on 20 June.' },
          { when: 'May 2026', title: 'Naval Dockyard and Fleet Maintenance Unit internships', text: 'Classes XI and XII spent 4–8 May learning ship maintenance, engineering systems and safety.' },
          { when: '2026–27', title: 'Investiture Ceremony', text: 'The new Student Council was invested; board toppers and Asvini House were honoured.' },
          { when: '2026–27', title: 'Annual Sports Meet', text: 'March past, torch lighting and races from U12 to U19, with yoga, aerobics, lezim, band and hornpipe displays.' },
          { when: 'Nov 2025', title: 'Annual Day · Kala Utsav', text: 'Music, dance and drama on 6 and 7 November.' }] }),
      ]),
      page('achievements', 'Achievements', [
        header('Achievements', 'Shining beyond school.'),
        b({ type: 'toppers', eyebrow: 'Board results 2026', title: 'Toppers by stream.', groups: [
          { title: 'Class X', list: [{ name: 'Sachi Santosh Parage', score: '99.8%' }, { name: 'Avantika Hemant Kandekar', score: '99.4%' }, { name: 'Shriyan Sandeep Ashtikar', score: '98.4%' }, { name: 'Adapala Sai Sri Laasya', score: '98.4%' }] },
          { title: 'Class XII · Science', list: [{ name: 'Arnav Pandey', score: '98.6%' }, { name: 'Anushka Abhimanyu Patankar', score: '97.2%' }, { name: 'Piyush Singh', score: '96.8%' }] },
          { title: 'Class XII · Humanities', list: [{ name: 'Aaroh Rohith Pisharody', score: '98.0%' }, { name: 'Gauri Giri', score: '97.8%' }, { name: 'Ain Ahmed', score: '95.6%' }] },
          { title: 'Class XII · Commerce', list: [{ name: 'Rhea Kumar', score: '92.8%' }, { name: 'Aditya Sharma', score: '91.4%' }, { name: 'Manish Kumar', score: '90.8%' }] }] }),
        b({ type: 'liveToppers', eyebrow: 'This year', title: 'Class toppers.', perClass: 1 }),
        b({ type: 'cards', columns: 2, items: [
          { tag: 'Kathotsav · inter-NCS storytelling · 27 July 2026', title: 'Vedika Misra, Class 11-A, wins second place in English storytelling.', tone: 'navy' },
          { tag: 'Best House Award, 2025–26', title: 'Asvini House', text: 'Co-curricular activities, junior and senior wings.' }] }),
        b({ type: 'cards', eyebrow: 'Proud alumni', title: 'Where they went next.', columns: 3, items: [
          { tag: 'Batch of 2012–13', title: 'Ananya Iyer', text: "Commonwealth Scholar at the London School of Economics, Master's in Social Policy." },
          { tag: 'Batch of 2020–21', title: 'SLt Anshul Bapat', text: 'Commissioned into the Indian Navy as an officer in the Engineering Branch.' },
          { tag: 'Batch of 2024–25', title: 'Feuli Badoni', text: '98.8% in Class XII Commerce. Economics (Hons) at SRCC, Delhi University.' }] }),
      ]),
      page('notices', 'Notices', [
        header('Notices and calendar', "What's coming up."),
        b({ type: 'notices', title: 'Notices', limit: 12 }),
        b({ type: 'calendar', title: 'Holidays and events', limit: 12 }),
      ]),
      page('digital-campus', 'Digital Campus', [
        b({ type: 'hero', style: 'sea', eyebrow: 'NavShiksha', title: 'One school system. Every NES school.', subtitle: 'One secure platform runs admissions, fees, attendance, homework, results and messages across all Navy Education Society schools — so records follow your child wherever the Navy posts you.' }),
        b({ type: 'cards', eyebrow: 'For parents', title: 'School, in your pocket.', columns: 3, items: [
          { title: 'Homework and timetable', text: 'Every assignment, every period, the day it is set.' }, { title: 'Attendance every morning', text: 'Know straight away if your child is marked absent.' },
          { title: 'Notices and calendar', text: 'Circulars from the school, Command and NES, and every holiday.' }, { title: 'Leave in two taps', text: 'Apply for leave; the class teacher approves in the app.' },
          { title: 'Fees at zero charge', text: 'UPI, debit card or net banking. Receipt in seconds.' }, { title: 'Talk to teachers', text: 'Reply to circulars with one tap.' }] }),
        b({ type: 'cards', eyebrow: 'Built for trust', title: "Your child's data, protected.", columns: 3, items: [
          { title: 'Everything is recorded', text: 'Who changed what, and when — kept in a tamper-evident log.', tone: 'dark' },
          { title: 'Receipts can never be edited', text: 'Corrections are new entries, so the history is always complete.', tone: 'dark' },
          { title: 'Access by role', text: 'Each person sees only their own school, class or child.', tone: 'dark' }] }),
        b({ type: 'cta', title: 'Staff of NCS Mumbai?', text: 'Sign in to NavShiksha with your staff ID.', button: { label: 'Staff login', href: '/staff-login' }, tone: 'light' }),
      ]),
      page('contact', 'Contact', [
        header('Contact', "We're here to help.", 'Enter through Gate 2 or Gate 5. The office is open on school days and on the 1st, 3rd and 5th Saturdays from 9:30 am to 1:00 pm.'),
        b({ type: 'contact', places: [
          { label: 'Classes I–XII', name: 'Main School', address: 'Block VII, Navy Nagar, Colaba, Mumbai 400005', phones: ['82916 14970', '86928 00401'], email: 'prin.ncs.mb@gmail.com', mapQuery: 'Navy Children School Navy Nagar Colaba Mumbai' },
          { label: 'Bal Vatika 1–3', name: 'NCS Foundation Wing', address: 'Old Navy Nagar, Colaba, Mumbai 400005', phones: ['022 2214 7472', '72085 12102'], email: 'ncsmumbai.foundation@gmail.com', mapQuery: 'Old Navy Nagar Colaba Mumbai' }] }),
        b({ type: 'table', title: 'Meet us', groups: [{ rows: [
          { label: 'Principal, Vice Principal, Headmistress', value: 'Mon–Fri, 2:15 – 3:00 pm' }, { label: 'Teachers', value: 'Mon & Thu 2:00 – 2:20 pm · Wed 8:00 – 8:45 am' },
          { label: 'Counsellor', value: 'Mon–Fri, 2:00 – 2:30 pm' }] }] }),
        b({ type: 'enquiry', title: 'Send an enquiry', subtitle: 'It reaches the school office, and you get a reference number straight away.' }),
      ]),
    ],
  };
}
