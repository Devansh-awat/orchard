import { Injectable, Logger } from '@nestjs/common';
import OpenAI from 'openai';
import { TOOLS_OPENAI, executeTool } from './tools';

const API_BASE_URL = process.env.AI_CHAT_API_URL || 'https://api.pioneer.ai/v1';
const API_KEY = process.env.AI_CHAT_API_KEY || process.env.PIONEER_API_KEY || '';
const MODEL = process.env.AI_CHAT_MODEL || 'claude-opus-4-7';
const MAX_TOOL_ROUNDS = 10;

const SYSTEM_PROMPT = `You are Orchard AI, a helpful infrastructure assistant for the Orchard hosting platform.
You help users manage their deployments, databases, projects, and other infrastructure on Orchard.

You have access to tools that let you query and manage the user's infrastructure.
When users ask about their deployments, projects, or databases, use the appropriate tools to fetch real data.
When they ask you to perform actions (restart, scale, create, delete), use the corresponding tools.

CRITICAL — UI rendering rules:
- Tool results are AUTOMATICALLY displayed to the user as rich visual cards (deployment cards, database cards, project cards with status dots, icons, and metadata). The user sees them immediately.
- NEVER repeat, list, or summarize tool result data in your text response. No tables, no bullet-point lists of names, no re-listing of deployments/databases/projects. The cards already show everything.
- Your text should ONLY add brief commentary, context, or ask follow-up questions. For example: "You have 10 deployments across 7 projects, all running. Want me to check metrics on any of them?"
- NEVER use markdown tables. The card UI replaces tables entirely.
- Keep responses short — 1-3 sentences max after tool calls. The cards are the primary content.

Other guidelines:
- For destructive operations (delete), confirm the user's intent before proceeding
- If a tool call fails, explain the error clearly and suggest alternatives
- You can chain multiple tool calls to answer complex questions`;

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ChatActingUser {
  sub: string;
  email?: string;
  hackClubId?: string;
  sessionId: string;
  token: string;
}

@Injectable()
export class AiChatService {
  private readonly logger = new Logger(AiChatService.name);

  async *streamChat(
    messages: ChatMessage[],
    actingUser: ChatActingUser,
  ): AsyncGenerator<string> {
    if (!API_KEY) {
      yield `${JSON.stringify({ type: 'error', error: 'AI chat is not configured (missing API key)' })  }\n`;
      return;
    }

    const openai = new OpenAI({
      apiKey: API_KEY,
      baseURL: API_BASE_URL,
    });

    const apiBase = `http://localhost:${process.env.PORT || 3001}/apiv1`;
    const apiFetch = async (method: string, path: string, body?: any) => {
      const url = `${apiBase}${path}`;
      const res = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${actingUser.token}`,
          'Content-Type': 'application/json',
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      if (!res.ok) {
        const text = await res.text();
        let message: string;
        try {
          const json = JSON.parse(text);
          message = json.message || json.error || text;
        } catch {
          message = text;
        }
        throw new Error(`API error (${res.status}): ${message}`);
      }
      const text = await res.text();
      if (!text) return undefined;
      return JSON.parse(text);
    };

    const openaiMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      ...messages.map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content })),
    ];

    let rounds = 0;
    while (rounds < MAX_TOOL_ROUNDS) {
      rounds++;

      const stream = await openai.chat.completions.create({
        model: MODEL,
        max_tokens: 4096,
        tools: TOOLS_OPENAI,
        messages: openaiMessages,
        stream: true,
      });

      let assistantContent = '';
      const toolCalls: Map<number, { id: string; name: string; arguments: string }> = new Map();

      for await (const chunk of stream) {
        const delta = chunk.choices?.[0]?.delta;
        if (!delta) continue;

        if (delta.content) {
          assistantContent += delta.content;
          yield `${JSON.stringify({ type: 'text', text: delta.content })  }\n`;
        }

        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const existing = toolCalls.get(tc.index);
            if (existing) {
              if (tc.function?.arguments) existing.arguments += tc.function.arguments;
            } else {
              toolCalls.set(tc.index, {
                id: tc.id || '',
                name: tc.function?.name || '',
                arguments: tc.function?.arguments || '',
              });
            }
          }
        }
      }

      if (toolCalls.size === 0) {
        break;
      }

      // Build assistant message with tool calls
      const assistantMsg: OpenAI.Chat.Completions.ChatCompletionMessageParam = {
        role: 'assistant',
        content: assistantContent || null,
        tool_calls: [...toolCalls.values()].map((tc) => ({
          id: tc.id,
          type: 'function' as const,
          function: { name: tc.name, arguments: tc.arguments },
        })),
      };
      openaiMessages.push(assistantMsg);

      // Execute each tool call
      for (const tc of toolCalls.values()) {
        yield `${JSON.stringify({ type: 'tool_call', name: tc.name, input: tc.arguments })  }\n`;

        let parsed: Record<string, any>;
        try {
          parsed = JSON.parse(tc.arguments || '{}');
        } catch {
          parsed = {};
        }

        try {
          const result = await executeTool(apiFetch, tc.name, parsed);
          openaiMessages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: result,
          });
          // Send parsed data to frontend for rich rendering
          let data: any;
          try { data = JSON.parse(result); } catch { data = null; }
          yield `${JSON.stringify({ type: 'tool_result', name: tc.name, success: true, data })  }\n`;
        } catch (error) {
          const errMsg = error instanceof Error ? error.message : String(error);
          this.logger.warn(`Tool ${tc.name} failed: ${errMsg}`);
          openaiMessages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: JSON.stringify({ error: errMsg }),
          });
          yield `${JSON.stringify({ type: 'tool_result', name: tc.name, success: false, error: errMsg })  }\n`;
        }
      }
    }

    yield `${JSON.stringify({ type: 'done' })  }\n`;
  }
}
