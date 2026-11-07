const invalidConcurrency = '--concurrency must be a positive integer or a percentage greater than 0% and at most 100%.';

export function parseConcurrency(value, parallelism) {
  if (/^\d+$/.test(value ?? '') && Number(value) >= 1) return Number(value);

  const percentage = /^(\d+(?:\.\d+)?)%$/.exec(value ?? '');
  if (percentage) {
    const amount = Number(percentage[1]);
    if (amount > 0 && amount <= 100) {
      return Math.max(1, Math.floor(parallelism * amount / 100));
    }
  }

  throw new Error(invalidConcurrency);
}
