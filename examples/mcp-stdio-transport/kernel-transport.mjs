/**
 * KernelStdioTransport
 *
 * Implements the Model Context Protocol (MCP) Transport interface
 * using `@xioflow/kernel`'s supervised service operations.
 *
 * Features:
 * - Managed process lifecycle with explicit intent registration
 * - stdinMode: 'stream' for continuous bidirectional JSON-RPC messages
 * - Passthrough stdout framing for client consumption
 * - Bounded stderr drain & spill (B3) for diagnostics without memory leak
 * - Confirmed stop pipeline (graceful SIGTERM -> SIGKILL -> verified dead)
 */
export class KernelStdioTransport {
  constructor(options) {
    this.supervisor = options.supervisor;
    this.spec = options.spec;
    this.graceMs = options.graceMs ?? 2000;

    this.onclose = undefined;
    this.onerror = undefined;
    this.onmessage = undefined;

    this.handle = undefined;
    this.readBuffer = '';
  }

  async start() {
    if (this.handle) {
      throw new Error('KernelStdioTransport already started');
    }

    // 通过内核监督启动 service op
    this.handle = await this.supervisor.startService(this.spec);
    await this.handle.ready;

    // 监听 stdout：换行分割的 JSON-RPC 消息解析
    this.handle.stdout.on('data', (chunk) => {
      this.readBuffer += chunk.toString('utf8');
      let newlineIdx = this.readBuffer.indexOf('\n');
      while (newlineIdx !== -1) {
        const line = this.readBuffer.slice(0, newlineIdx).trim();
        this.readBuffer = this.readBuffer.slice(newlineIdx + 1);
        if (line) {
          try {
            const message = JSON.parse(line);
            this.onmessage?.(message);
          } catch (err) {
            this.onerror?.(err instanceof Error ? err : new Error(String(err)));
          }
        }
        newlineIdx = this.readBuffer.indexOf('\n');
      }
    });

    this.handle.stdout.on('error', (err) => {
      this.onerror?.(err);
    });

    this.handle.stdout.on('close', () => {
      this.onclose?.();
    });
  }

  async send(message) {
    if (!this.handle) {
      throw new Error('KernelStdioTransport not started');
    }
    const json = JSON.stringify(message) + '\n';
    this.handle.stdin.write(json);
  }

  async close() {
    if (this.handle) {
      const handle = this.handle;
      this.handle = undefined;
      await handle.stop(this.graceMs);
      this.onclose?.();
    }
  }

  getServiceHandle() {
    return this.handle;
  }
}
