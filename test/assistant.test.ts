/**
 * The assistant renders text produced by a third-party model, from data typed
 * by whoever wrote a transfer memo. So the renderer carries most of these
 * tests: it is the one place where untrusted text becomes markup.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { initDb, openDb, type DB } from '../src/db.ts';
import { renderMarkdown } from '../src/web/markdown.ts';
import { chatPage } from '../src/web/pages.ts';
import {
  addAssistantMessage,
  addUserMessage,
  chatMessages,
  createChat,
  deleteChat,
  getChat,
  listChats,
  titleFrom,
  turnsFor,
} from '../src/llm/store.ts';
import { toolParameters, toolSpecs } from '../src/llm/chat.ts';
import { toolDefs } from '../src/tools/registry.ts';
import { inlineHandlers } from './helpers.ts';

const render = (md: string): string => renderMarkdown(md).value;

describe('markdown is rendered without a passthrough', () => {
  it('shows HTML as text rather than executing it', () => {
    expect(render('<script>alert(1)</script>')).toBe('<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>');
    expect(render('<img src=x onerror=alert(1)>')).not.toContain('<img');
  });

  it('refuses a link scheme that is not http(s)', () => {
    for (const bad of ['javascript:alert(1)', 'data:text/html,<script>', 'vbscript:x']) {
      const out = render(`[click](${bad})`);
      expect(out, bad).not.toContain('<a ');
      expect(out, bad).toContain('[click]');
    }
  });

  it('keeps a real link, and opens it safely', () => {
    const out = render('[docs](https://plaid.com/docs)');
    expect(out).toContain('href="https://plaid.com/docs"');
    expect(out).toContain('rel="noreferrer noopener"');
  });

  it('does not treat markup inside code as emphasis or markup', () => {
    expect(render('`<b>*x*</b>`')).toBe('<p><code>&lt;b&gt;*x*&lt;/b&gt;</code></p>');
  });

  it('renders the shapes a financial answer actually uses', () => {
    expect(render('## Spending')).toBe('<h4>Spending</h4>');
    expect(render('- a\n- b')).toBe('<ul><li>a</li><li>b</li></ul>');
    expect(render('1. a\n2. b')).toBe('<ol><li>a</li><li>b</li></ol>');
    expect(render('> note')).toBe('<blockquote>note</blockquote>');
    expect(render('**a** *b* ~~c~~')).toContain('<strong>a</strong> <em>b</em> <del>c</del>');
  });

  it('renders a table, and right-aligns the columns the model aligned', () => {
    const out = render('| Merchant | Spend |\n|---|--:|\n| Walmart | $75.00 |');
    expect(out).toContain('<th>Merchant</th>');
    expect(out).toContain('<th class="num">Spend</th>');
    expect(out).toContain('<td class="num">$75.00</td>');
    // Wrapped like every other table here, so it scrolls rather than overflows.
    expect(out).toContain('<div class="table-wrap">');
  });

  it('hands a fenced block to the caller, and falls back to code', () => {
    const seen: string[] = [];
    const out = renderMarkdown('```tally-chart\n{"a":1}\n```', (b) => {
      seen.push(b.lang);
      return null;
    }).value;
    expect(seen).toEqual(['tally-chart']);
    expect(out).toContain('<pre class="code-block">');
    expect(out).toContain('{&quot;a&quot;:1}');
  });

  it('survives a block that never closes', () => {
    expect(() => render('```\nunterminated')).not.toThrow();
  });
});

describe('conversation storage', () => {
  let db: DB;
  beforeEach(() => {
    db = initDb(openDb(':memory:'));
  });

  it('titles a thread from its first message', () => {
    expect(titleFrom('  How  am I doing? ')).toBe('How am I doing?');
    expect(titleFrom('')).toBe('New chat');
    expect(titleFrom('x'.repeat(200))).toHaveLength(58);
  });

  it('keeps the transcript, tool runs included', () => {
    const chat = createChat(db, 'how am I doing?');
    addUserMessage(db, chat.id, 'how am I doing?');
    addAssistantMessage(
      db,
      chat.id,
      'Net worth is $1.',
      [{ name: 'get_net_worth', args: {}, ok: true, result: '{}' }],
      'claude-sonnet-4-5',
    );
    const messages = chatMessages(db, chat.id);
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(messages[1]?.runs[0]?.name).toBe('get_net_worth');
    expect(messages[1]?.model).toBe('claude-sonnet-4-5');
  });

  it('does not replay tool results into the next request', () => {
    // They are large, they go stale the moment a sync runs, and the model can
    // always call the tool again. What it keeps is which tools it already used.
    const chat = createChat(db, 'hi');
    addUserMessage(db, chat.id, 'hi');
    addAssistantMessage(
      db,
      chat.id,
      'Hello.',
      [{ name: 'get_net_worth', args: {}, ok: true, result: 'x'.repeat(5000) }],
      'm',
    );
    const turns = turnsFor(db, chat.id);
    const serialised = JSON.stringify(turns);
    expect(serialised).not.toContain('x'.repeat(100));
    expect(serialised).toContain('get_net_worth');
    expect(turns.some((t) => t.role === 'tool')).toBe(false);
  });

  it('deletes a thread and its messages together', () => {
    const chat = createChat(db, 'hi');
    addUserMessage(db, chat.id, 'hi');
    expect(deleteChat(db, chat.id)).toBe(true);
    expect(getChat(db, chat.id)).toBeNull();
    expect(chatMessages(db, chat.id)).toHaveLength(0);
    expect(listChats(db)).toHaveLength(0);
  });
});

describe('the tool surface handed to a model', () => {
  it('converts every tool to a schema without $ref or $schema', () => {
    // Providers disagree about JSON Schema dialects; the safe intersection is a
    // plain object with no references to resolve.
    const specs = toolSpecs(toolDefs(initDb(openDb(':memory:'))));
    expect(specs.length).toBeGreaterThan(30);
    for (const spec of specs) {
      const text = JSON.stringify(spec.parameters);
      expect(text, spec.name).not.toContain('$ref');
      expect(text, spec.name).not.toContain('$schema');
      expect(spec.parameters['type'], spec.name).toBe('object');
      expect(spec.description.length, spec.name).toBeGreaterThan(10);
    }
  });

  it('gives a no-argument tool an empty object, not a missing one', () => {
    const defs = toolDefs(initDb(openDb(':memory:')));
    const noArgs = defs.find((d) => !d.inputSchema || Object.keys(d.inputSchema).length === 0);
    expect(noArgs).toBeDefined();
    expect(toolParameters(noArgs!)).toEqual({
      type: 'object',
      properties: {},
      additionalProperties: false,
    });
  });
});

describe('the chat page', () => {
  const base = {
    nonce: 'n',
    csrf: 'c',
    provider: 'Anthropic',
    model: 'claude-sonnet-4-5',
    chats: [],
    chat: null,
    messages: [],
  };

  it('says the assistant is off, and why, when nothing is configured', () => {
    const out = chatPage({ ...base, ready: false }).value;
    expect(out).toContain('assistant is off');
    expect(out).toContain('Settings');
    // The trade-off is stated on the page, not buried in a doc.
    // The page wraps its copy, so match across whitespace rather than pinning
    // the exact line breaks.
    expect(out).toMatch(/sends\s+balances\s+and\s+transactions/i);
    expect(out).not.toContain('<textarea');
  });

  it('escapes a reply, and never emits an inline handler', () => {
    const out = chatPage({
      ...base,
      ready: true,
      chat: { id: 'c1', title: 'T', created_at: '', updated_at: '2026-09-18' },
      messages: [
        {
          id: 1,
          role: 'assistant',
          content: 'Careful: <img src=x onerror=alert(1)> and [x](javascript:alert(1))',
          model: 'm',
          created_at: '',
          calls: [],
          runs: [{ name: 'get_net_worth', args: { a: '<b>' }, ok: false, result: '<script>' }],
          tool: null,
        },
      ],
    }).value;
    expect(out).not.toContain('<img src=x');
    expect(out).not.toContain('<script>');
    expect(out).toContain('&lt;img');
    expect(inlineHandlers(out)).toEqual([]);
  });

  it('shows the model its working, including which lookups failed', () => {
    const out = chatPage({
      ...base,
      ready: true,
      chat: { id: 'c1', title: 'T', created_at: '', updated_at: '2026-09-18' },
      messages: [
        {
          id: 1,
          role: 'assistant',
          content: 'Done.',
          model: 'm',
          created_at: '',
          calls: [],
          runs: [
            { name: 'get_net_worth', args: {}, ok: true, result: '{}' },
            { name: 'get_holdings', args: {}, ok: false, result: 'error: nope' },
          ],
          tool: null,
        },
      ],
    }).value;
    expect(out).toContain('2 lookups');
    expect(out).toContain('1 failed');
    expect(out).toContain('get_holdings');
  });
});
