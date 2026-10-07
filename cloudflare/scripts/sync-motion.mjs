import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const { version } = require('gsap/package.json');
const source = await readFile(require.resolve('gsap/dist/gsap.min.js'), 'utf8');
const destination = new URL('../../public/js/vendor/', import.meta.url);
await mkdir(destination, { recursive: true });
// Keep the upstream license banner; omit the optional development source map.
await writeFile(new URL(`gsap-${version}.min.js`, destination), source.replace(/\/\/# sourceMappingURL=.*$/m, ''));
console.log(`GSAP ${version}: local browser asset ready`);
const hlsVersion = require('hls.js/package.json').version;
const hlsSource = await readFile(require.resolve('hls.js/dist/hls.min.js'), 'utf8');
await writeFile(new URL('hls.min.js', destination), hlsSource.replace(/\/\/# sourceMappingURL=.*$/m, ''));
await writeFile(new URL('hls.LICENSE.txt', destination), await readFile(join(dirname(require.resolve('hls.js/package.json')), 'LICENSE'), 'utf8'));
const appPackage = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
await writeFile(new URL('../../public/app-meta.json', import.meta.url), JSON.stringify({
  version: appPackage.version, gsap: version, hls: hlsVersion,
}) + '\n');
console.log(`Hls.js ${hlsVersion}: local browser asset ready`);
