#!/usr/bin/env node
// Builds the English source catalog (i18n/en.json) that translators work from. Other locales
// are i18n/<bcp47>.json with the same keys; tests fail if en.json drifts from the data files.
//   node scripts/extract-i18n.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const load = (name) => JSON.parse(readFileSync(join(root, 'data', name), 'utf8'));

export function buildSourceCatalog(catalog, dealbreakers) {
  const strings = {
    'scale.1': 'Not at all like me',
    'scale.5': 'Somewhat like me',
    'scale.10': 'Exactly like me'
  };
  for (const d of catalog.domains) strings[d.i18n_key] = d.label;
  for (const g of catalog.scale_groups) strings[g.i18n_key] = g.label;
  for (const t of catalog.traits) strings[t.i18n_key] = t.definition;
  for (const q of dealbreakers.questions) {
    strings[q.i18n_key] = q.question;
    for (const o of q.options) strings[`${q.i18n_key}.option.${o.id}`] = o.label;
  }
  strings['dealbreaker.option.prefer_not_to_say'] = 'Prefer not to say';
  return strings;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const strings = buildSourceCatalog(load('traits.v0.8.json'), load('dealbreakers.v0.8.json'));
  writeFileSync(join(root, 'i18n/en.json'), `${JSON.stringify(strings, null, 2)}\n`);
  console.log(`wrote i18n/en.json: ${Object.keys(strings).length} strings`);
}
