/** Folds an angle into (−90, 90]; path angles are meaningful modulo 180. */
export function foldAngle(angle: number): number {
  const half = ((angle % 180) + 180) % 180;
  return half > 90 ? half - 180 : half;
}

/** Folds a crossing angle into [0, 180); the two passes cross the same way either side. */
export const foldCrossAngle = (angle: number): number => ((angle % 180) + 180) % 180;
