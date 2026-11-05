import { describe, expect, it, vi } from 'vitest';
import { ProcessSampler } from '../../src/driver/sampler.js';
import { NodePlatformDriver } from '../../src/driver/node-driver.js';

describe('tracked process execution state', () => {
  it('keeps observed zombies separate from executable residuals', async () => {
    const sampler = new ProcessSampler({ readProcessTable: async () => [
      '101 1 101 Z 0 00:00.01 stopped-zombie',
      '102 1 101 S 10 00:00.01 running-child',
    ].join('\n') });
    expect(await sampler.classifyPids([101, 102, 101])).toEqual({ runningPids: [102], unreapedPids: [101] });
  });

  it('does not turn a live PID missing from the snapshot into proof of stopping', async () => {
    const sampler = new ProcessSampler({ readProcessTable: async () => '101 1 101 Z 0 00:00.01 zombie' });
    await expect(sampler.classifyPids([process.pid])).rejects.toThrow(/exists but is missing/);
  });

  it('does not turn failed OS observation into an empty stopped tree', async () => {
    const sampler = new ProcessSampler({ readProcessTable: async () => { throw new Error('ps unavailable'); } });
    await expect(sampler.classifyPids([process.pid])).rejects.toThrow(/observation/i);
  });

  it('keeps an existing process group missing from OS observation unknown', async () => {
    const sampler = new ProcessSampler({ readProcessTable: async () => '101 1 101 Z 0 00:00.01 zombie' });
    const kill = vi.spyOn(process, 'kill').mockImplementation((_pid, signal) => {
      if (signal !== 0) throw new Error('The observation probe must not signal processes');
      return true;
    });
    try {
      await expect(sampler.isGroupAlive(202)).rejects.toThrow(/exists but is missing/);
    } finally { kill.mockRestore(); }
  });

  it('preserves unreaped facts when terminating a group already containing only zombies', async () => {
    const sampler = ProcessSampler.getInstance();
    const snapshot = vi.spyOn(sampler, 'getSnapshot').mockResolvedValue(new Map([[99999999, {
      pid: 99999999, ppid: 1, pgid: 99999999, state: 'Z', rssKb: 0, timeStr: '00:00.01', command: 'stopped-zombie',
    }]]));
    try {
      expect(await new NodePlatformDriver().terminateGroup(99999999, 1)).toEqual({
        stopped: 'confirmed_stopped', scope: 'process_group', unreapedPids: [99999999],
      });
    } finally { snapshot.mockRestore(); sampler.clearCache(); }
  });
});
