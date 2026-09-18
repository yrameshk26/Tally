/**
 * Conversation persistence. The full turn list is kept, tool calls included,
 * because the transcript is the only record of what this server sent to a third
 * party on the user's behalf — and because a thread is useless if reopening it
 * loses the model's working.
 */
import { randomUUID } from 'node:crypto';
import type { DB } from '../db.ts';
import { nowISO } from '../lib/money.ts';
import type { ToolCall, Turn } from './provider.ts';
import type { ToolRun } from './chat.ts';

export type ChatRow = { id: string; title: string; created_at: string; updated_at: string };

export type StoredMessage = {
  id: number;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  model: string | null;
  created_at: string;
  calls: ToolCall[];
  runs: ToolRun[];
  tool: { id: string; name: string } | null;
};

/** A title from the first message: enough to recognise the thread in a list. */
export function titleFrom(message: string): string {
  const clean = message.replace(/\s+/g, ' ').trim();
  if (clean.length <= 60) return clean || 'New chat';
  return `${clean.slice(0, 57)}…`;
}

export function createChat(db: DB, firstMessage: string, profileId?: string): ChatRow {
  const ts = nowISO();
  const row: ChatRow = { id: randomUUID(), title: titleFrom(firstMessage), created_at: ts, updated_at: ts };
  db.prepare(
    'INSERT INTO chats (id, title, profile_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
  ).run(row.id, row.title, profileId ?? null, ts, ts);
  return row;
}

export function listChats(db: DB, limit = 50): ChatRow[] {
  return db
    .prepare('SELECT id, title, created_at, updated_at FROM chats ORDER BY updated_at DESC LIMIT ?')
    .all(limit) as ChatRow[];
}

export function getChat(db: DB, id: string): ChatRow | null {
  return (
    (db
      .prepare('SELECT id, title, created_at, updated_at FROM chats WHERE id = ?')
      .get(id) as ChatRow | undefined) ?? null
  );
}

export function deleteChat(db: DB, id: string): boolean {
  db.prepare('DELETE FROM chat_messages WHERE chat_id = ?').run(id);
  return db.prepare('DELETE FROM chats WHERE id = ?').run(id).changes > 0;
}

function parseJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== 'string' || !raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function chatMessages(db: DB, chatId: string): StoredMessage[] {
  const rows = db
    .prepare('SELECT * FROM chat_messages WHERE chat_id = ? ORDER BY id')
    .all(chatId) as Array<Record<string, unknown>>;
  return rows.map((r) => {
    const meta = parseJson<Record<string, unknown>>(r['meta'], {});
    return {
      id: Number(r['id']),
      role: String(r['role']) as StoredMessage['role'],
      content: String(r['content'] ?? ''),
      model: (r['model'] as string) ?? null,
      created_at: String(r['created_at']),
      calls: parseJson<ToolCall[]>(JSON.stringify(meta['calls'] ?? []), []),
      runs: parseJson<ToolRun[]>(JSON.stringify(meta['runs'] ?? []), []),
      tool:
        meta['tool_name'] !== undefined
          ? { id: String(meta['tool_id'] ?? ''), name: String(meta['tool_name']) }
          : null,
    };
  });
}

function insert(
  db: DB,
  chatId: string,
  role: string,
  content: string,
  meta: Record<string, unknown> | null,
  model?: string,
): void {
  db.prepare(
    `INSERT INTO chat_messages (chat_id, role, content, meta, model, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(chatId, role, content, meta ? JSON.stringify(meta) : null, model ?? null, nowISO());
}

export function addUserMessage(db: DB, chatId: string, text: string): void {
  insert(db, chatId, 'user', text, null);
  db.prepare('UPDATE chats SET updated_at = ? WHERE id = ?').run(nowISO(), chatId);
}

/** One assistant answer plus the tool calls it took to get there. */
export function addAssistantMessage(
  db: DB,
  chatId: string,
  text: string,
  runs: ToolRun[],
  model: string,
): void {
  insert(db, chatId, 'assistant', text, { runs }, model);
  db.prepare('UPDATE chats SET updated_at = ? WHERE id = ?').run(nowISO(), chatId);
}

/**
 * Rebuild the provider-facing turn list from storage.
 *
 * Tool results are deliberately NOT replayed: they can be enormous, they go
 * stale the moment a sync runs, and the model can always call the tool again.
 * What it keeps is which tools ran, so the model knows what it already looked
 * at in this thread.
 */
export function turnsFor(db: DB, chatId: string): Turn[] {
  const turns: Turn[] = [];
  for (const m of chatMessages(db, chatId)) {
    if (m.role === 'user') {
      turns.push({ role: 'user', text: m.content });
    } else if (m.role === 'assistant') {
      const note = m.runs.length
        ? `\n\n[looked up: ${[...new Set(m.runs.map((r) => r.name))].join(', ')}]`
        : '';
      turns.push({ role: 'assistant', text: `${m.content}${note}`, calls: [] });
    }
  }
  return turns;
}
