// Turn dist/index.html into an Artifact page body (the publisher adds the document skeleton).
import { readFileSync, writeFileSync } from 'node:fs';
const html = readFileSync('dist/index.html', 'utf8');
const head = html.match(/<head>([\s\S]*?)<\/head>/)[1].replace(/<meta charset[^>]*>\s*/, '').replace(/<meta name="viewport"[^>]*>\s*/, '');
const body = html.match(/<body>([\s\S]*?)<\/body>/)[1];
writeFileSync('dist/artifact.html', head.trim() + '\n' + body.trim() + '\n');
console.log('dist/artifact.html written');
