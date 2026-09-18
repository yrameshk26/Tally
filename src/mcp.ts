/**
 * MCP tool surface. Read-only by construction: the only tools that write touch
 * user-owned tagging tables (owner tags, contribution figures) or trigger a
 * sync. There is no tool here — and there must never be one — that can place an
 * order, move money, or change a setting at an institution.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { DB } from './db.ts';
import { getDb } from './db.ts';
import { config } from './config.ts';
import { errMessage } from './lib/logger.ts';
import { daysAgoISO, todayISO } from './lib/money.ts';
import {
  getCashflow,
  getContributionRoom,
  getHoldings,
  getNetWorth,
  getNetWorthHistory,
  getTransactions,
  listAccounts,
  setAccountProfile,
  setContributed,
  setRoomLimit,
} from './queries.ts';
import {
  MAX_PROFILES,
  createProfile,
  deleteProfile,
  listProfiles,
  profileUsage,
  renameProfile,
} from './profiles.ts';
import { createUpdateLinkToken, plaidStatus } from './sources/plaid.ts';
import { lastSyncReport, runSync } from './sync.ts';

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

export function buildServer(db: DB = getDb()): McpServer {
  const server = new McpServer(
    { name: 'tally', version: '0.1.0' },
    {
      instructions:
        'Read-only personal net worth for one household. Balances are reported in ' +
        `${config.baseCurrency}; assets are positive and liabilities negative. In get_transactions ` +
        'and get_cashflow a negative amount means money left the account. Accounts belong to a ' +
        'profile — call list_profiles to see them. A profile is both a person/bucket and its own ' +
        'set of provider credentials, so each one has its own bank-connection allowance. Data is ' +
        'refreshed by a nightly sync — call sync_report to see how stale it is, or sync_now to ' +
        'refresh on demand.',
    },
  );

  server.registerTool(
    'get_net_worth',
    {
      title: 'Net worth',
      description:
        'Total household net worth in CAD with breakdowns by owner, registered account type ' +
        '(RRSP/TFSA/LIRA/DPSP/NON_REG), source and institution.',
      inputSchema: { profile: PROFILE.optional().describe('limit to one profile id') },
      annotations: READ_ONLY,
    },
    ({ profile }) => {
      try {
        return ok(getNetWorth(db, profile));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'get_net_worth_history',
    {
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
    },
    (args) => {
      try {
        return ok(getNetWorthHistory(db, args));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'list_accounts',
    {
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
    },
    (args) => {
      try {
        const accounts = listAccounts(db, args);
        return ok({ count: accounts.length, accounts });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'get_holdings',
    {
      title: 'Holdings',
      description:
        'Positions rolled up by symbol across all brokerage accounts, in CAD, largest first, ' +
        'with each position as a percentage of invested value (concentration).',
      inputSchema: {
        profile: PROFILE.optional(),
        account_id: z.string().optional(),
        include_cash: z.boolean().optional(),
        limit: z.number().int().min(1).max(500).optional(),
      },
      annotations: READ_ONLY,
    },
    (args) => {
      try {
        return ok(getHoldings(db, args));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'get_transactions',
    {
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
    },
    (args) => {
      try {
        const start = args.start ?? daysAgoISO(30);
        const end = args.end ?? todayISO();
        const rows = getTransactions(db, { ...args, start, end });
        return ok({ start, end, count: rows.length, transactions: rows });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'get_cashflow',
    {
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
    },
    (args) => {
      try {
        return ok(getCashflow(db, args));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'get_contribution_room',
    {
      title: 'Contribution room',
      description:
        'Remaining RRSP/TFSA/FHSA room per person. Detected contributions come from brokerage ' +
        'activity; bank transfers into a brokerage are reported separately because they cannot ' +
        'be attributed to a specific registered account. A manual figure always wins.',
      inputSchema: { year: z.number().int().min(2000).max(2100).optional(), person: PROFILE.optional() },
      annotations: READ_ONLY,
    },
    (args) => {
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
  );

  server.registerTool(
    'set_contributed',
    {
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
    },
    (args) => {
      try {
        setContributed(db, args.person, args.account_type, args.year, args.contributed_cad, args.note);
        return ok({ updated: true, room: getContributionRoom(db, { year: args.year, person: args.person }) });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'set_room_limit',
    {
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
    },
    (args) => {
      try {
        setRoomLimit(db, args.person, args.account_type, args.year, args.limit_cad, args.note);
        return ok({ updated: true, room: getContributionRoom(db, { year: args.year, person: args.person }) });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'list_profiles',
    {
      title: 'List profiles',
      description:
        'Every profile, with how many accounts and bank connections belong to it. A profile is ' +
        'both a person or bucket and its own set of provider credentials — each has a separate ' +
        'Plaid Item allowance, which is how the household exceeds a single team\u2019s 10-Item cap.',
      annotations: READ_ONLY,
    },
    () => {
      try {
        const profiles = listProfiles(db).map((p) => ({ ...p, usage: profileUsage(db, p.id) }));
        return ok({ count: profiles.length, max: MAX_PROFILES, profiles });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'create_profile',
    {
      title: 'Create a profile',
      description:
        `Add a profile (at most ${MAX_PROFILES}). Its provider credentials are set separately in ` +
        'the web UI, since they are secrets.',
      inputSchema: { name: z.string().min(1).max(60) },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    ({ name }) => {
      try {
        return ok({ created: true, profile: createProfile(db, name) });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'rename_profile',
    {
      title: 'Rename a profile',
      description: 'Change a profile\u2019s display name. Its id and credentials are unaffected.',
      inputSchema: { profile: PROFILE, name: z.string().min(1).max(60) },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    ({ profile, name }) => {
      try {
        return renameProfile(db, profile, name)
          ? ok({ renamed: true, profile, name })
          : fail(new Error(`no profile with id ${profile}`));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'delete_profile',
    {
      title: 'Delete a profile',
      description:
        'Remove an empty profile. Refused while accounts or bank connections still belong to it — ' +
        'move those first. Deleting a connection means re-linking that bank by hand.',
      inputSchema: { profile: PROFILE },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    ({ profile }) => {
      try {
        const res = deleteProfile(db, profile);
        return res.deleted ? ok({ deleted: true, profile }) : fail(new Error(res.reason ?? 'refused'));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'move_account',
    {
      title: 'Move an account to a profile',
      description:
        'Re-attribute an account to another profile, so it counts towards that profile\u2019s net ' +
        'worth. The underlying connection does not move — it stays with the credentials that ' +
        'linked it. Sync never overwrites this.',
      inputSchema: { account_id: z.string(), profile: PROFILE },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    ({ account_id, profile }) => {
      try {
        return setAccountProfile(db, account_id, profile)
          ? ok({ moved: true, account_id, profile })
          : fail(new Error(`no account with id ${account_id}`));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'plaid_status',
    {
      title: 'Plaid item status',
      description:
        'One row per linked bank/card Item with its health. A status of "login_required" means ' +
        'the bank needs re-authentication — use plaid_relink_url next.',
      annotations: READ_ONLY,
    },
    () => {
      try {
        const items = plaidStatus(db);
        return ok({
          count: items.length,
          needs_attention: items.filter((i) => i['status'] !== 'ok').length,
          items,
        });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'plaid_relink_url',
    {
      title: 'Plaid relink token',
      description:
        'Mint an update-mode Link token for a broken Item. The token is pasted into the local ' +
        'Link helper (npm run link) on the machine where linking is done — never on the server.',
      inputSchema: { item_id: z.string() },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ item_id }) => {
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
  );

  server.registerTool(
    'sync_now',
    {
      title: 'Refresh data',
      description:
        'Pull fresh FX rates, brokerage holdings, bank balances and transactions now. Read-only ' +
        'against every institution. Takes a few seconds per linked Item.',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async () => {
      try {
        return ok(await runSync(db));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'sync_report',
    {
      title: 'Last sync report',
      description:
        'Per-source status and timing from the last sync, so you can tell the user how stale the ' +
        'numbers are before answering.',
      annotations: READ_ONLY,
    },
    () => {
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
  );

  server.registerTool(
    'fx_rates',
    {
      title: 'FX rates',
      description: 'Current Bank of Canada rates used to convert every balance to CAD.',
      annotations: READ_ONLY,
    },
    () => {
      try {
        const rows = db
          .prepare('SELECT pair, rate, as_of, fetched_at FROM fx_rates ORDER BY pair')
          .all();
        return ok({ base: config.baseCurrency, count: rows.length, rates: rows });
      } catch (e) {
        return fail(e);
      }
    },
  );

  return server;
}
