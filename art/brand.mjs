// One core mark for the site and favicon. Run: node art/brand.mjs
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
// The jack: a white ring with a lit centre. One glyph for the header and favicon.
const jack = '<circle cx="16" cy="16" r="9" fill="none" stroke="#f2f2ee" stroke-width="3"/><circle cx="16" cy="16" r="3.2" fill="#39d353"/>';
const mark = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">${jack}</svg>`; // the header: no background
// the favicon: no background either; the ring follows the browser tab's theme so it shows on light tabs too
const favicon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><style>.r{stroke:#f2f2ee}@media (prefers-color-scheme: light){.r{stroke:#141414}}</style>${jack.replace('<circle cx="16" cy="16" r="9"', '<circle class="r" cx="16" cy="16" r="9"').replace(' stroke="#f2f2ee"', '')}</svg>`;
mkdirSync(resolve(root, 'app/public/brand'), { recursive: true });
writeFileSync(resolve(root, 'app/public/brand/mark.svg'), mark + '\n');
writeFileSync(resolve(root, 'app/public/brand/favicon.svg'), favicon + '\n');
for (const page of ['index', 'parts', 'archive', 'docs']) {
  const path = resolve(root, `app/${page}.html`);
  writeFileSync(path, readFileSync(path, 'utf8').replace(/<link rel="icon"[^>]*>/, '<link rel="icon" type="image/svg+xml" href="./brand/favicon.svg" />'));
}
console.log('Site mark and favicon generated.');
