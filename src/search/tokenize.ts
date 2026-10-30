import { stemmer } from 'stemmer';

import { splitWords } from '../util/strings.js';

const STOP_WORDS = new Set(
  `a an and are as at be but by can do does for from has have how i if in into is it its me my need
  of on or our should so some that the their them then there these this to use used using want we
  what when where which while who will with without would you your show make let lets get add want
  something thing ui component components`.split(/\s+/),
);

/** Lowercased, stop-word filtered, Porter-stemmed terms. Splits camelCase and kebab-case. */
export function tokenize(text: string): string[] {
  const terms: string[] = [];
  for (const word of splitWords(text)) {
    const lower = word.toLowerCase();
    if (lower.length < 2 || STOP_WORDS.has(lower) || /^\d+$/.test(lower)) continue;
    terms.push(stemmer(lower));
  }
  return terms;
}

/**
 * Everyday UI vocabulary → the words design systems tend to use. Keeps
 * intent search useful without embeddings: "delete" finds `destructive`,
 * "modal" finds `Dialog`.
 */
const SYNONYMS: Record<string, string[]> = {
  modal: ['dialog'],
  popup: ['dialog', 'popover'],
  lightbox: ['dialog'],
  overlay: ['dialog'],
  confirm: ['dialog', 'destructive'],
  confirmation: ['dialog', 'destructive'],
  delete: ['destructive'],
  remove: ['destructive'],
  destroy: ['destructive'],
  danger: ['destructive'],
  dangerous: ['destructive'],
  irreversible: ['destructive'],
  error: ['destructive'],
  btn: ['button'],
  cta: ['button'],
  click: ['button'],
  submit: ['button'],
  action: ['button'],
  textbox: ['input'],
  textfield: ['input'],
  field: ['input'],
  form: ['input'],
  email: ['input'],
  password: ['input'],
  tag: ['badge'],
  chip: ['badge'],
  pill: ['badge'],
  label: ['badge'],
  status: ['badge'],
  lozenge: ['badge'],
  panel: ['card'],
  tile: ['card'],
  container: ['card'],
  box: ['card'],
  surface: ['card'],
  section: ['card'],
  dropdown: ['select', 'menu'],
  picker: ['select', 'calendar'],
  combobox: ['select'],
  notification: ['toast', 'alert'],
  snackbar: ['toast'],
  hint: ['tooltip'],
  toggle: ['switch'],
  tick: ['checkbox'],
  loader: ['spinner', 'skeleton'],
  loading: ['spinner', 'skeleton'],
  divider: ['separator'],
  profile: ['avatar'],
  initials: ['avatar'],
  headshot: ['avatar'],
  gravatar: ['avatar'],
  offcanvas: ['sheet'],
  slideover: ['sheet'],
  expandable: ['accordion'],
  faq: ['accordion'],
  multiline: ['textarea'],
  range: ['slider'],
  date: ['calendar'],
  schedule: ['calendar'],
  palette: ['command'],
  cmdk: ['command'],
};

const STEMMED_SYNONYMS = new Map(
  Object.entries(SYNONYMS).map(([word, related]) => [
    stemmer(word),
    related.map((r) => stemmer(r)),
  ]),
);

/** Query terms plus synonyms; synonyms carry a lower weight. */
export function expandQuery(query: string): Map<string, number> {
  const weights = new Map<string, number>();
  for (const term of tokenize(query)) {
    weights.set(term, Math.max(weights.get(term) ?? 0, 1));
    for (const related of STEMMED_SYNONYMS.get(term) ?? []) {
      weights.set(related, Math.max(weights.get(related) ?? 0, 0.5));
    }
  }
  return weights;
}
