import fs from 'node:fs';

/** Deliberately reads actual facts without using ProcessHost or its predicates. */
export async function gradeProcess(fixture, submission, evidence) {
  const checks = { shape: false, evidence: false, identity: false, currentFacts: false, outcome: false };
  if (!submission || Object.keys(submission).sort().join() !== 'evidenceId,instanceId,outcome') return { passed: false, checks };
  checks.shape = ['ready', 'exited', 'timeout', 'unavailable'].includes(submission.outcome);
  const sample = evidence.get(submission.evidenceId);
  const observed = sample?.rows.find((row) => row.instanceId === submission.instanceId);
  checks.evidence = Boolean(observed);
  const target = fixture.current.find((item) => item.name === fixture.spec.name && item.environment === fixture.spec.environment);
  checks.identity = Boolean(target && target.instanceId === submission.instanceId && target.current);
  if (!checks.shape || !checks.evidence || !checks.identity) return { passed: false, checks };
  const config = JSON.parse(fs.readFileSync(target.configFile));
  let state;
  let unavailable = false;
  if (target.alive) {
    try {
      const response = await fetch(`${target.url}/ready`, { redirect: 'error', signal: AbortSignal.timeout(300) });
      const body = await response.json();
      if (body.error === 'probe_unavailable') unavailable = true;
      else {
        if (![200, 503].includes(response.status) || body.instanceId !== target.instanceId || body.pid !== target.pid) throw new Error('Independent probe identity/status mismatch');
        state = body;
        if ((response.status === 200) !== state.ready) throw new Error('Independent ready status mismatch');
      }
    } catch (error) {
      if (error.name !== 'TypeError' && error.name !== 'TimeoutError') throw error;
      unavailable = true;
    }
  }
  if (submission.outcome === 'exited') checks.currentFacts = !target.alive && !observed.alive;
  else if (submission.outcome === 'unavailable') checks.currentFacts = target.alive && unavailable && observed.alive && !observed.available;
  else if (submission.outcome === 'timeout') checks.currentFacts = fixture.started !== null && Date.now() - fixture.started >= fixture.deadlineMs && target.alive && !state?.ready && !observed.ready;
  else checks.currentFacts = Boolean(target.alive && observed.alive && state?.ready && observed.ready &&
    state.loadedRevision === config.revision && state.setting === config.setting &&
    observed.loadedRevision === state.loadedRevision && observed.configRevision === config.revision &&
    observed.setting === state.setting && observed.configSetting === config.setting);
  checks.outcome = submission.outcome === fixture.spec.expected;
  return { passed: Object.values(checks).every(Boolean), checks, checkedAt: Date.now(),
    actual: { instanceId: target.instanceId, alive: target.alive, revision: config.revision,
      loadedRevision: state?.loadedRevision ?? null, ready: state?.ready ?? false, unavailable } };
}
