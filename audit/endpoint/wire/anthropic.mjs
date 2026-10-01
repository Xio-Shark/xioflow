// Anthropic Messages API, streaming (claude).
import { halves, openSse, sendJson, USAGE } from './sse.mjs';

export const name = 'anthropic';
export const matches = (method, pathname) => method === 'POST' && pathname.endsWith('/v1/messages');

function blockText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((block) => block.text ?? '').join('');
  return content == null ? '' : JSON.stringify(content);
}

export function parse(body) {
  const tools = (body.tools ?? []).map((t) => ({ name: t.name ?? '', properties: t.input_schema?.properties ?? {} }));
  const messages = body.messages ?? [];
  const toolCalls = messages.flatMap((m) => (Array.isArray(m.content) ? m.content : []))
    .filter((block) => block.type === 'tool_use').map((block) => ({ id: block.id, name: block.name }));
  const toolResults = messages.flatMap((m) => (Array.isArray(m.content) ? m.content : []))
    .filter((block) => block.type === 'tool_result')
    .map((block) => ({ callId: block.tool_use_id, text: blockText(block.content), isError: block.is_error === true }));
  return { main: tools.length > 0, model: body.model, tools, conversation: messages, toolCalls, toolResults };
}

function message(body, content, stopReason) {
  return {
    id: `msg_xf_${Date.now()}`, type: 'message', role: 'assistant', model: body.model, content,
    stop_reason: stopReason, stop_sequence: null, usage: { input_tokens: USAGE.input, output_tokens: USAGE.output },
  };
}

export function open(res, body) {
  const sse = openSse(res);
  const send = (type, payload) => sse.send({ type, ...payload }, type);
  let index = 0;
  let textOpen = false;
  let toolCalls = 0;
  send('message_start', { message: { ...message(body, [], null), usage: { input_tokens: USAGE.input, output_tokens: 1 } } });
  const closeText = () => {
    if (!textOpen) return;
    send('content_block_stop', { index: index++ });
    textOpen = false;
  };
  return {
    text(text) {
      if (!textOpen) {
        send('content_block_start', { index, content_block: { type: 'text', text: '' } });
        textOpen = true;
      }
      send('content_block_delta', { index, delta: { type: 'text_delta', text } });
    },
    toolCall({ id, name: toolName, args }) {
      closeText();
      toolCalls++;
      send('content_block_start', { index, content_block: { type: 'tool_use', id, name: toolName, input: {} } });
      for (const piece of halves(JSON.stringify(args))) send('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: piece } });
      send('content_block_stop', { index: index++ });
    },
    end() {
      closeText();
      send('message_delta', { delta: { stop_reason: toolCalls > 0 ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: USAGE.output } });
      send('message_stop', {});
      sse.end();
    },
  };
}

export function aux(res, body) {
  if (body.stream) {
    const writer = open(res, body);
    writer.text('xf-audit');
    return writer.end();
  }
  sendJson(res, 200, message(body, [{ type: 'text', text: 'xf-audit' }], 'end_turn'));
}
