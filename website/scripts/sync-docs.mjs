import { readFile, writeFile, copyFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, relative } from 'node:path';

const website = fileURLToPath(new URL('../', import.meta.url));
const root = resolve(website, '..');
await mkdir(resolve(website, 'generated'), { recursive: true });
await mkdir(resolve(website, 'public/images'), { recursive: true });
await copyFile(resolve(root, 'web/public/brand.svg'), resolve(website, 'public/brand.svg'));
await copyFile(resolve(root, '.github/assets/workspace-preview.jpg'), resolve(website, 'public/images/workspace-preview.jpg'));
const docs = [
  ['README.md', 'readme'],
  ['cloudflare/README.md', 'cloudflare'], ['cloudflare/ANIMATION.md', 'animation'],
];
// 保留既有文档地址，用冻结版指引替换旧部署文档副本。
await writeFile(resolve(website, 'generated/server.md'), `---
editLink: false
---

# Node.js / Docker 冻结版

Node.js / Docker 版本保存在 \`codex/nodejs-frozen\` 分支，基线为 \`f3830c4\`。部署命令、环境变量、SQLite 与 FFmpeg 配置见[原始部署文档](https://github.com/znc15/MusicForUrl/blob/f3830c4/README.node-docker.md)。

在已建立冻结分支的本地仓库中，保存当前工作后切换：

\`\`\`sh
git switch codex/nodejs-frozen
\`\`\`

后续 Cloudflare 功能与修复在 \`codex/cloudflare\` 维护，运行方式见 [Cloudflare 部署](../guide/deployment)。
`);
const links = new Map(docs.map(([source, target]) => [source.replaceAll('\\', '/'), '/generated/' + target]));
for (const [source, target] of docs) {
  let text = await readFile(resolve(root, source), 'utf8');
  text = text.replace(/(!?\[(?:[^\[\]]|\[[^\]]*\])*\])\(([^)]+)\)/g, (match, label, url) => {
    if (/^(https?:|#)/.test(url)) return match;
    const [filename, anchor] = url.split('#');
    const path = relative(root, resolve(root, dirname(source), filename)).replaceAll('\\', '/');
    if (path === '.github/assets/workspace-preview.jpg') return label + '(/images/workspace-preview.jpg)';
    const destination = links.get(path) || 'https://github.com/znc15/MusicForUrl/blob/codex/cloudflare/' + path;
    return label + '(' + destination + (anchor ? '#' + anchor : '') + ')';
  });
  await writeFile(resolve(website, 'generated/' + target + '.md'), '---\neditLink: false\n---\n\n' + text);
}
console.log('Synced 3 repository documents, frozen-version guide and website assets.');
