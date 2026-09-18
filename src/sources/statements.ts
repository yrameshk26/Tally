/**
 * Plaid Statements, fetched on demand and never written to disk.
 *
 * A statement PDF is the most sensitive artifact this system can touch: full
 * account numbers, the mailing address, and every line item, in one file. So it
 * is streamed into a Buffer, handed to the caller, and dropped. There is no
 * cache, no temp file and no database column — `grep -r` for a write path here
 * should come back empty, and that is the point.
 *
 * Statements is a link-time product: an Item that was not linked with it cannot
 * be asked for one, which is why the errors below explain re-consent rather than
 * just failing.
 */
import type { AxiosResponse } from 'axios';
import { createHash } from 'node:crypto';
import type { DB } from '../db.ts';
import { config } from '../config.ts';
import { errMessage, log } from '../lib/logger.ts';
import { accessTokenFor, listItems, plaidClient, plaidErrorDetail } from './plaid.ts';
import type { PlaidItemRow } from './plaid.ts';

export type StatementRef = {
  statement_id: string;
  item_id: string;
  institution: string;
  profile_id: string;
  account_id: string;
  account_name: string;
  account_mask: string;
  month: number;
  year: number;
  date_posted: string | null;
  /** YYYY-MM, for sorting and for asking "the August one". */
  period: string;
};

export type StatementFile = {
  statement_id: string;
  bytes: number;
  /** SHA-256 of the file we received. */
  sha256: string;
  /** Plaid's own checksum header, when sent — equal to sha256 on an intact file. */
  content_hash: string | null;
  verified: boolean;
  pdf: Buffer;
};

/** Plaid caps a statement at 10 MB; refuse anything absurd before buffering it. */
export const MAX_STATEMENT_BYTES = 12 * 1024 * 1024;

function pad2(n: number): string {
  return n < 10 ? `0${String(n)}` : String(n);
}

/**
 * An Item that was linked before Statements was enabled cannot serve one, and
 * Plaid says so with a product error rather than an empty list. Translating it
 * here keeps the fix ("re-consent this bank") next to the failure.
 */
function statementsError(e: unknown, label: string): Error {
  const detail = plaidErrorDetail(e);
  const text = typeof detail === 'string' ? detail : JSON.stringify(detail);
  if (/PRODUCT_NOT_READY|PRODUCTS_NOT_SUPPORTED|ADDITIONAL_CONSENT_REQUIRED|PRODUCT_NOT_ENABLED/i.test(text)) {
    return new Error(
      `${label}: statements are not enabled on this connection. Open Connections and use Repair ` +
        'to re-consent it with statements, or ask Plaid to enable the Statements product on your ' +
        `team. (${text})`,
    );
  }
  return new Error(`${label}: ${text}`);
}

/** Every statement Plaid can offer, across the Items the filter selects. */
export async function listStatements(
  db: DB,
  opts: { profileId?: string; itemId?: string; accountId?: string } = {},
): Promise<{ statements: StatementRef[]; unavailable: Array<{ institution: string; reason: string }> }> {
  const items = listItems(db, opts.profileId).filter(
    (i) => !opts.itemId || i.item_id === opts.itemId,
  );
  const statements: StatementRef[] = [];
  const unavailable: Array<{ institution: string; reason: string }> = [];

  for (const item of items) {
    const label = item.institution_name ?? item.item_id;
    try {
      const res = await plaidClient(db, item.profile_id).statementsList({
        access_token: accessTokenFor(item),
      });
      for (const account of res.data.accounts ?? []) {
        const accountId = `plaid:${account.account_id}`;
        if (opts.accountId && opts.accountId !== accountId) continue;
        for (const s of account.statements ?? []) {
          statements.push({
            statement_id: s.statement_id,
            item_id: item.item_id,
            institution: label,
            profile_id: item.profile_id,
            account_id: accountId,
            account_name: account.account_name,
            account_mask: account.account_mask,
            month: s.month,
            year: s.year,
            date_posted: s.date_posted ?? null,
            period: `${String(s.year)}-${pad2(s.month)}`,
          });
        }
      }
    } catch (e) {
      // One bank without the product must not hide the banks that have it.
      unavailable.push({ institution: label, reason: errMessage(statementsError(e, label)) });
      log.warn('statements: list failed', { institution: label });
    }
  }

  statements.sort((a, b) => b.period.localeCompare(a.period) || a.institution.localeCompare(b.institution));
  return { statements, unavailable };
}

/** The Item a statement belongs to — needed to pick the right credentials. */
async function itemForStatement(
  db: DB,
  statementId: string,
  profileId?: string,
): Promise<{ item: PlaidItemRow; ref: StatementRef }> {
  const { statements } = await listStatements(db, profileId ? { profileId } : {});
  const ref = statements.find((s) => s.statement_id === statementId);
  if (!ref) {
    throw new Error(
      `no statement with id ${statementId} is currently offered. Statement ids are not stable ` +
        'forever — call list_statements again and use a fresh one.',
    );
  }
  const item = listItems(db).find((i) => i.item_id === ref.item_id);
  if (!item) throw new Error(`the connection behind statement ${statementId} is no longer linked`);
  return { item, ref };
}

/**
 * Fetch one statement PDF into memory.
 *
 * `responseType: 'arraybuffer'` matters: without it axios decodes the binary as
 * UTF-8 and silently corrupts the file.
 */
export async function downloadStatement(
  db: DB,
  statementId: string,
  profileId?: string,
): Promise<{ file: StatementFile; ref: StatementRef }> {
  const { item, ref } = await itemForStatement(db, statementId, profileId);
  let res: AxiosResponse<ArrayBuffer>;
  try {
    res = (await plaidClient(db, item.profile_id).statementsDownload(
      { access_token: accessTokenFor(item), statement_id: statementId },
      { responseType: 'arraybuffer' },
    )) as unknown as AxiosResponse<ArrayBuffer>;
  } catch (e) {
    throw statementsError(e, ref.institution);
  }

  const pdf = Buffer.from(res.data);
  if (pdf.byteLength > MAX_STATEMENT_BYTES) {
    throw new Error(
      `statement ${statementId} is ${String(pdf.byteLength)} bytes, over the ` +
        `${String(MAX_STATEMENT_BYTES)} byte cap`,
    );
  }

  const sha256 = createHash('sha256').update(pdf).digest('hex');
  const headers = res.headers as Record<string, unknown>;
  const raw = headers['plaid-content-hash'] ?? headers['Plaid-Content-Hash'];
  const contentHash = typeof raw === 'string' ? raw.toLowerCase() : null;

  // Log the fact, never the file, and never the token that fetched it.
  log.info('statements: downloaded', {
    institution: ref.institution,
    period: ref.period,
    bytes: pdf.byteLength,
    verified: contentHash === null ? 'no-header' : String(contentHash === sha256),
  });

  return {
    ref,
    file: {
      statement_id: statementId,
      bytes: pdf.byteLength,
      sha256,
      content_hash: contentHash,
      verified: contentHash !== null && contentHash === sha256,
      pdf,
    },
  };
}

/** The window Link is asked for when statements are enabled on a new Item. */
export function statementWindow(now = new Date()): { start_date: string; end_date: string } {
  const months = Math.min(Math.max(config.plaid.statementMonths, 1), 24);
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const start = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - months + 1, 1));
  return { start_date: start.toISOString().slice(0, 10), end_date: end.toISOString().slice(0, 10) };
}

export function statementsEnabled(): boolean {
  return [...config.plaid.products, ...config.plaid.optionalProducts].includes('statements');
}
