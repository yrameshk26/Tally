/**
 * The assistant loop: ask the model, run whatever tools it asks for, ask again,
 * until it answers or runs out of steps.
 *
 * The tools are exactly the MCP set (src/tools/registry.ts) — the assistant has
 * no private capability, so "read-only" needs proving in one place only. Tool
 * failures are handed back to the model as text rather than thrown, because a
 * model that can read "no account with id X" will correct itself, while an
 * exception just ends the conversation.
 */
import { zodToJsonSchema } from 'zod-to-json-schema';
import { z } from 'zod';
import type { DB } from '../db.ts';
import { config } from '../config.ts';
import { errMessage, log } from '../lib/logger.ts';
import { todayISO } from '../lib/money.ts';
import { TOOL_INSTRUCTIONS, toolDefs, type ToolDef } from '../tools/registry.ts';
import {
  complete,
  llmConfig,
  type LlmConfig,
  type ToolCall,
  type ToolSpec,
  type Turn,
} from './provider.ts';

/** What the tool did, kept for the transcript so the UI can show its working. */
export type ToolRun = { name: string; args: Record<string, unknown>; ok: boolean; result: string };

export type ChatResult = {
  text: string;
  runs: ToolRun[];
  model: string;
  steps: number;
  usage: { input: number; output: number } | null;
  /** Set when the loop hit its step budget before the model concluded. */
  truncated?: boolean;
};

/**
 * Providers disagree about JSON Schema dialects; the safe intersection is a
 * plain object schema with no $ref, no $schema and no definitions block.
 */
export function toolParameters(def: ToolDef): Record<string, unknown> {
  if (!def.inputSchema || Object.keys(def.inputSchema).length === 0) {
    return { type: 'object', properties: {}, additionalProperties: false };
  }
  const schema = zodToJsonSchema(z.object(def.inputSchema), {
    $refStrategy: 'none',
    target: 'openApi3',
  }) as Record<string, unknown>;
  delete schema['$schema'];
  delete schema['definitions'];
  delete schema['additionalProperties'];
  return { additionalProperties: false, ...schema };
}

export function toolSpecs(defs: ToolDef[]): ToolSpec[] {
  return defs.map((d) => ({
    name: d.name,
    description: d.description,
    parameters: toolParameters(d),
  }));
}

/** Pull the text out of an MCP tool result, whatever content blocks it used. */
function resultText(result: { content?: Array<{ type: string; text?: string }> }): string {
  return (result.content ?? [])
    .map((c) => (c.type === 'text' ? (c.text ?? '') : `[${c.type}]`))
    .join('\n')
    .trim();
}

/** A tool result that would blow the context window helps nobody. */
const MAX_RESULT_CHARS = 24_000;

function clip(text: string, name: string): string {
  if (text.length <= MAX_RESULT_CHARS) return text;
  return (
    `${text.slice(0, MAX_RESULT_CHARS)}\n\n[truncated — ${name} returned ${String(text.length)} ` +
    'characters. Narrow the range, lower the limit, or ask for fewer sections.]'
  );
}

async function runTool(defs: ToolDef[], call: ToolCall): Promise<ToolRun> {
  const def = defs.find((d) => d.name === call.name);
  if (!def) {
    return {
      name: call.name,
      args: call.args,
      ok: false,
      result: `error: no tool named ${call.name}. Available: ${defs.map((d) => d.name).join(', ')}`,
    };
  }
  try {
    // Validate here rather than trusting the model: a bad argument becomes a
    // message it can read and fix, not a 500.
    const args = def.inputSchema ? z.object(def.inputSchema).parse(call.args) : call.args;
    const out = await def.handler(args as Record<string, unknown>);
    const text = resultText(out as { content?: Array<{ type: string; text?: string }> });
    return { name: call.name, args: call.args, ok: !out.isError, result: clip(text, call.name) };
  } catch (e) {
    const detail =
      e instanceof z.ZodError
        ? e.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')
        : errMessage(e);
    return { name: call.name, args: call.args, ok: false, result: `error: ${detail}` };
  }
}

export function systemPrompt(db: DB): string {
  return [
    'You are the assistant built into tally, a personal read-only net-worth server.',
    'You are talking to the one person who owns this data — the household owner — so you may',
    'discuss any balance, holding or transaction it returns without hedging about privacy.',
    '',
    TOOL_INSTRUCTIONS,
    '',
    `Today is ${todayISO()}.`,
    '',
    'How to answer well:',
    '- Call tools for anything factual. Never estimate a balance you could look up, and never',
    '  carry a number over from earlier in the conversation if it may have changed.',
    '- get_financial_summary answers broad questions in one call; prefer it over chaining.',
    '- Lead with the answer, then the supporting detail. Use a markdown table whenever you are',
    '  showing more than two numbers side by side.',
    '- Format money as $1,234.56 and say which currency when it is not CAD.',
    '- If the data is stale or a bank connection is broken, say so — sync_report and plaid_status',
    '  tell you. A confident answer from stale data is worse than a caveat.',
    '- You cannot move money, trade, or change anything at an institution. If asked, say so plainly.',
    '',
    'To draw a chart, emit a fenced block tagged `tally-chart` containing JSON:',
    '  {"type":"bar"|"line"|"stack","title":"...","rows":[{"label":"Jan","value":123}]}',
    'Use one when a trend or a part-to-whole split is the point. Always give the same figures in',
    'a table as well, so the numbers are readable without the chart.',
  ]
    .filter((line) => line !== undefined)
    .join('\n');
}

/**
 * Run one user message to completion.
 *
 * `history` is the prior conversation, oldest first. The returned turns are
 * appended by the caller, which owns persistence.
 */
export async function runChat(
  db: DB,
  history: Turn[],
  message: string,
  opts: { cfg?: LlmConfig; maxSteps?: number } = {},
): Promise<{ result: ChatResult; turns: Turn[] }> {
  const cfg = opts.cfg ?? llmConfig(db);
  const defs = toolDefs(db);
  const specs = toolSpecs(defs);
  const system = systemPrompt(db);
  const maxSteps = opts.maxSteps ?? config.llm.maxSteps;

  const turns: Turn[] = [...history, { role: 'user', text: message }];
  const runs: ToolRun[] = [];
  // Accumulated as plain counters: a provider that reports no usage should end
  // up with null, not a misleading zero.
  let inputTokens = 0;
  let outputTokens = 0;
  let sawUsage = false;
  let model = cfg.model;
  const usage = (): { input: number; output: number } | null =>
    sawUsage ? { input: inputTokens, output: outputTokens } : null;

  for (let step = 1; step <= maxSteps; step += 1) {
    const reply = await complete(cfg, system, turns, specs);
    model = reply.model;
    if (reply.usage) {
      sawUsage = true;
      inputTokens += reply.usage.input;
      outputTokens += reply.usage.output;
    }

    turns.push({ role: 'assistant', text: reply.text, calls: reply.calls });

    if (reply.calls.length === 0) {
      return { result: { text: reply.text, runs, model, steps: step, usage: usage() }, turns };
    }

    for (const call of reply.calls) {
      const run = await runTool(defs, call);
      runs.push(run);
      log.info('assistant tool call', { tool: run.name, ok: run.ok });
      turns.push({ role: 'tool', id: call.id, name: call.name, result: run.result });
    }
  }

  // Out of steps with tools still pending: ask once more, with tools withheld,
  // so the user gets the model's best answer rather than an empty bubble.
  const final = await complete(cfg, system, turns, []);
  turns.push({ role: 'assistant', text: final.text, calls: [] });
  return {
    result: { text: final.text, runs, model, steps: maxSteps, usage: usage(), truncated: true },
    turns,
  };
}
