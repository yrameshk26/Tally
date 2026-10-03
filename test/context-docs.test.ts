/**
 * The agent context in docs/context/ is only useful while it is true. This does
 * not judge prose; it checks the parts a machine can: that what the code defines
 * (source files, tables, MCP tools, environment variables, settings) is named in
 * PROJECT.md, that the tool table names nothing that no longer exists, that the
 * links between the documents resolve, and that no personal identifier has been
 * written into a Markdown file of a public repository.
 *
 * If this fails after you changed code, update docs/context/PROJECT.md (and the
 * other files per docs/context/README.md) in the same commit. Do not weaken it.
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { initDb, openDb } from '../src/db.ts';
import { MANAGED_KEYS } from '../src/settings.ts';
import { toolDefs } from '../src/tools/registry.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string): string => readFileSync(join(root, p), 'utf8');
const project = read('docs/context/PROJECT.md');

function walk(dir: string, keep: (p: string) => boolean, out: string[] = []): string[] {
  for (const name of readdirSync(join(root, dir))) {
    if (['node_modules', 'dist', 'data', '.git', 'coverage'].includes(name)) continue;
    const rel = `${dir}/${name}`.replace(/^\.\//, '');
    if (statSync(join(root, rel)).isDirectory()) walk(rel, keep, out);
    else if (keep(rel)) out.push(rel);
  }
  return out;
}

const named = (s: string): boolean => project.includes(`\`${s}\``);

describe('PROJECT.md describes what the code defines', () => {
  it('names every source and script file', () => {
    const files = [...walk('src', (p) => p.endsWith('.ts')), ...walk('scripts', (p) => p.endsWith('.ts'))];
    const missing = files.filter((f) => !named(f));
    expect(missing, `add these to the source map in docs/context/PROJECT.md: ${missing.join(', ')}`).toEqual([]);
  });

  it('names every database table', () => {
    const tables = [...read('src/db.ts').matchAll(/CREATE TABLE IF NOT EXISTS (\w+)\s*\(/g)].map((m) => m[1]!);
    expect(tables.length).toBeGreaterThan(20);
    const missing = tables.filter((t) => !named(t));
    expect(missing, `add these to the data model in docs/context/PROJECT.md: ${missing.join(', ')}`).toEqual([]);
  });

  it('names every MCP tool, and the tool table names nothing that is gone', () => {
    const real = toolDefs(initDb(openDb(':memory:'))).map((t) => t.name);
    const missing = real.filter((t) => !named(t));
    expect(missing, `add these to the tool table in docs/context/PROJECT.md: ${missing.join(', ')}`).toEqual([]);

    const section = project.slice(project.indexOf('## 8. MCP tools'), project.indexOf('## 9. Web routes'));
    const documented = [...section.matchAll(/^\| `([a-z_]+)`/gm)].map((m) => m[1]!);
    const gone = documented.filter((t) => !real.includes(t));
    expect(gone, `these tools are documented but no longer exist: ${gone.join(', ')}`).toEqual([]);
  });

  it('names every environment variable the configuration reads', () => {
    const vars = [...read('src/config.ts').matchAll(/\b(?:str|int|bool|list)\('([A-Z0-9_]+)'/g)].map((m) => m[1]!);
    expect(vars.length).toBeGreaterThan(30);
    const missing = [...new Set(vars)].filter((v) => !named(v));
    expect(missing, `add these to the configuration tables in docs/context/PROJECT.md: ${missing.join(', ')}`).toEqual([]);
  });

  it('names every setting the Settings page can store', () => {
    const missing = MANAGED_KEYS.filter((k) => !named(k));
    expect(missing, `add these to the managed settings table in docs/context/PROJECT.md: ${missing.join(', ')}`).toEqual([]);
  });
});

describe('the context directory hangs together', () => {
  const docs = walk('docs/context', (p) => p.endsWith('.md'));

  it('has every document the index promises', () => {
    for (const f of ['README', 'PROJECT', 'FEATURES', 'HISTORY', 'OPERATIONS', 'OWNER-AND-COMMUNITY', 'BACKLOG']) {
      expect(docs, `docs/context/${f}.md is missing`).toContain(`docs/context/${f}.md`);
    }
  });

  it('only links to files that exist', () => {
    const broken: string[] = [];
    for (const doc of [...docs, 'AGENTS.md']) {
      for (const m of read(doc).matchAll(/\]\(([^)\s]+)\)/g)) {
        const target = m[1]!.split('#')[0]!;
        if (!target || /^[a-z]+:/i.test(target)) continue;
        if (!existsSync(resolve(root, dirname(doc), target))) broken.push(`${doc} -> ${target}`);
      }
    }
    expect(broken).toEqual([]);
  });

  it('is required by the project rules', () => {
    expect(read('CLAUDE.md')).toContain('docs/context');
    expect(read('AGENTS.md')).toContain('docs/context/README.md');
  });
});

describe('no personal identifier in a Markdown file of a public repository', () => {
  // Built from parts so this file does not itself spell the owner's domain.
  const forbidden: Array<[string, RegExp]> = [
    ['the owner’s live domain', new RegExp(['tal', 'nt', '\\.fit'].join(''), 'i')],
    ['a Claude session link', /claude\.ai\/code\/session_/i],
    ['a routine or trigger id', /\btrig_[A-Za-z0-9]{10,}/],
    ['a Plaid token or link token', /\b(?:access|public|link)-(?:production|sandbox|development)-[0-9a-f-]{12,}/i],
    ['a Plaid account or transaction id', /\bplaid:[A-Za-z0-9]{24,}/],
    ['an API key', /\bsk-[A-Za-z0-9_-]{20,}/],
  ];

  it('holds for every .md file', () => {
    const hits: string[] = [];
    for (const f of walk('.', (p) => p.endsWith('.md'))) {
      const text = read(f);
      for (const [what, re] of forbidden) if (re.test(text)) hits.push(`${f}: ${what}`);
    }
    expect(hits, 'remove these: the repository is public (docs/context/README.md)').toEqual([]);
  });
});
