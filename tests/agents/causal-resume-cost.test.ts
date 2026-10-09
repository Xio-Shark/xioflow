import { describe, expect, it } from 'vitest';
import { planAgentCausalResumePolicy } from '../../src/index.js';

describe('causal resume total cost policy', () => {
  const forecast = { rejectionProbability: 0.25, validationAccepted: 2, validationRejected: 4, resume: 3, recompute: 20 };
  it('includes reconstruction after rejection and preserves validation on ties', () => {
    expect(planAgentCausalResumePolicy(forecast)).toMatchObject({ strategy: 'validate', expectedValidationCost: 9.75 });
    expect(planAgentCausalResumePolicy({ ...forecast, rejectionProbability: 1 })).toMatchObject({ strategy: 'recompute', expectedValidationCost: 24 });
    expect(planAgentCausalResumePolicy({ ...forecast, rejectionProbability: 0, recompute: 5 }).strategy).toBe('validate');
  });
  it.each([-1, NaN, Infinity])('rejects invalid costs: %s', cost => {
    for (const key of Object.keys(forecast)) expect(() => planAgentCausalResumePolicy({ ...forecast, [key]: cost })).toThrow('Invalid');
  });
  it('rejects probabilities above one and cost overflow', () => {
    expect(() => planAgentCausalResumePolicy({ ...forecast, rejectionProbability: 2 })).toThrow('Invalid');
    expect(() => planAgentCausalResumePolicy({ ...forecast, validationAccepted: Number.MAX_VALUE, resume: Number.MAX_VALUE })).toThrow('overflow');
  });
});
