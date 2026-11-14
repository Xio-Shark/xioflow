export function getOllamaConfig() {
  const apiBase = (process.env.OLLAMA_API_BASE || 'https://ollama.com').replace(/\/+$/, '');
  const model = process.env.OLLAMA_MODEL || 'deepseek-v4.1-flash:1017';
  const apiKey = process.env.OLLAMA_API_KEY || '';
  if (!apiKey) {
    throw new Error('OLLAMA_API_KEY is required in environment (source ~/.config/xioflow/ollama.env)');
  }
  return { apiBase, model, apiKey };
}

export function scrubCredential(text, secret) {
  if (!secret || typeof text !== 'string') return text;
  return text.split(secret).join('<REDACTED_API_KEY>');
}

export async function callChatCompletions({
  baseUrl,
  apiKey,
  model,
  messages,
  tools,
  temperature = 0,
  maxTokens = 1024,
  timeoutMs = 45_000,
  maxRetries = 3,
}) {
  const normalized = baseUrl.replace(/\/+$/, '');
  const url = normalized.endsWith('/v1')
    ? `${normalized}/chat/completions`
    : `${normalized}/v1/chat/completions`;
  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const body = {
        model,
        messages,
        temperature,
        max_tokens: maxTokens,
        stream: false,
        ...(tools && tools.length > 0 ? { tools, tool_choice: 'auto' } : {}),
      };
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const raw = await res.text();
      if (!res.ok) {
        const retryable = res.status === 429 || res.status >= 500;
        const err = new Error(`HTTP ${res.status}: ${scrubCredential(raw.slice(0, 500), apiKey)}`);
        if (retryable && attempt < maxRetries) {
          lastErr = err;
          await new Promise((r) => setTimeout(r, 700 * (2 ** attempt) + Math.floor(Math.random() * 400)));
          continue;
        }
        throw err;
      }
      const parsed = JSON.parse(raw);
      const choice = parsed.choices?.[0];
      const msg = choice?.message ?? {};
      const toolCalls = (msg.tool_calls ?? []).map((tc, idx) => {
        let args = {};
        const rawArgs = tc.function?.arguments;
        if (typeof rawArgs === 'string' && rawArgs.trim()) {
          try {
            args = JSON.parse(rawArgs);
          } catch {
            args = { __parseError: rawArgs };
          }
        } else if (rawArgs && typeof rawArgs === 'object') {
          args = rawArgs;
        }
        return {
          id: tc.id || `call-${idx}`,
          name: tc.function?.name || '',
          args,
        };
      });
      const usage = {
        promptTokens: Number(parsed.usage?.prompt_tokens ?? 0),
        completionTokens: Number(parsed.usage?.completion_tokens ?? 0),
        totalTokens: Number(parsed.usage?.total_tokens ?? 0),
      };
      return {
        content: typeof msg.content === 'string' ? msg.content : '',
        toolCalls,
        rawMessage: msg,
        usage,
        finishReason: choice?.finish_reason ?? null,
      };
    } catch (err) {
      lastErr = err;
      if (attempt < maxRetries && !String(err?.message ?? '').startsWith('HTTP 40')) {
        await new Promise((r) => setTimeout(r, 700 * (2 ** attempt) + Math.floor(Math.random() * 400)));
        continue;
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}
