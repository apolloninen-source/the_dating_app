#!/usr/bin/env node
// Validates the v0.8 data files. Exit code 1 on any error.
//   node scripts/validate.mjs
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateCatalog, validateDealbreakers } from '../lib/validate.mjs';

const data = join(dirname(fileURLToPath(import.meta.url)), '..', 'data');
const load = (name) => JSON.parse(readFileSync(join(data, name), 'utf8'));

const catalog = load('traits.v0.8.json');
const dealbreakers = load('dealbreakers.v0.8.json');
const errors = [...validateCatalog(catalog, dealbreakers), ...validateDealbreakers(dealbreakers)];

for (const e of errors) console.error(`  - ${e}`);
console.log(
  errors.length
    ? `${errors.length} error(s)`
    : `ok: ${catalog.counts.total} traits, ${dealbreakers.questions.length} dealbreaker questions`
);
process.exit(errors.length ? 1 : 0);
