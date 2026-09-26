import { proxyActivities } from '@temporalio/workflow';

const { executeAppendActivity } = proxyActivities({
  startToCloseTimeout: '1 minute',
  retry: {
    initialInterval: '500ms',
    maximumAttempts: 5,
  },
});

export async function fileAppendingWorkflow(message = 'workflow-execution-effect') {
  const result = await executeAppendActivity(message);
  return result;
}
