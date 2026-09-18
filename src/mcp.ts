/**
 * MCP transport for the tool surface.
 *
 * The tools themselves live in src/tools/registry.ts, because the built-in chat
 * assistant serves the same set. This file is only the MCP binding: it must stay
 * a thin adapter, so that a capability can never exist on one transport and not
 * the other — least of all a write.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { DB } from './db.ts';
import { getDb } from './db.ts';
import { TOOL_INSTRUCTIONS, toolDefs } from './tools/registry.ts';

export function buildServer(db: DB = getDb()): McpServer {
  const server = new McpServer(
    { name: 'tally', version: '0.1.0' },
    { instructions: TOOL_INSTRUCTIONS },
  );

  for (const t of toolDefs(db)) {
    server.registerTool(
      t.name,
      {
        title: t.title,
        description: t.description,
        ...(t.inputSchema ? { inputSchema: t.inputSchema } : {}),
        annotations: t.annotations,
      },
      t.handler as never,
    );
  }

  return server;
}
