// OpenAI Responses API, streaming (codex).
import { halves, openSse, sendJson, USAGE } from './sse.mjs';

export const name = 'responses';
export const matches = (method, pathname) => method === 'POST' && pathname.endsWith('/responses');

function outputText(output) {
  if (typeof output === 'string') return output;
  if (Array.isArray(output)) return output.map((part) => part.text ?? '').join('');
  return output == null ? '' : JSON.stringify(output);
}

export function parse(body) {
  const tools = (body.tools ?? [])
    .filter((t) => t.type === 'function')
    .map((t) => ({ name: t.name ?? '', properties: t.parameters?.properties ?? {} }));
  const input = Array.isArray(body.input) ? body.input : [];
  return {
    main: tools.length > 0,
    model: body.model,
    tools,
    conversation: input,
    toolCalls: input.filter((i) => i.type === 'function_call').map((i) => ({ id: i.call_id, name: i.name })),
    toolResults: input.filter((i) => i.type === 'function_call_output').map((i) => ({ callId: i.call_id, text: outputText(i.output) })),
  };
}

export function open(res, body) {
  const sse = openSse(res);
  const responseId = `resp_xf_${Date.now()}`;
  const response = (status, extra = {}) => ({ id: responseId, object: 'response', created_at: Math.floor(Date.now() / 1000), status, model: body.model, output: [], ...extra });
  let sequence = 0;
  const send = (type, payload) => sse.send({ type, sequence_number: sequence++, ...payload }, type);
  const output = [];
  send('response.created', { response: response('in_progress') });
  send('response.in_progress', { response: response('in_progress') });

  let message; // the one assistant message item, opened lazily
  const closeMessage = () => {
    if (!message) return;
    const { index, id, text } = message;
    message = undefined;
    const part = { type: 'output_text', text, annotations: [] };
    send('response.output_text.done', { item_id: id, output_index: index, content_index: 0, text });
    send('response.content_part.done', { item_id: id, output_index: index, content_index: 0, part });
    const item = { type: 'message', id, role: 'assistant', status: 'completed', content: [part] };
    output[index] = item;
    send('response.output_item.done', { output_index: index, item });
  };

  return {
    text(text) {
      if (!message) {
        message = { index: output.length, id: `msg_xf_${output.length}`, text: '' };
        output.push(null);
        send('response.output_item.added', { output_index: message.index, item: { type: 'message', id: message.id, role: 'assistant', status: 'in_progress', content: [] } });
        send('response.content_part.added', { item_id: message.id, output_index: message.index, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
      }
      message.text += text;
      send('response.output_text.delta', { item_id: message.id, output_index: message.index, content_index: 0, delta: text });
    },
    toolCall({ id, name: toolName, args }) {
      closeMessage();
      const index = output.length;
      const itemId = `fc_xf_${index}`;
      const argumentsJson = JSON.stringify(args);
      send('response.output_item.added', { output_index: index, item: { type: 'function_call', id: itemId, call_id: id, name: toolName, arguments: '', status: 'in_progress' } });
      for (const piece of halves(argumentsJson)) send('response.function_call_arguments.delta', { item_id: itemId, output_index: index, delta: piece });
      send('response.function_call_arguments.done', { item_id: itemId, output_index: index, arguments: argumentsJson });
      const item = { type: 'function_call', id: itemId, call_id: id, name: toolName, arguments: argumentsJson, status: 'completed' };
      output.push(item);
      send('response.output_item.done', { output_index: index, item });
    },
    end() {
      closeMessage();
      send('response.completed', {
        response: response('completed', {
          output,
          usage: {
            input_tokens: USAGE.input, input_tokens_details: { cached_tokens: 0 },
            output_tokens: USAGE.output, output_tokens_details: { reasoning_tokens: 0 },
            total_tokens: USAGE.input + USAGE.output,
          },
        }),
      });
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
  sendJson(res, 200, { id: 'resp_xf_aux', object: 'response', status: 'completed', model: body.model, output: [{ type: 'message', id: 'msg_xf_aux', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'xf-audit', annotations: [] }] }] });
}
