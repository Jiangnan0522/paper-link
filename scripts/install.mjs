import { copyFileSync, mkdirSync } from 'node:fs';

const dest =
  '/Users/jiangnan/Desktop/Do_not_overthink/obsidian/all/.obsidian/plugins/paper-link';
mkdirSync(dest, { recursive: true });
for (const f of ['main.js', 'manifest.json']) copyFileSync(f, `${dest}/${f}`);
console.log('installed to', dest);
