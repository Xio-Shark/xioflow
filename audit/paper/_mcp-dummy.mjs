import fs from 'node:fs';

const marker = process.argv.find((a) => a.startsWith('--marker='))?.slice('--marker='.length);
if (marker) {
  fs.writeFileSync(marker, `${process.pid}\n`, 'utf8');
}
// Drain stdin without exiting when stdin closes (reproduces leaking stdio MCP servers in S8)
process.stdin.resume();
setInterval(() => {}, 1000);
