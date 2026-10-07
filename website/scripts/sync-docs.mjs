import { readFile, writeFile, copyFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, relative } from 'node:path';

const website = fileURLToPath(new URL('../', import.meta.url));
const root = resolve(website, '..');
await mkdir(resolve(website, 'generated'), { recursive: true });
await mkdir(resolve(website, 'public/images'), { recursive: true });
await copyFile(resolve(root, 'public/brand.svg'), resolve(website, 'public/brand.svg'));
await copyFile(resolve(root, '.github/assets/workspace-preview.jpg'), resolve(website, 'public/images/workspace-preview.jpg'));
const docs = [
  ['README.md', 'readme'], ['README.node-docker.md', 'server'],
  ['cloudflare/README.md', 'cloudflare'], ['cloudflare/ANIMATION.md', 'animation'],
];
const links = new Map(docs.map(([source, target]) => [source.replaceAll('\\', '/'), '/generated/' + target]));
for (const [source, target] of docs) {
  let text = await readFile(resolve(root, source), 'utf8');
  text = text.replace(/(!?\[[^\]]*\])\(([^)]+)\)/g, (match, label, url) => {
    if (/^(https?:|#)/.test(url)) return match;
    const [filename, anchor] = url.split('#');
    const path = relative(root, resolve(root, dirname(source), filename)).replaceAll('\\', '/');
    if (path === '.github/assets/workspace-preview.jpg') return label + '(/images/workspace-preview.jpg)';
    const destination = links.get(path) || 'https://github.com/znc15/MusicForUrl/blob/master/' + path;
    return label + '(' + destination + (anchor ? '#' + anchor : '') + ')';
  });
  await writeFile(resolve(website, 'generated/' + target + '.md'), '---\neditLink: false\n---\n\n' + text);
}
console.log('Synced 4 repository documents and website assets.');
