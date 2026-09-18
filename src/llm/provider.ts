/**
 * LLM providers, behind one interface.
 *
 * Two wire formats cover the field: Anthropic's Messages API, and the
 * OpenAI-compatible /chat/completions shape that OpenAI, OpenRouter, Groq,
 * Together and most self-hosted servers all speak. A "custom" provider is just
 * the OpenAI shape pointed at a different base URL, which is why there is no
 * third adapter.
 *
 * Nothing here logs a prompt or a response body: they contain account balances
 * and transaction descriptions by construction.
 */
import type { DB } from '../db.ts';
import { config } from '../config.ts';
import { getSetting } from '../settings.ts';
import { errMessage } from '../lib/logger.ts';

export const PROVIDERS = ['anthropic', 'openai', 'openrouter', 'custom'] as const;
export type Provider = (typeof PROVIDERS)[number];

/** Where each provider lives, and what to call if the user names no model. */
export const PROVIDER_INFO: Record<
  Provider,
  { label: string; baseUrl: string; defaultModel: string; wire: 'anthropic' | 'openai'; keyUrl: string }
> = {
  anthropic: {
    label: 'Anthropic',
    baseUrl: 'https://api.anthropic.com',
    defaultModel: 'claude-sonnet-4-5',
    wire: 'anthropic',
    keyUrl: 'https://console.anthropic.com/settings/keys',
  },
  openai: {
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4.1',
    wire: 'openai',
    keyUrl: 'https://platform.openai.com/api-keys',
  },
  openrouter: {
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: 'anthropic/claude-sonnet-4.5',
    wire: 'openai',
    keyUrl: 'https://openrouter.ai/keys',
  },
  custom: {
    label: 'Custom (OpenAI-compatible)',
    baseUrl: '',
    defaultModel: '',
    wire: 'openai',
    keyUrl: '',
  },
};

export type LlmConfig = {
  provider: Provider;
  apiKey: string;
  model: string;
  baseUrl: string;
  wire: 'anthropic' | 'openai';
};

export function isProvider(v: string): v is Provider {
  return (PROVIDERS as readonly string[]).includes(v);
}

/** Resolve the assistant's configuration from the database, then the environment. */
export function llmConfig(db: DB): LlmConfig {
  const raw = getSetting(db, 'LLM_PROVIDER') || config.llm.provider;
  const provider: Provider = isProvider(raw) ? raw : 'anthropic';
  const info = PROVIDER_INFO[provider];
  return {
    provider,
    apiKey: getSetting(db, 'LLM_API_KEY') || config.llm.apiKey,
    model: getSetting(db, 'LLM_MODEL') || config.llm.model || info.defaultModel,
    baseUrl: (getSetting(db, 'LLM_BASE_URL') || config.llm.baseUrl || info.baseUrl).replace(/\/+$/, ''),
    wire: info.wire,
  };
}

/** The assistant is off until there is somewhere to send a request and a key to sign it. */
export function llmReady(db: DB): boolean {
  const c = llmConfig(db);
  return Boolean(c.apiKey && c.model && c.baseUrl);
}

// --- the neutral conversation shape ----------------------------------------

export type ToolCall = { id: string; name: string; args: Record<string, unknown> };

export type Turn =
  | { role: 'user'; text: string }
  | { role: 'assistant'; text: string; calls: ToolCall[] }
  | { role: 'tool'; id: string; name: string; result: string };

export type ToolSpec = { name: string; description: string; parameters: Record<string, unknown> };

export type LlmReply = {
  text: string;
  calls: ToolCall[];
  /** Why the model stopped. 'tool' means it wants results before continuing. */
  stop: 'end' | 'tool' | 'length';
  model: string;
  usage: { input: number; output: number } | null;
};

/** A provider error the UI can show without leaking the key or the prompt. */
export class LlmError extends Error {
  status: number | undefined;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'LlmError';
    this.status = status;
  }
}

function parseArgs(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object') return raw as Record<string, unknown>;
  if (typeof raw === 'string' && raw.trim()) {
    try {
      const v = JSON.parse(raw) as unknown;
      if (v && typeof v === 'object') return v as Record<string, unknown>;
    } catch {
      // A model that emits malformed JSON gets an empty object and, in the
      // chat loop, a tool error it can read and retry from.
    }
  }
  return {};
}

async function post(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    if (ctrl.signal.aborted) throw new LlmError(`the provider did not answer within ${timeoutMs / 1000}s`);
    throw new LlmError(`could not reach the provider: ${errMessage(e)}`);
  }
  clearTimeout(timer);

  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    if (!res.ok) throw new LlmError(`provider returned ${res.status}`, res.status);
    throw new LlmError('provider returned a response that was not JSON');
  }
  if (!res.ok) throw new LlmError(hintFor(res.status, errorDetail(json, res.status)), res.status);
  return json;
}

/** Providers disagree on where the message lives; try the three shapes in use. */
function errorDetail(json: Record<string, unknown>, status: number): string {
  const err = json['error'];
  if (typeof err === 'string' && err) return err;
  if (err && typeof err === 'object') {
    const m = (err as { message?: unknown }).message;
    if (typeof m === 'string' && m) return m;
  }
  if (typeof json['message'] === 'string' && json['message']) return json['message'];
  return `HTTP ${String(status)}`;
}

/** Turn the common failures into something actionable rather than a status code. */
function hintFor(status: number, detail: string): string {
  if (status === 401 || status === 403) {
    return `${detail} — check the API key under Settings.`;
  }
  if (status === 404) return `${detail} — check the model name and base URL under Settings.`;
  if (status === 429) return `${detail} — the provider is rate limiting; wait and retry.`;
  if (status >= 500) return `${detail} — the provider is having trouble; retry shortly.`;
  return detail;
}

// --- Anthropic Messages -----------------------------------------------------

async function completeAnthropic(
  cfg: LlmConfig,
  system: string,
  turns: Turn[],
  tools: ToolSpec[],
  timeoutMs: number,
): Promise<LlmReply> {
  type Block = Record<string, unknown>;
  const messages: Array<{ role: 'user' | 'assistant'; content: Block[] }> = [];

  for (const t of turns) {
    if (t.role === 'user') {
      messages.push({ role: 'user', content: [{ type: 'text', text: t.text }] });
    } else if (t.role === 'assistant') {
      const content: Block[] = [];
      if (t.text) content.push({ type: 'text', text: t.text });
      for (const c of t.calls) {
        content.push({ type: 'tool_use', id: c.id, name: c.name, input: c.args });
      }
      if (content.length) messages.push({ role: 'assistant', content });
    } else {
      // Anthropic carries tool results on a user turn; consecutive results
      // belong in one message, so merge into the previous user turn when it is
      // already a tool_result carrier.
      const block: Block = { type: 'tool_result', tool_use_id: t.id, content: t.result };
      const prev = messages[messages.length - 1];
      if (prev?.role === 'user' && prev.content.every((b) => b['type'] === 'tool_result')) {
        prev.content.push(block);
      } else {
        messages.push({ role: 'user', content: [block] });
      }
    }
  }

  const json = await post(
    `${cfg.baseUrl}/v1/messages`,
    { 'x-api-key': cfg.apiKey, 'anthropic-version': '2023-06-01' },
    {
      model: cfg.model,
      max_tokens: 4096,
      system,
      messages,
      ...(tools.length
        ? { tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters })) }
        : {}),
    },
    timeoutMs,
  );

  const content = Array.isArray(json['content']) ? (json['content'] as Block[]) : [];
  const text = content
    .filter((b) => b['type'] === 'text')
    .map((b) => String(b['text'] ?? ''))
    .join('');
  const calls: ToolCall[] = content
    .filter((b) => b['type'] === 'tool_use')
    .map((b) => ({
      id: String(b['id']),
      name: String(b['name']),
      args: parseArgs(b['input']),
    }));
  const reason = String(json['stop_reason'] ?? '');
  const usage = json['usage'] as { input_tokens?: number; output_tokens?: number } | undefined;

  return {
    text,
    calls,
    stop: reason === 'tool_use' ? 'tool' : reason === 'max_tokens' ? 'length' : 'end',
    model: String(json['model'] ?? cfg.model),
    usage: usage ? { input: usage.input_tokens ?? 0, output: usage.output_tokens ?? 0 } : null,
  };
}

// --- OpenAI-compatible chat completions -------------------------------------

async function completeOpenAi(
  cfg: LlmConfig,
  system: string,
  turns: Turn[],
  tools: ToolSpec[],
  timeoutMs: number,
): Promise<LlmReply> {
  const messages: Array<Record<string, unknown>> = [{ role: 'system', content: system }];

  for (const t of turns) {
    if (t.role === 'user') {
      messages.push({ role: 'user', content: t.text });
    } else if (t.role === 'assistant') {
      messages.push({
        role: 'assistant',
        content: t.text || null,
        ...(t.calls.length
          ? {
              tool_calls: t.calls.map((c) => ({
                id: c.id,
                type: 'function',
                function: { name: c.name, arguments: JSON.stringify(c.args) },
              })),
            }
          : {}),
      });
    } else {
      messages.push({ role: 'tool', tool_call_id: t.id, name: t.name, content: t.result });
    }
  }

  const json = await post(
    `${cfg.baseUrl}/chat/completions`,
    {
      authorization: `Bearer ${cfg.apiKey}`,
      // OpenRouter attributes requests by these; harmless elsewhere.
      'http-referer': 'https://github.com/yrameshk26/tally',
      'x-title': 'tally',
    },
    {
      model: cfg.model,
      messages,
      ...(tools.length
        ? {
            tools: tools.map((t) => ({
              type: 'function',
              function: { name: t.name, description: t.description, parameters: t.parameters },
            })),
          }
        : {}),
    },
    timeoutMs,
  );

  const choices = Array.isArray(json['choices']) ? (json['choices'] as Array<Record<string, unknown>>) : [];
  const choice = choices[0] ?? {};
  const msg = (choice['message'] ?? {}) as Record<string, unknown>;
  const rawCalls = Array.isArray(msg['tool_calls'])
    ? (msg['tool_calls'] as Array<Record<string, unknown>>)
    : [];
  const calls: ToolCall[] = rawCalls.map((c, i) => {
    const fn = (c['function'] ?? {}) as Record<string, unknown>;
    return {
      id: String(c['id'] ?? `call_${String(i)}`),
      name: String(fn['name'] ?? ''),
      args: parseArgs(fn['arguments']),
    };
  });
  const finish = String(choice['finish_reason'] ?? '');
  const usage = json['usage'] as { prompt_tokens?: number; completion_tokens?: number } | undefined;

  return {
    text: typeof msg['content'] === 'string' ? msg['content'] : '',
    calls,
    stop: calls.length ? 'tool' : finish === 'length' ? 'length' : 'end',
    model: String(json['model'] ?? cfg.model),
    usage: usage ? { input: usage.prompt_tokens ?? 0, output: usage.completion_tokens ?? 0 } : null,
  };
}

/** One completion. Tool results come back in `turns`; the caller runs the loop. */
export function complete(
  cfg: LlmConfig,
  system: string,
  turns: Turn[],
  tools: ToolSpec[],
  timeoutMs = config.llm.timeoutMs,
): Promise<LlmReply> {
  if (!cfg.apiKey) throw new LlmError('no API key configured for the assistant');
  if (!cfg.baseUrl) throw new LlmError('no base URL configured for the assistant');
  if (!cfg.model) throw new LlmError('no model configured for the assistant');
  return cfg.wire === 'anthropic'
    ? completeAnthropic(cfg, system, turns, tools, timeoutMs)
    : completeOpenAi(cfg, system, turns, tools, timeoutMs);
}
