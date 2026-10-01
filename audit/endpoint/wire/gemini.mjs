// Gemini API (gemini-cli): `:streamGenerateContent?alt=sse` for the agent loop, `:generateContent` for helpers.
import { openSse, sendJson, USAGE } from './sse.mjs';

export const name = 'gemini';
export const matches = (method, pathname) => method === 'POST' && /:(stream)?[gG]enerateContent$/.test(pathname);

function responseText(response) {
  if (typeof response === 'string') return response;
  if (response && typeof response === 'object') {
    const value = response.output ?? response.error ?? response.content ?? response;
    return typeof value === 'string' ? value : JSON.stringify(value);
  }
  return '';
}

export function parse(body, url) {
  const tools = (body.tools ?? []).flatMap((t) => t.functionDeclarations ?? []).map((f) => ({
    name: f.name ?? '',
    properties: (f.parametersJsonSchema ?? f.parameters)?.properties ?? {},
  }));
  const contents = body.contents ?? [];
  const toolResults = contents.flatMap((c) => (c.parts ?? []))
    .filter((part) => part.functionResponse)
    .map((part) => ({ callId: part.functionResponse.id ?? part.functionResponse.name, text: responseText(part.functionResponse.response) }));
  const toolCalls = contents.flatMap((c) => (c.parts ?? [])).filter((part) => part.functionCall)
    .map((part) => ({ id: part.functionCall.id ?? part.functionCall.name, name: part.functionCall.name }));
  return { main: tools.length > 0, model: decodeURIComponent(url.pathname.split('/models/')[1]?.split(':')[0] ?? ''), tools, conversation: contents, toolCalls, toolResults };
}

const usageMetadata = { promptTokenCount: USAGE.input, candidatesTokenCount: USAGE.output, totalTokenCount: USAGE.input + USAGE.output };
const candidate = (parts, finishReason) => ({ candidates: [{ content: { role: 'model', parts }, index: 0, ...(finishReason ? { finishReason } : {}) }] });

export function open(res) {
  const sse = openSse(res);
  return {
    text: (text) => sse.send(candidate([{ text }])),
    toolCall: ({ id, name: toolName, args }) => sse.send(candidate([{ functionCall: { id, name: toolName, args } }])),
    end() {
      sse.send({ ...candidate([{ text: '' }], 'STOP'), usageMetadata });
      sse.end();
    },
  };
}

/** Builds a value that satisfies a (Gemini-style, upper-case types) JSON schema: helpers ask for structured output. */
function fillSchema(schema) {
  const type = String(schema?.type ?? '').toUpperCase();
  if (schema?.enum?.length) return schema.enum[0];
  if (type === 'OBJECT') return Object.fromEntries(Object.entries(schema.properties ?? {}).map(([key, sub]) => [key, fillSchema(sub)]));
  if (type === 'ARRAY') return [];
  if (type === 'INTEGER' || type === 'NUMBER') return 1;
  if (type === 'BOOLEAN') return false;
  return 'xf-audit';
}

export function aux(res, body, url) {
  const config = body.generationConfig ?? {};
  const schema = config.responseJsonSchema ?? config.responseSchema;
  const text = schema ? JSON.stringify(fillSchema(schema)) : 'xf-audit';
  if (url.pathname.endsWith(':streamGenerateContent')) {
    const sse = openSse(res);
    sse.send({ ...candidate([{ text }], 'STOP'), usageMetadata });
    return sse.end();
  }
  sendJson(res, 200, { ...candidate([{ text }], 'STOP'), usageMetadata });
}
