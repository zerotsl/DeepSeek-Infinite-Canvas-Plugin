import { readFileSync, writeFileSync } from 'node:fs';
const path = 'E:/无限画布/packages/infinite-canvas/client.js';
let text = readFileSync(path, 'utf8');
const before = /const CLIENT_BUILD = '([^']+)';/.exec(text);
if (!before) {
  console.log('build marker not found');
  process.exit(1);
}
console.log('old build:', before[1]);
text = text.replace(/const CLIENT_BUILD = '[^']+';/, "const CLIENT_BUILD = '2026-10-21.94';");
writeFileSync(path, text);
console.log('new build:', /const CLIENT_BUILD = '([^']+)';/.exec(text)[1]);
