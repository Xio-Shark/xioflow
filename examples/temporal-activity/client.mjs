import { Connection, Client } from '@temporalio/client';
import { fileAppendingWorkflow } from './workflows.mjs';

async function run() {
  const connection = await Connection.connect();
  const client = new Client({ connection });

  const workflowId = 'workflow-' + Date.now();
  console.log(`Starting workflow with ID: ${workflowId}...`);

  const handle = await client.workflow.start(fileAppendingWorkflow, {
    taskQueue: 'xioflow-temporal-queue',
    workflowId,
    args: ['payload-from-client'],
  });

  console.log(`Workflow started. Waiting for result...`);
  const result = await handle.result();
  console.log('Workflow result:', result);
}

run().catch((err) => {
  console.error('Client run failed:', err);
  process.exit(1);
});
