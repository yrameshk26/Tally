/**
 * The tool surface, declared once and served over two transports: MCP (src/mcp.ts)
 * and the built-in chat assistant (src/llm/). Declaring them here rather than
 * inside the MCP server is what keeps the two honest — the assistant cannot
 * reach a capability MCP does not have, and the read-only guarantee in rule 1
 * of CLAUDE.md is enforced in one place instead of two.
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { DB } from '../db.ts';
import { getDb } from '../db.ts';
import { config } from '../config.ts';
import { errMessage } from '../lib/logger.ts';
import { daysAgoISO, todayISO } from '../lib/money.ts';
import {
  getActivities,
  getCashflow,
  getContributionRoom,
  getHoldings,
  getHoldingsByAccount,
  getNetWorth,
  getNetWorthHistory,
  getTransactions,
  groupByCategory,
  groupByMerchant,
  knownCategories,
  listAccounts,
  setAccountProfile,
  setContributed,
  setRoomLimit,
} from '../queries.ts';
import { DEFAULT_SECTIONS, SUMMARY_SECTIONS, buildSummary, type SummarySection } from '../summary.ts';
import {
  MAX_PROFILES,
  createProfile,
  deleteProfile,
  listProfiles,
  profileUsage,
  renameProfile,
} from '../profiles.ts';
import { createUpdateLinkToken, plaidStatus, plaidUsage } from '../sources/plaid.ts';
import {
  downloadStatement,
  listStatements,
  statementsEnabled,
} from '../sources/statements.ts';
import {
  MATCH_TYPES,
  addCategory,
  addMerchantRule,
  customCategories,
  deleteCategory,
  setMerchantCategory,
  deleteMerchantRule,
  listMerchantRules,
  ruleImpact,
  setAccountCurrency,
  setTransactionOverride,
} from '../overrides.ts';
import { lastSyncReport, runSync } from '../sync.ts';
import { pruneBackups, writeBackup } from '../backup.ts';

/** Profiles are user-defined, so this is a free-form id rather than an enum. */
const PROFILE = z.string().min(1).max(32);
const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');

function ok(data: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

function fail(e: unknown): CallToolResult {
  return { content: [{ type: 'text', text: `error: ${errMessage(e)}` }], isError: true };
}

const READ_ONLY = { readOnlyHint: true, openWorldHint: false } as const;

/** Server-level guidance, sent to MCP clients and prepended to assistant chats. */
export const TOOL_INSTRUCTIONS =
      'Read-only personal net worth for one household. Balances are reported in ' +
      `${config.baseCurrency}; assets are positive and liabilities negative. In get_transactions ` +
      'and get_cashflow a negative amount means money left the account. Accounts belong to a ' +
      'profile — call list_profiles to see them. A profile is both a person/bucket and its own ' +
      'set of provider credentials, so each one has its own bank-connection allowance. Data is ' +
      'refreshed by a nightly sync — call sync_report to see how stale it is, or sync_now to ' +
      'refresh on demand. For a broad question ("how am I doing?", "what does my year look ' +
      'like?") call get_financial_summary once instead of chaining the narrow tools — it ' +
      'returns the whole picture and takes a `sections` list to narrow it down.';

export type ToolDef = {
  name: string;
  title: string;
  description: string;
  inputSchema?: z.ZodRawShape;
  annotations: Record<string, boolean>;
  handler: (args: Record<string, unknown>) => CallToolResult | Promise<CallToolResult>;
};

/**
 * Identity function whose only job is inference: it ties each handler's `args`
 * to that tool's own inputSchema, so a typo in a field name is a type error
 * rather than something the LLM discovers at runtime.
 */
function tool<S extends z.ZodRawShape>(def: {
  name: string;
  title: string;
  description: string;
  inputSchema?: S;
  annotations: Record<string, boolean>;
  handler: (
    args: z.objectOutputType<S, z.ZodTypeAny>,
  ) => CallToolResult | Promise<CallToolResult>;
}): ToolDef {
  return def as unknown as ToolDef;
}

/** Every tool, bound to one database. */
export function toolDefs(db: DB): ToolDef[] {
  return [
  tool({
    name: 'get_net_worth',
    title: 'Net worth',
    description:
      'Total household net worth in CAD with breakdowns by owner, registered account type ' +
      '(RRSP/TFSA/LIRA/DPSP/NON_REG), source and institution.',
    inputSchema: { profile: PROFILE.optional().describe('limit to one profile id') },
    annotations: READ_ONLY,
    handler: ({ profile }) => {
      try {
        return ok(getNetWorth(db, profile));
      } catch (e) {
        return fail(e);
      }
    },
  }),
  tool({
    name: 'get_net_worth_history',
    title: 'Net worth history',
    description:
      'Daily net-worth snapshots. Starts the day the server first syncs unless a SnapTrade ' +
      'balance-history backfill was imported (those rows have origin "snaptrade").',
    inputSchema: {
      start: DATE.optional(),
      end: DATE.optional(),
      limit: z.number().int().min(1).max(2000).optional(),
    },
    annotations: READ_ONLY,
    handler: (args) => {
      try {
        return ok(getNetWorthHistory(db, args));
      } catch (e) {
        return fail(e);
      }
    },
  }),
  tool({
    name: 'list_accounts',
    title: 'List accounts',
    description:
      'Every account across SnapTrade, Plaid and Wise with balance, currency, registered type ' +
      'and owner. Credit cards include statement balance, minimum payment and due date when ' +
      'Plaid liabilities are available.',
    inputSchema: {
      profile: PROFILE.optional(),
      source: z.enum(['snaptrade', 'plaid', 'wise', 'manual']).optional(),
      include_inactive: z.boolean().optional().describe('include closed/excluded accounts'),
    },
    annotations: READ_ONLY,
    handler: (args) => {
      try {
        const accounts = listAccounts(db, args);
        return ok({ count: accounts.length, accounts });
      } catch (e) {
        return fail(e);
      }
    },
  }),
  tool({
    name: 'get_holdings',
    title: 'Holdings',
    description:
      'Positions rolled up by symbol across all brokerage accounts, in CAD, largest first, ' +
      'with each position as a percentage of invested value (concentration). Pass ' +
      'by_account: true to group by account instead. Invested value can sit below the account ' +
      'balance when a brokerage reports a managed portfolio\u2019s value without its positions.',
    inputSchema: {
      profile: PROFILE.optional(),
      account_id: z.string().optional(),
      include_cash: z.boolean().optional(),
      by_account: z
        .boolean()
        .optional()
        .describe('group positions by the account holding them instead of by symbol'),
      limit: z.number().int().min(1).max(500).optional(),
    },
    annotations: READ_ONLY,
    handler: (args) => {
      try {
        if (args.by_account) {
          const accounts = getHoldingsByAccount(db, args);
          return ok({ count: accounts.length, accounts });
        }
        return ok(getHoldings(db, args));
      } catch (e) {
        return fail(e);
      }
    },
  }),
  tool({
    name: 'get_transactions',
    title: 'Transactions',
    description:
      'Bank and card transactions. Amounts are signed the intuitive way: negative is money ' +
      'out, positive is money in. Defaults to the last 30 days.',
    inputSchema: {
      start: DATE.optional(),
      end: DATE.optional(),
      account_id: z.string().optional(),
      profile: PROFILE.optional(),
      search: z.string().optional().describe('substring of merchant or description'),
      category: z.string().optional().describe('Plaid personal finance category, e.g. TRAVEL'),
      min_amount_cad: z.number().min(0).optional(),
      limit: z.number().int().min(1).max(1000).optional(),
    },
    annotations: READ_ONLY,
    handler: (args) => {
      try {
        const start = args.start ?? daysAgoISO(30);
        const end = args.end ?? todayISO();
        const rows = getTransactions(db, { ...args, start, end });
        return ok({ start, end, count: rows.length, transactions: rows });
      } catch (e) {
        return fail(e);
      }
    },
  }),
  tool({
    name: 'get_cashflow',
    title: 'Cashflow',
    description:
      'Income vs spend for a period, by month, category, merchant and owner. Transfers between ' +
      'the household’s own accounts and card/loan payments are excluded by default so ' +
      'spending is not double counted.',
    inputSchema: {
      start: DATE,
      end: DATE,
      profile: PROFILE.optional(),
      include_transfers: z.boolean().optional(),
      include_loan_payments: z.boolean().optional(),
    },
    annotations: READ_ONLY,
    handler: (args) => {
      try {
        return ok(getCashflow(db, args));
      } catch (e) {
        return fail(e);
      }
    },
  }),
  tool({
    name: 'get_financial_summary',
    title: 'Full financial summary',
    description:
      'The complete picture in one call: net worth and its breakdowns, every account and its ' +
      'balance, credit cards with statement/minimum/due date, holdings, brokerage activity ' +
      '(dividends, buys, sells, fees), income vs spend by month/category/merchant, individual ' +
      'transactions, the net-worth history, contribution room, bank-connection health, FX and ' +
      'sync freshness. Spans SnapTrade, Plaid and Wise. Pass `sections` to ask for only part ' +
      `of it — ["all"] for everything — otherwise you get: ${DEFAULT_SECTIONS.join(', ')}. ` +
      'The period sections (cashflow, transactions, activities, history) default to the last ' +
      '6 months.',
    inputSchema: {
      sections: z
        .array(z.enum(['all', ...SUMMARY_SECTIONS]))
        .optional()
        .describe('which sections to return; ["all"] for every section'),
      profile: PROFILE.optional().describe('limit to one profile id'),
      start: DATE.optional(),
      end: DATE.optional(),
      months: z
        .number()
        .int()
        .min(1)
        .max(120)
        .optional()
        .describe('lookback in whole months when start is not given (default 6)'),
      limit: z.number().int().min(1).max(250).optional().describe('row cap per list section'),
      include_inactive: z.boolean().optional(),
    },
    annotations: READ_ONLY,
    handler: (args) => {
      try {
        const sections: SummarySection[] | undefined = args.sections?.includes('all')
          ? [...SUMMARY_SECTIONS]
          : (args.sections as SummarySection[] | undefined);
        return ok(buildSummary(db, { ...args, sections }));
      } catch (e) {
        return fail(e);
      }
    },
  }),
  tool({
    name: 'get_activities',
    title: 'Brokerage activity',
    description:
      'Investment-side movements from SnapTrade: dividends, interest, buys, sells, fees, ' +
      'contributions and withdrawals, with a per-type rollup. get_transactions only ever ' +
      'covers bank and card movements from Plaid, so use this one for anything that happened ' +
      'inside a brokerage account.',
    inputSchema: {
      start: DATE.optional(),
      end: DATE.optional(),
      account_id: z.string().optional(),
      profile: PROFILE.optional(),
      type: z.string().optional().describe('activity type, e.g. DIVIDEND, BUY, CONTRIBUTION'),
      symbol: z.string().optional(),
      limit: z.number().int().min(1).max(1000).optional(),
    },
    annotations: READ_ONLY,
    handler: (args) => {
      try {
        const start = args.start ?? daysAgoISO(365);
        const end = args.end ?? todayISO();
        return ok(getActivities(db, { ...args, start, end }));
      } catch (e) {
        return fail(e);
      }
    },
  }),
  tool({
    name: 'get_contribution_room',
    title: 'Contribution room',
    description:
      'Remaining RRSP/TFSA/FHSA room per person. Detected contributions come from brokerage ' +
      'activity; bank transfers into a brokerage are reported separately because they cannot ' +
      'be attributed to a specific registered account. A manual figure always wins.',
    inputSchema: { year: z.number().int().min(2000).max(2100).optional(), person: PROFILE.optional() },
    annotations: READ_ONLY,
    handler: (args) => {
      try {
        const rows = getContributionRoom(db, args);
        return ok({
          year: args.year ?? new Date().getUTCFullYear(),
          count: rows.length,
          room: rows,
          hint: rows.length === 0 ? 'No limits seeded yet — run `npm run seed:room` or call set_room_limit.' : undefined,
        });
      } catch (e) {
        return fail(e);
      }
    },
  }),
  tool({
    name: 'set_contributed',
    title: 'Override contributions',
    description:
      'Record the contribution amount for a person/account type/year by hand. Use when the ' +
      'detected figure is wrong or incomplete. Writes only to this server’s database.',
    inputSchema: {
      person: PROFILE,
      account_type: z.enum(['RRSP', 'TFSA', 'FHSA']),
      year: z.number().int().min(2000).max(2100),
      contributed_cad: z.number().min(0),
      note: z.string().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    handler: (args) => {
      try {
        setContributed(db, args.person, args.account_type, args.year, args.contributed_cad, args.note);
        return ok({ updated: true, room: getContributionRoom(db, { year: args.year, person: args.person }) });
      } catch (e) {
        return fail(e);
      }
    },
  }),
  tool({
    name: 'set_room_limit',
    title: 'Set contribution limit',
    description:
      'Set the contribution limit (room available at the start of the year) for a person, ' +
      'account type and year, as shown on a CRA notice of assessment or My Account.',
    inputSchema: {
      person: PROFILE,
      account_type: z.enum(['RRSP', 'TFSA', 'FHSA']),
      year: z.number().int().min(2000).max(2100),
      limit_cad: z.number().min(0),
      note: z.string().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    handler: (args) => {
      try {
        setRoomLimit(db, args.person, args.account_type, args.year, args.limit_cad, args.note);
        return ok({ updated: true, room: getContributionRoom(db, { year: args.year, person: args.person }) });
      } catch (e) {
        return fail(e);
      }
    },
  }),
  tool({
    name: 'list_profiles',
    title: 'List profiles',
    description:
      'Every profile, with how many accounts and bank connections belong to it. A profile is ' +
      'both a person or bucket and its own set of provider credentials — each has a separate ' +
      'Plaid Item allowance, which is how the household exceeds a single team\u2019s 10-Item cap.',
    annotations: READ_ONLY,
    handler: () => {
      try {
        const profiles = listProfiles(db).map((p) => ({ ...p, usage: profileUsage(db, p.id) }));
        return ok({ count: profiles.length, max: MAX_PROFILES, profiles });
      } catch (e) {
        return fail(e);
      }
    },
  }),
  tool({
    name: 'create_profile',
    title: 'Create a profile',
    description:
      `Add a profile (at most ${MAX_PROFILES}). Its provider credentials are set separately in ` +
      'the web UI, since they are secrets.',
    inputSchema: { name: z.string().min(1).max(60) },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    handler: ({ name }) => {
      try {
        return ok({ created: true, profile: createProfile(db, name) });
      } catch (e) {
        return fail(e);
      }
    },
  }),
  tool({
    name: 'rename_profile',
    title: 'Rename a profile',
    description: 'Change a profile\u2019s display name. Its id and credentials are unaffected.',
    inputSchema: { profile: PROFILE, name: z.string().min(1).max(60) },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    handler: ({ profile, name }) => {
      try {
        return renameProfile(db, profile, name)
          ? ok({ renamed: true, profile, name })
          : fail(new Error(`no profile with id ${profile}`));
      } catch (e) {
        return fail(e);
      }
    },
  }),
  tool({
    name: 'delete_profile',
    title: 'Delete a profile',
    description:
      'Remove an empty profile. Refused while accounts or bank connections still belong to it — ' +
      'move those first. Deleting a connection means re-linking that bank by hand.',
    inputSchema: { profile: PROFILE },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    handler: ({ profile }) => {
      try {
        const res = deleteProfile(db, profile);
        return res.deleted ? ok({ deleted: true, profile }) : fail(new Error(res.reason ?? 'refused'));
      } catch (e) {
        return fail(e);
      }
    },
  }),
  tool({
    name: 'move_account',
    title: 'Move an account to a profile',
    description:
      'Re-attribute an account to another profile, so it counts towards that profile\u2019s net ' +
      'worth. The underlying connection does not move — it stays with the credentials that ' +
      'linked it. Sync never overwrites this.',
    inputSchema: { account_id: z.string(), profile: PROFILE },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    handler: ({ account_id, profile }) => {
      try {
        return setAccountProfile(db, account_id, profile)
          ? ok({ moved: true, account_id, profile })
          : fail(new Error(`no account with id ${account_id}`));
      } catch (e) {
        return fail(e);
      }
    },
  }),
  tool({
    name: 'get_spend_by_merchant',
    title: 'Spend by merchant',
    description:
      'Transactions rolled up by merchant (or by category) after hand corrections, with spend, ' +
      'money received, count and date range per group. Use this to find where money actually ' +
      'goes, and to spot one merchant recorded under two spellings — those show up as two ' +
      'groups with similar names, and set_merchant_rule merges them.',
    inputSchema: {
      start: DATE.optional(),
      end: DATE.optional(),
      profile: PROFILE.optional(),
      account_id: z.string().optional(),
      group_by: z.enum(['merchant', 'category']).optional(),
      search: z.string().optional(),
      limit: z.number().int().min(1).max(200).optional(),
    },
    annotations: READ_ONLY,
    handler: (args) => {
      try {
        const start = args.start ?? daysAgoISO(180);
        const end = args.end ?? todayISO();
        // A rollup over a truncated sample is a wrong number, not a partial
        // one, so read the rows without the caller's display limit.
        const rows = getTransactions(db, { ...args, start, end, limit: 1000 });
        const groups =
          args.group_by === 'category' ? groupByCategory(rows) : groupByMerchant(rows);
        return ok({
          start,
          end,
          group_by: args.group_by ?? 'merchant',
          transactions: rows.length,
          groups: args.limit ? groups.slice(0, args.limit) : groups,
        });
      } catch (e) {
        return fail(e);
      }
    },
  }),

  tool({
    name: 'set_transaction_category',
    title: 'Correct one transaction',
    description:
      'Override the merchant name and/or category of a single transaction. Applied on read, so ' +
      'a nightly sync never undoes it. Pass an empty string to clear a field. To fix every ' +
      'transaction that looks alike, use set_merchant_rule instead.',
    inputSchema: {
      transaction_id: z.string(),
      merchant: z.string().optional(),
      category: z.string().optional(),
      note: z.string().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    handler: ({ transaction_id, merchant, category, note }) => {
      try {
        const blank = (v: string | undefined): string | null | undefined =>
          v === undefined ? undefined : v.trim() === '' ? null : v.trim();
        setTransactionOverride(db, transaction_id, {
          ...(merchant !== undefined ? { merchant: blank(merchant) ?? null } : {}),
          ...(category !== undefined ? { category: blank(category) ?? null } : {}),
          ...(note !== undefined ? { note: blank(note) ?? null } : {}),
        });
        return ok({ updated: true, transaction_id });
      } catch (e) {
        return fail(e);
      }
    },
  }),

  tool({
    name: 'set_merchant_rule',
    title: 'Add a merchant rule',
    description:
      'Rewrite the merchant and/or category of every transaction matching a pattern — past and ' +
      'future. This is how two spellings of one company become one merchant. Rules are tried in ' +
      'order and the first match wins; a per-transaction override still beats any rule.',
    inputSchema: {
      pattern: z.string().min(1).describe('matched against merchant + description, case-insensitive'),
      merchant: z.string().optional().describe('the canonical name to show instead'),
      category: z.string().optional(),
      match_type: z.enum(MATCH_TYPES).optional().describe('default contains'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    handler: ({ pattern, merchant, category, match_type }) => {
      try {
        const affects = ruleImpact(db, { pattern, match_type });
        const rule = addMerchantRule(db, { pattern, merchant, category, match_type });
        return ok({ created: true, rule, matching_transactions: affects });
      } catch (e) {
        return fail(e);
      }
    },
  }),

  tool({
    name: 'list_merchant_rules',
    title: 'List merchant rules',
    description:
      'Every rewrite rule in order, with how many stored transactions each one currently matches.',
    annotations: READ_ONLY,
    handler: () => {
      try {
        const rules = listMerchantRules(db).map((r) => ({
          ...r,
          matching_transactions: ruleImpact(db, r),
        }));
        return ok({ count: rules.length, rules, categories_in_use: knownCategories(db) });
      } catch (e) {
        return fail(e);
      }
    },
  }),

  tool({
    name: 'delete_merchant_rule',
    title: 'Delete a merchant rule',
    description: 'Remove a rewrite rule. Affected transactions revert to what the bank reported.',
    inputSchema: { rule_id: z.number().int() },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    handler: ({ rule_id }) => {
      try {
        return deleteMerchantRule(db, rule_id)
          ? ok({ deleted: true, rule_id })
          : fail(new Error(`no rule with id ${String(rule_id)}`));
      } catch (e) {
        return fail(e);
      }
    },
  }),

  tool({
    name: 'set_merchant_category',
    title: 'File a merchant under a category',
    description:
      'Assign a category to every transaction from a merchant, past and future. Creates the ' +
      'category if it does not exist. Updates the rule that produced the merchant name when one ' +
      'exists, rather than adding a second — a merchant already renamed by a rule cannot be ' +
      'matched by a new rule on its new name. Pass an empty category to uncategorise it.',
    inputSchema: { merchant: z.string().min(1), category: z.string() },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    handler: ({ merchant, category }) => {
      try {
        const rule = setMerchantCategory(db, merchant, category.trim() || null);
        return ok({
          updated: true,
          merchant,
          category: rule?.category ?? null,
          ...(rule ? { rule_id: rule.id } : { note: 'nothing to change — it was already uncategorised' }),
        });
      } catch (e) {
        return fail(e);
      }
    },
  }),

  tool({
    name: 'list_categories',
    title: 'List categories',
    description:
      'Every category available to file spending under: the ones institutions sent, the ones ' +
      'rules and overrides use, and the ones added by hand. The hand-added ones are listed ' +
      'separately because they exist whether or not anything is filed under them yet.',
    annotations: READ_ONLY,
    handler: () => {
      try {
        const custom = customCategories(db);
        return ok({ count: knownCategories(db).length, categories: knownCategories(db), custom });
      } catch (e) {
        return fail(e);
      }
    },
  }),

  tool({
    name: 'add_category',
    title: 'Add a category',
    description:
      'Create a category of your own, on top of whatever taxonomy the institution sends. ' +
      'Normalised to UPPER_SNAKE_CASE to match the built-in ones.',
    inputSchema: { name: z.string().min(1).max(60) },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    handler: ({ name }) => {
      try {
        return ok({ created: true, category: addCategory(db, name) });
      } catch (e) {
        return fail(e);
      }
    },
  }),

  tool({
    name: 'delete_category',
    title: 'Delete a category',
    description:
      'Remove a hand-added category. Transactions already filed under it keep it — this only ' +
      'takes it out of the pickers.',
    inputSchema: { name: z.string().min(1) },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    handler: ({ name }) => {
      try {
        return deleteCategory(db, name)
          ? ok({ deleted: true, category: name })
          : fail(new Error(`no hand-added category named ${name}`));
      } catch (e) {
        return fail(e);
      }
    },
  }),

  tool({
    name: 'set_account_currency',
    title: 'Correct an account currency',
    description:
      'Reinterpret an account\u2019s native currency when the institution labels it wrongly — for ' +
      'example a Canadian card reported as USD, which inflates every CAD figure on it. ' +
      'Recomputes the account balance and every transaction on it immediately. Pass an empty ' +
      'string to go back to trusting the institution. Check a statement before using this: a ' +
      'US-issued card used in Canada genuinely is billed in USD.',
    inputSchema: {
      account_id: z.string(),
      currency: z.string().describe('3-letter code, or empty to clear the override'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    handler: ({ account_id, currency }) => {
      try {
        const code = currency.trim() === '' ? null : currency.trim().toUpperCase();
        if (!setAccountCurrency(db, account_id, code)) {
          return fail(new Error(`no account with id ${account_id}`));
        }
        const [account] = listAccounts(db, { include_inactive: true }).filter((a) => a.id === account_id);
        return ok({ updated: true, account_id, currency: code, account });
      } catch (e) {
        return fail(e);
      }
    },
  }),

  tool({
    name: 'plaid_status',
    title: 'Plaid item status',
    description:
      'One row per linked bank/card Item with its health, plus how many Items each profile has ' +
      'used of its own allowance. The Plaid Trial cap is per profile, not per household — each ' +
      'profile has its own client_id and secret — so the same institution appearing under two ' +
      'profiles is two separate connections, never a duplicate. A status of "login_required" ' +
      'means the bank needs re-authentication; use plaid_relink_url next.',
    inputSchema: { profile: PROFILE.optional() },
    annotations: READ_ONLY,
    handler: ({ profile }) => {
      try {
        const items = plaidStatus(db, profile);
        return ok({
          count: items.length,
          needs_attention: items.filter((i) => i['status'] !== 'ok').length,
          cap_is_per_profile: true,
          by_profile: plaidUsage(db, profile),
          items,
        });
      } catch (e) {
        return fail(e);
      }
    },
  }),
  tool({
    name: 'plaid_relink_url',
    title: 'Plaid relink token',
    description:
      'Mint an update-mode Link token for a broken Item. The token is pasted into the local ' +
      'Link helper (npm run link) on the machine where linking is done — never on the server.',
    inputSchema: { item_id: z.string() },
    annotations: { readOnlyHint: true, openWorldHint: true },
    handler: async ({ item_id }) => {
      try {
        const token = await createUpdateLinkToken(db, item_id);
        return ok({
          item_id,
          link_token: token,
          how_to:
            `Run \`npm run link\` locally, open http://localhost:${config.plaid.linkPort}, ` +
            'paste this token into "Repair an existing connection" and finish the bank flow. ' +
            'Then run `npm run sync`; plaid_status should return to "ok".',
          expires_in: '4 hours',
        });
      } catch (e) {
        return fail(e);
      }
    },
  }),
  tool({
    name: 'list_statements',
    title: 'List available statements',
    description:
      'Monthly statements Plaid can fetch for each linked bank and card, newest first — ' +
      'institution, account, month and a statement_id to pass to get_statement. Nothing is ' +
      'downloaded by this call. Brokerages connected through SnapTrade are not included: ' +
      'SnapTrade has no statements endpoint, so Wealthsimple statements stay a manual download.',
    inputSchema: {
      profile: PROFILE.optional(),
      account_id: z.string().optional(),
      item_id: z.string().optional().describe('one bank connection, from plaid_status'),
      period: z
        .string()
        .regex(/^\d{4}-\d{2}$/)
        .optional()
        .describe('YYYY-MM, to narrow to one month'),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
    handler: async (args) => {
      try {
        if (!statementsEnabled()) {
          return ok({
            enabled: false,
            hint:
              'The Statements product is not enabled. Add "statements" to PLAID_OPTIONAL_PRODUCTS ' +
              '(Settings), then re-consent each bank under Connections — Plaid only serves ' +
              'statements for an Item that was linked with the product.',
            statements: [],
          });
        }
        const { statements, unavailable } = await listStatements(db, {
          ...(args.profile ? { profileId: args.profile } : {}),
          ...(args.account_id ? { accountId: args.account_id } : {}),
          ...(args.item_id ? { itemId: args.item_id } : {}),
        });
        const rows = args.period ? statements.filter((s) => s.period === args.period) : statements;
        return ok({
          enabled: true,
          count: rows.length,
          statements: rows,
          ...(unavailable.length ? { unavailable } : {}),
        });
      } catch (e) {
        return fail(e);
      }
    },
  }),

  tool({
    name: 'get_statement',
    title: 'Fetch a statement PDF',
    description:
      'Download one statement from the bank and return the PDF itself. The file is streamed ' +
      'through memory and never written to disk, cached or stored in the database — it exists ' +
      'only in this response. Call list_statements first for a statement_id. The response ' +
      'reports the SHA-256 and whether it matched the checksum the bank sent, so a truncated ' +
      'download is visible rather than silent.',
    inputSchema: {
      statement_id: z.string(),
      profile: PROFILE.optional().describe('narrows the lookup when profiles share an institution'),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
    handler: async ({ statement_id, profile }) => {
      try {
        const { file, ref } = await downloadStatement(db, statement_id, profile);
        const name = `${ref.institution} ${ref.period} ••${ref.account_mask}.pdf`
          .replace(/[^\w .\u2022-]+/g, '-');
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  institution: ref.institution,
                  account: ref.account_name,
                  mask: ref.account_mask,
                  period: ref.period,
                  date_posted: ref.date_posted,
                  bytes: file.bytes,
                  sha256: file.sha256,
                  checksum_verified: file.verified,
                  stored: false,
                  note: 'This PDF was not saved anywhere. Ask again to fetch it again.',
                },
                null,
                2,
              ),
            },
            {
              type: 'resource' as const,
              resource: {
                uri: `plaid-statement://${ref.item_id}/${statement_id}/${name}`,
                mimeType: 'application/pdf',
                blob: file.pdf.toString('base64'),
              },
            },
          ],
        };
      } catch (e) {
        return fail(e);
      }
    },
  }),

  tool({
    name: 'sync_now',
    title: 'Refresh data',
    description:
      'Pull fresh FX rates, brokerage holdings, bank balances and transactions now. Read-only ' +
      'against every institution. Takes a few seconds per linked Item.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    handler: async () => {
      try {
        return ok(await runSync(db));
      } catch (e) {
        return fail(e);
      }
    },
  }),
  tool({
    name: 'sync_report',
    title: 'Last sync report',
    description:
      'Per-source status and timing from the last sync, so you can tell the user how stale the ' +
      'numbers are before answering.',
    annotations: READ_ONLY,
    handler: () => {
      try {
        const report = lastSyncReport(db);
        if (!report) return ok({ ran: false, hint: 'No sync has completed yet.' });
        const ageMs = Date.now() - Date.parse(report.finished_at);
        return ok({
          ran: true,
          finished_at: report.finished_at,
          age_hours: Math.round((ageMs / 3_600_000) * 10) / 10,
          stale: ageMs > 36 * 3_600_000,
          ok: report.ok,
          fx: report.fx,
          snaptrade: report.snaptrade,
          plaid: report.plaid,
          wise: report.wise,
          timings_ms: report.timings_ms,
        });
      } catch (e) {
        return fail(e);
      }
    },
  }),
  tool({
    name: 'backup_now',
    title: 'Back up the database',
    description:
      'Write a consistent snapshot of the database next to it, and prune old ones. Uses ' +
      'sqlite\u2019s own transactional copy, so it is safe to run against a live server — ' +
      'unlike copying the file, which misses anything still in the write-ahead log.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    handler: () => {
      try {
        const file = writeBackup(db);
        return ok({ backed_up: true, file, pruned: pruneBackups() });
      } catch (e) {
        return fail(e);
      }
    },
  }),
  tool({
    name: 'fx_rates',
    title: 'FX rates',
    description: 'Current Bank of Canada rates used to convert every balance to CAD.',
    annotations: READ_ONLY,
    handler: () => {
      try {
        const rows = db
          .prepare('SELECT pair, rate, as_of, fetched_at FROM fx_rates ORDER BY pair')
          .all();
        return ok({ base: config.baseCurrency, count: rows.length, rates: rows });
      } catch (e) {
        return fail(e);
      }
    },
  }),
  ];
}
