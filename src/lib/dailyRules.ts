export function numericalResult(score: number) {
  if (!Number.isInteger(score) || score<0 || score>250) throw new Error('Invalid final score')
  return String(score)
}
export async function copyDailyResult(score: number) { await navigator.clipboard.writeText(numericalResult(score)) }
