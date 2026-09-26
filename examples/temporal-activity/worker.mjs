import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Worker } from '@temporalio/worker';
import * as activities from './activities.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function run() {
  const worker = await Worker.create({
    workflowsPath: path.resolve(__dirname, './workflows.mjs'),
    activities,
    taskQueue: 'xioflow-temporal-queue',
  });

  console.log('Temporal Worker started, listening on queue: xioflow-temporal-queue');
  await worker.run();
}

run().catch((err) => {
  console.error('Worker failed:', err);
  process.exit(1);
});
