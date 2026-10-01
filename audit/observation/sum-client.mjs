import assert from 'node:assert/strict';

/** Deterministic provider fixture: sees only runner messages, never the filesystem. */
export function createSumClient(onRequest) {
  return {
    async complete(request) {
      onRequest();
      const results = request.messages.filter((message) => message.role === 'tool');
      const call = (id, name, args) => ({ content: '', toolCalls: [{ id, name, arguments: args }] });
      if (results.length === 0) return call('a', 'read', { path: 'a.txt' });
      if (results.length === 1) return call('b', 'read', { path: 'b.txt' });
      if (results.length === 2) {
        const a = Number(results[0].content.match(/A=(\d+)/)?.[1]);
        const b = Number(results[1].content.match(/B=(\d+)/)?.[1]);
        assert.ok(Number.isFinite(a) && Number.isFinite(b));
        return call('sum', 'write', { path: 'result.txt', content: `sum=${a + b}\n` });
      }
      return { content: 'done', toolCalls: [] };
    },
  };
}
