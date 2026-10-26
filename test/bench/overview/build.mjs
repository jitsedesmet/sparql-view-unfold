// Inlines overview-data.json (from analyse.mjs) into template.html and writes the page.
// Usage: node test/bench/overview/build.mjs [out.html]
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const here = import.meta.dirname;
const out = process.argv[2] ?? join(here, 'overview.out.html');
const data = readFileSync(join(here, 'overview-data.json'), 'utf8');
const template = readFileSync(join(here, 'template.html'), 'utf8');
// `</` inside a script would end it early.
const page = template.replace('/*__DATA__*/null', () => data.replaceAll('</', '<\\/'));
writeFileSync(out, page);
process.stdout.write(`${out} (${Math.round(page.length / 1024)} KB)\n`);
