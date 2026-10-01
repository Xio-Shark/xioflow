export function openSse(res, extraHeaders = {}) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', ...extraHeaders });
  return {
    /** `event` is optional: OpenAI chat and Gemini send bare data frames. */
    send(data, event) {
      if (res.writableEnded || res.destroyed) return;
      res.write(`${event ? `event: ${event}\n` : ''}data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`);
    },
    end() {
      if (!res.writableEnded) res.end();
    },
  };
}

export function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

/** Splits a string in two so argument streaming is exercised without flooding the stream. */
export function halves(text) {
  const mid = Math.ceil(text.length / 2);
  return [text.slice(0, mid), text.slice(mid)].filter(Boolean);
}

export const USAGE = { input: 100, output: 20 };
