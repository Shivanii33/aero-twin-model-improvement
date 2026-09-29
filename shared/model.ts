export const FEATURE_NAMES = [
  "rpm", "manifold_pressure_bar", "oil_temp_c", "oil_press_bar",
  "cht_cyl1", "cht_cyl2", "cht_cyl3_anomaly", "cht_cyl4",
] as const;

export type FeatureName = typeof FEATURE_NAMES[number];
export type ModelInput = Record<FeatureName, number>;
export type RegressionMetrics = { mae: number; rmse: number; r2: number | null; unit: string };
export type ModelMetrics = {
  model: string;
  version: string;
  trainedAt: string;
  trainingMs: number;
  dataset: { file: string; sha256: string; rows: number; trainRows: number; testRows: number };
  /** `seed` drives forest bagging and permutation importance; the split itself is chronological and unseeded. */
  split: { method: string; seed: number; trainFraction: number; trainTimestampSec: [number, number]; testTimestampSec: [number, number] };
  parameters: { nEstimators: number; maxFeatures: number; maxDepth: number; minNumSamples: number };
  features: { name: FeatureName; min: number; max: number }[];
  targets: { health: RegressionMetrics; rul: RegressionMetrics };
  baselineTargets: { health: RegressionMetrics; rul: RegressionMetrics };
  degradationMethod: string;
  featureImportance: { feature: FeatureName; health: number; rul: number }[];
  importanceMethod: string;
  confidenceMethod: string;
  limitations: string[];
};
export type ModelPrediction = {
  health: number;
  healthIndex: number;
  rul: number;
  confidence: number;
  anomaly: number;
  validation: string;
  model: string;
  sampleCount: number;
  outOfRangeFeatures: FeatureName[];
  uncertainty: { healthIndexStd: number; rulHoursStd: number };
  explanations: { method: string; health: FeatureContribution[]; rul: FeatureContribution[] };
};
export type FeatureContribution = { feature: FeatureName; delta: number; reference: number };
