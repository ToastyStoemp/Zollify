import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error - plain-JS shared config, intentionally not typed
import { HOST_EXTERNALS, HOST_LAZY_EXTERNALS } from '../../../../scripts/module-vite.mjs';

/**
 * A module bundle leaves these specifiers external. Each one needs a line in
 * the import map and a host file behind it, or the module fails in the browser
 * with a bare-specifier error - long after the build that caused it passed.
 */
const webDir = resolve(__dirname, '../..');
const html = readFileSync(resolve(webDir, 'index.html'), 'utf8');
const importMap = JSON.parse(/<script type="importmap">([\s\S]*?)<\/script>/.exec(html)![1]!) as { imports: Record<string, string> };
const lazy: string[] = HOST_LAZY_EXTERNALS;
const externals: string[] = [...HOST_EXTERNALS, ...lazy];

const hostName = (target: string): string => target.replace(/^\/host\/|\.js$/g, '');

describe('host entries', () => {
  it('maps exactly what module bundles leave external', () => {
    expect(Object.keys(importMap.imports).sort()).toEqual([...externals].sort());
  });

  it.each(externals)('has a host file behind %s', (specifier) => {
    const target = importMap.imports[specifier]!;
    expect(target).toMatch(/^\/host\/[a-z-]+\.js$/);
    expect(existsSync(resolve(webDir, 'src/host', `${hostName(target)}.ts`))).toBe(true);
  });

  it('builds every host file the import map names', () => {
    const config = readFileSync(resolve(webDir, 'vite.config.ts'), 'utf8');
    for (const target of Object.values(importMap.imports)) expect(config).toContain(`'${hostName(target)}'`);
  });

  it('keeps the on-demand libraries out of the files every start loads', () => {
    // A static import here would put ~900 kB back into every app start.
    const startup = ['src/main.ts', 'src/boot.ts'].map((f) => readFileSync(resolve(webDir, f), 'utf8')).join('\n');
    for (const lib of lazy) expect(startup).not.toMatch(new RegExp(`from ['"]${lib}['"]`));
  });
});
