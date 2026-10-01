// A proxy that refuses everything and writes down what was asked of it. Harnesses get it as HTTP(S)_PROXY, so
// update checks, telemetry and catalog downloads that honour proxy variables never leave the machine, and each
// trial records which hosts the harness tried to reach. A harness that ignores proxy variables is not caught
// here; check-isolation.mjs samples its sockets instead.
import http from 'node:http';

export async function startBlackhole() {
  const attempts = [];
  const server = http.createServer((req, res) => {
    attempts.push(`${req.method} ${req.url}`);
    res.writeHead(502, { 'content-type': 'text/plain' });
    res.end('xf-audit: outbound traffic is refused during a trial');
  });
  // A harness that is killed mid-request resets its sockets; that must not take the bench down.
  server.on('clientError', (_err, socket) => socket.destroy());
  server.on('connect', (req, socket) => {
    socket.on('error', () => {});
    attempts.push(`CONNECT ${req.url}`);
    socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const loopback = '127.0.0.1,localhost,::1';
  return {
    attempts,
    env: { HTTPS_PROXY: url, https_proxy: url, HTTP_PROXY: url, http_proxy: url, NO_PROXY: loopback, no_proxy: loopback },
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
