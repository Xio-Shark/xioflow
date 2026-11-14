export interface BenchmarkArmMetrics {
  turns: number;
  contextBytes: number;
  estTokens: number;
  durationMs: number;
  dataIntegrity: string;
}

export interface BenchmarkScenarioResult {
  id: string;
  rawBash: BenchmarkArmMetrics;
  xioMedium: BenchmarkArmMetrics;
  contextReductionPct?: number;
  speedupFactor?: number;
}

export interface MediumVsBashBenchmarkReport {
  platform: string;
  nodeVersion: string;
  scenarios: BenchmarkScenarioResult[];
}

export function runMediumVsBashBenchmark(): Promise<MediumVsBashBenchmarkReport>;
