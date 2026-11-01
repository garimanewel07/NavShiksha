/**
 * What each website section looks like in the builder: its name, the fields an editor fills in,
 * and its starting content. The server validates the same shapes (server/src/lib/siteSchema.ts),
 * so a new section type is added in both places and in SiteView.
 */
export type Field =
  | { key: string; label: string; kind: 'text' | 'textarea'; optional?: boolean; help?: string; max?: number }
  | { key: string; label: string; kind: 'number'; min: number; max: number }
  | { key: string; label: string; kind: 'select'; options: [string | number, string][] }
  | { key: string; label: string; kind: 'link'; optional?: boolean }
  | { key: string; label: string; kind: 'strings'; itemLabel: string }
  | { key: string; label: string; kind: 'list'; itemLabel: string; fields: Field[]; make: () => Record<string, unknown> }
  | { key: string; label: string; kind: 'image'; help?: string }
  | { key: string; label: string; kind: 'file'; help?: string };

const HEAD: Field[] = [
  { key: 'eyebrow', label: 'Small heading', kind: 'text', optional: true, max: 60 },
  { key: 'title', label: 'Heading', kind: 'text', optional: true, max: 140 },
  { key: 'subtitle', label: 'Introduction', kind: 'textarea', optional: true, max: 400 },
];

export const BLOCKS: Record<string, { label: string; hint: string; fields: Field[]; make: () => Record<string, unknown> }> = {
  hero: { label: 'Banner', hint: 'Big heading at the top of a page', make: () => ({ style: 'plain', title: 'New page' }), fields: [
    { key: 'style', label: 'Style', kind: 'select', options: [['sea', 'Navy sea and sunrise'], ['photo', 'Photo behind the heading'], ['plain', 'Plain heading']] },
    { key: 'image', label: 'Banner photo', kind: 'image', help: 'Shown behind the heading when the style is “Photo behind the heading”. A wide photo of the school works best.' },
    { key: 'eyebrow', label: 'Small heading', kind: 'text', optional: true, max: 80 },
    { key: 'title', label: 'Heading', kind: 'text', max: 120 },
    { key: 'subtitle', label: 'Introduction', kind: 'textarea', optional: true, max: 400 },
    { key: 'primary', label: 'Main button', kind: 'link', optional: true },
    { key: 'secondary', label: 'Second link', kind: 'link', optional: true }] },
  stats: { label: 'Numbers', hint: 'Two to four big figures', make: () => ({ items: [{ value: '1984', label: 'established' }, { value: '100+', label: 'teachers' }] }), fields: [
    { key: 'items', label: 'Figures', kind: 'list', itemLabel: 'figure', make: () => ({ value: '', label: '' }), fields: [
      { key: 'value', label: 'Number', kind: 'text', max: 16 }, { key: 'label', label: 'Label', kind: 'text', max: 60 }] }] },
  text: { label: 'Text', hint: 'Paragraphs of writing', make: () => ({ title: 'Heading', body: 'Write here. Leave an empty line between paragraphs.' }), fields: [
    ...HEAD, { key: 'body', label: 'Text', kind: 'textarea', max: 6000, help: 'Leave an empty line between paragraphs.' },
    { key: 'image', label: 'Photo beside the text (optional)', kind: 'image' },
    { key: 'imageSide', label: 'Photo on the', kind: 'select', options: [['right', 'Right'], ['left', 'Left']] }] },
  message: { label: 'Message', hint: 'A quote with a name, such as the Principal’s message', make: () => ({ label: 'From the Principal', quote: 'A short quote.', name: 'Name', role: 'Principal' }), fields: [
    { key: 'label', label: 'Small heading', kind: 'text', optional: true, max: 60 }, { key: 'quote', label: 'Quote', kind: 'textarea', max: 400 },
    { key: 'body', label: 'More text', kind: 'textarea', optional: true, max: 1500 }, { key: 'name', label: 'Name', kind: 'text', max: 80 },
    { key: 'role', label: 'Role', kind: 'text', optional: true, max: 80 }, { key: 'photo', label: 'Photo (optional)', kind: 'image' }, { key: 'link', label: 'Link', kind: 'link', optional: true }] },
  cards: { label: 'Cards', hint: 'A grid of tiles: houses, stages, achievements', make: () => ({ title: 'Heading', columns: 3, items: [{ title: 'Card title', text: 'A line about it.' }] }), fields: [
    ...HEAD, { key: 'columns', label: 'Columns', kind: 'select', options: [[2, 'Two'], [3, 'Three'], [4, 'Four']] },
    { key: 'items', label: 'Cards', kind: 'list', itemLabel: 'card', make: () => ({ title: '', text: '' }), fields: [
      { key: 'tag', label: 'Small label', kind: 'text', optional: true, max: 80 }, { key: 'title', label: 'Title', kind: 'text', max: 200 },
      { key: 'text', label: 'Text', kind: 'textarea', optional: true, max: 600 },
      { key: 'tone', label: 'Colour', kind: 'select', options: [['light', 'White'], ['navy', 'Navy'], ['dark', 'Black']] },
      { key: 'image', label: 'Photo on the card (optional)', kind: 'image' }] }] },
  people: { label: 'People', hint: 'Leadership or staff with roles', make: () => ({ title: 'Leadership', items: [{ name: 'Name', role: 'Role' }] }), fields: [
    ...HEAD, { key: 'items', label: 'People', kind: 'list', itemLabel: 'person', make: () => ({ name: '', role: '' }), fields: [
      { key: 'name', label: 'Name', kind: 'text', max: 90 }, { key: 'role', label: 'Role', kind: 'text', optional: true, max: 120 }, { key: 'photo', label: 'Photo (optional)', kind: 'image' }] }] },
  toppers: { label: 'Toppers', hint: 'Results by class or stream', make: () => ({ title: 'Our toppers', groups: [{ title: 'Class X', list: [{ name: 'Name', score: '98.0%' }] }] }), fields: [
    ...HEAD, { key: 'groups', label: 'Groups', kind: 'list', itemLabel: 'group', make: () => ({ title: '', list: [{ name: '', score: '' }] }), fields: [
      { key: 'title', label: 'Class or stream', kind: 'text', max: 60 },
      { key: 'list', label: 'Students', kind: 'list', itemLabel: 'student', make: () => ({ name: '', score: '' }), fields: [
        { key: 'name', label: 'Name', kind: 'text', max: 80 }, { key: 'score', label: 'Score', kind: 'text', max: 12 },
        { key: 'photo', label: 'Photo (optional, with the family’s consent)', kind: 'image' }] }] }] },
  timeline: { label: 'Timeline', hint: 'Events in order', make: () => ({ title: 'This year', items: [{ when: 'Aug 2026', title: 'Event', text: '' }] }), fields: [
    ...HEAD, { key: 'items', label: 'Events', kind: 'list', itemLabel: 'event', make: () => ({ when: '', title: '', text: '' }), fields: [
      { key: 'when', label: 'When', kind: 'text', max: 30 }, { key: 'title', label: 'Title', kind: 'text', max: 120 }, { key: 'text', label: 'Text', kind: 'textarea', optional: true, max: 800 }] }] },
  list: { label: 'List', hint: 'Facilities, clubs or documents as chips', make: () => ({ title: 'Facilities', groups: [{ title: '', items: ['Library'] }] }), fields: [
    ...HEAD, { key: 'groups', label: 'Groups', kind: 'list', itemLabel: 'group', make: () => ({ title: '', items: [''] }), fields: [
      { key: 'title', label: 'Group heading', kind: 'text', optional: true, max: 60 }, { key: 'items', label: 'Items', kind: 'strings', itemLabel: 'item' }] }] },
  table: { label: 'Table', hint: 'Label and value rows: timings, council', make: () => ({ title: 'School hours', groups: [{ title: '', rows: [{ label: 'Classes I–V', value: '7:40 am – 1:30 pm' }] }] }), fields: [
    ...HEAD, { key: 'groups', label: 'Tables', kind: 'list', itemLabel: 'table', make: () => ({ title: '', rows: [{ label: '', value: '' }] }), fields: [
      { key: 'title', label: 'Table heading', kind: 'text', optional: true, max: 60 },
      { key: 'rows', label: 'Rows', kind: 'list', itemLabel: 'row', make: () => ({ label: '', value: '' }), fields: [
        { key: 'label', label: 'Label', kind: 'text', max: 120 }, { key: 'value', label: 'Value', kind: 'text', max: 120 }] }] },
    { key: 'note', label: 'Note below', kind: 'textarea', optional: true, max: 400 }] },
  steps: { label: 'Steps', hint: 'A numbered process', make: () => ({ title: 'How to apply', items: [{ title: 'First step', text: '' }] }), fields: [
    ...HEAD, { key: 'items', label: 'Steps', kind: 'list', itemLabel: 'step', make: () => ({ title: '', text: '' }), fields: [
      { key: 'title', label: 'Step', kind: 'text', max: 120 }, { key: 'text', label: 'Detail', kind: 'textarea', optional: true, max: 500 }] }] },
  notices: { label: 'Live notices', hint: 'Public notices from the ERP, updated automatically', make: () => ({ title: 'Notices', limit: 5 }), fields: [
    ...HEAD, { key: 'limit', label: 'How many', kind: 'number', min: 1, max: 20 }] },
  calendar: { label: 'Live calendar', hint: 'Holidays and events from the ERP calendar', make: () => ({ title: 'Coming up', limit: 6 }), fields: [
    ...HEAD, { key: 'limit', label: 'How many', kind: 'number', min: 1, max: 20 }] },
  liveToppers: { label: 'Live toppers', hint: 'Class toppers from the latest published exam in the ERP, updated automatically', make: () => ({ eyebrow: 'Results', title: 'Class toppers', perClass: 1 }), fields: [
    ...HEAD, { key: 'perClass', label: 'Students per class', kind: 'number', min: 1, max: 3 }] },
  contact: { label: 'Contact', hint: 'Addresses, phones and directions', make: () => ({ places: [{ name: 'Main School', address: '', phones: [''] }] }), fields: [
    ...HEAD, { key: 'places', label: 'Places', kind: 'list', itemLabel: 'place', make: () => ({ name: '', address: '', phones: [''] }), fields: [
      { key: 'label', label: 'Small label', kind: 'text', optional: true, max: 40 }, { key: 'name', label: 'Name', kind: 'text', max: 80 },
      { key: 'address', label: 'Address', kind: 'text', max: 200 }, { key: 'phones', label: 'Phone numbers', kind: 'strings', itemLabel: 'phone' },
      { key: 'email', label: 'Email', kind: 'text', optional: true, max: 120 }, { key: 'mapQuery', label: 'Map search', kind: 'text', optional: true, max: 200, help: 'What to search on Google Maps for directions.' }] },
    { key: 'note', label: 'Note below', kind: 'textarea', optional: true, max: 600 }] },
  slider: { label: 'Photo slider', hint: 'Large photos of the school that change by themselves, with a heading over them', make: () => ({ title: '', height: 'tall', seconds: 6, slides: [{ assetId: '', caption: '' }, { assetId: '', caption: '' }, { assetId: '', caption: '' }] }), fields: [
    { key: 'slides', label: 'Photos', kind: 'list', itemLabel: 'photo', make: () => ({ assetId: '', caption: '' }), fields: [
      { key: 'assetId', label: 'Photo', kind: 'image', help: 'Wide photos (landscape) of the campus, buildings or events work best.' }, { key: 'caption', label: 'Caption', kind: 'text', optional: true, max: 120 }] },
    { key: 'title', label: 'Heading over the photos', kind: 'text', optional: true, max: 120 }, { key: 'subtitle', label: 'Line under it', kind: 'textarea', optional: true, max: 300 },
    { key: 'primary', label: 'Button', kind: 'link', optional: true },
    { key: 'height', label: 'Height', kind: 'select', options: [['tall', 'Tall'], ['medium', 'Medium']] },
    { key: 'seconds', label: 'Change photo every (seconds, 0 = never)', kind: 'number', min: 0, max: 15 }] },
  showcase: { label: 'Photo and text rows', hint: 'Facilities, buildings, labs or activities: a photo beside a few lines, alternating', make: () => ({ title: 'Facilities', items: [{ title: 'Library', text: '', image: '' }, { title: 'Science laboratories', text: '', image: '' }] }), fields: [
    ...HEAD, { key: 'items', label: 'Rows', kind: 'list', itemLabel: 'row', make: () => ({ title: '', text: '', image: '' }), fields: [
      { key: 'image', label: 'Photo', kind: 'image' }, { key: 'title', label: 'Title', kind: 'text', max: 120 }, { key: 'text', label: 'Text', kind: 'textarea', optional: true, max: 800 },
      { key: 'link', label: 'Link', kind: 'link', optional: true }] }] },
  video: { label: 'Videos', hint: 'YouTube videos of events, played on the page', make: () => ({ title: 'Videos', items: [{ url: '', title: '' }] }), fields: [
    ...HEAD, { key: 'items', label: 'Videos', kind: 'list', itemLabel: 'video', make: () => ({ url: '', title: '' }), fields: [
      { key: 'url', label: 'YouTube link', kind: 'text', max: 200, help: 'Copy the link from YouTube’s Share button, e.g. https://youtu.be/…' }, { key: 'title', label: 'Title', kind: 'text', optional: true, max: 120 }] }] },
  documents: { label: 'Downloads', hint: 'PDFs to open: almanac, syllabus, mandatory disclosure, forms', make: () => ({ title: 'Downloads', items: [{ assetId: '', title: 'School almanac', note: '' }] }), fields: [
    ...HEAD, { key: 'items', label: 'Files', kind: 'list', itemLabel: 'file', make: () => ({ assetId: '', title: '', note: '' }), fields: [
      { key: 'assetId', label: 'PDF', kind: 'file' }, { key: 'title', label: 'Title', kind: 'text', max: 120 }, { key: 'note', label: 'Note', kind: 'text', optional: true, max: 200 }] }] },
  faq: { label: 'Questions', hint: 'Frequently asked questions that open when clicked', make: () => ({ title: 'Frequently asked questions', items: [{ q: 'A question parents ask', a: 'The answer.' }] }), fields: [
    ...HEAD, { key: 'items', label: 'Questions', kind: 'list', itemLabel: 'question', make: () => ({ q: '', a: '' }), fields: [
      { key: 'q', label: 'Question', kind: 'text', max: 200 }, { key: 'a', label: 'Answer', kind: 'textarea', max: 1500 }] }] },
  gallery: { label: 'Photo album', hint: 'Photos in a grid or mosaic; visitors click to see them large', make: () => ({ title: 'Gallery', layout: 'mosaic', images: [{ assetId: '', caption: '' }, { assetId: '', caption: '' }, { assetId: '', caption: '' }] }), fields: [
    ...HEAD, { key: 'layout', label: 'Layout', kind: 'select', options: [['mosaic', 'Mosaic (mixed sizes)'], ['grid', 'Even grid']] },
    { key: 'images', label: 'Photos', kind: 'list', itemLabel: 'photo', make: () => ({ assetId: '', caption: '' }), fields: [
      { key: 'assetId', label: 'Photo', kind: 'image' }, { key: 'caption', label: 'Caption', kind: 'text', optional: true, max: 120 }] }] },
  cta: { label: 'Call to action', hint: 'A highlighted line with a button', make: () => ({ title: 'Apply for admission', tone: 'light', button: { label: 'Admissions', href: '/admissions' } }), fields: [
    { key: 'title', label: 'Heading', kind: 'text', max: 120 }, { key: 'text', label: 'Text', kind: 'textarea', optional: true, max: 400 },
    { key: 'button', label: 'Button', kind: 'link' }, { key: 'tone', label: 'Colour', kind: 'select', options: [['light', 'White'], ['dark', 'Black']] }] },
  enquiry: { label: 'Enquiry form', hint: 'Visitors send a message to the school office', make: () => ({ title: 'Send an enquiry' }), fields: HEAD },
};

export const newId = () => Math.random().toString(36).slice(2, 10).padEnd(8, '0');

/** A short name for a section in the list, taken from its own content. */
export function blockTitle(b: Record<string, any>): string {
  return b.title || b.quote || b.label || b.eyebrow || (b.items?.[0]?.value ? b.items.map((i: any) => i.value).join(' · ') : '') || BLOCKS[b.type]?.label || b.type;
}
