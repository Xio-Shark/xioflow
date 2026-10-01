// OpenAI Chat Completions, streaming (xio, opencode).
import { halves, openSse, sendJson, USAGE } from './sse.mjs';

export const name = 'chat-completions';
export const matches = (method, pathname) => method === 'POST' && pathname.endsWith('/chat/completions');

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((part) => part.text ?? '').join('');
  return content == null ? '' : JSON.stringify(content);
}

export function parse(body) {
  const tools = (body.tools ?? []).map((t) => ({ name: t.function?.name ?? '', properties: t.function?.parameters?.properties ?? {} }));
  const messages = body.messages ?? [];
  return {
    main: tools.length > 0,
    model: body.model,
    tools,
    conversation: messages,
    toolCalls: messages.flatMap((m) => m.tool_calls ?? []).map((c) => ({ id: c.id, name: c.function?.name })),
    toolResults: messages.filter((m) => m.role === 'tool').map((m) => ({ callId: m.tool_call_id, text: textOf(m.content) })),
  };
}

export function open(res, body) {
  const sse = openSse(res);
  const base = { id: `chatcmpl-xf-${Date.now()}`, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: body.model };
  const chunk = (delta, finish = null) => sse.send({ ...base, choices: [{ index: 0, delta, finish_reason: finish }] });
  let toolCalls = 0;
  chunk({ role: 'assistant', content: '' });
  return {
    text: (text) => chunk({ content: text }),
    toolCall({ id, name: toolName, args }) {
      const index = toolCalls++;
      chunk({ tool_calls: [{ index, id, type: 'function', function: { name: toolName, arguments: '' } }] });
      for (const piece of halves(JSON.stringify(args))) chunk({ tool_calls: [{ index, function: { arguments: piece } }] });
    },
    end() {
      chunk({}, toolCalls > 0 ? 'tool_calls' : 'stop');
      if (body.stream_options?.include_usage) {
        sse.send({ ...base, choices: [], usage: { prompt_tokens: USAGE.input, completion_tokens: USAGE.output, total_tokens: USAGE.input + USAGE.output } });
      }
      sse.send('[DONE]');
      sse.end();
    },
  };
}

/** A request without tools (title generation and the like): answer with a short text, never consume the tape. */
export function aux(res, body) {
  if (body.stream) {
    const writer = open(res, body);
    writer.text('xf-audit');
    return writer.end();
  }
  sendJson(res, 200, {
    id: 'chatcmpl-xf-aux', object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: body.model,
    choices: [{ index: 0, message: { role: 'assistant', content: 'xf-audit' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  });
}
