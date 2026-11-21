import { MODEL } from './judge.ts'

export class JudgeProviderError extends Error {
  constructor(message: string, public status = 503, public transient = false) { super(message) }
}

// The combined provider window stays within the existing 90-second database claim lease.
export async function judgeWithProviders<T>({ prompt, input, parse, env, fetcher = fetch }: {
  prompt: string; input: Record<string, unknown>; parse: (content: string) => T
  env: (name: string) => string | undefined; fetcher?: typeof fetch
}): Promise<{ judgment: T; model: string; provider: 'azure' | 'groq' }> {
  const endpoint = env('AZURE_OPENAI_ENDPOINT'), key = env('AZURE_OPENAI_API_KEY'), deployment = env('AZURE_OPENAI_DEPLOYMENT')
  if (!endpoint || !key || !deployment) throw new JudgeProviderError('Azure judging is not configured. Your answer is saved.')
  let base: URL
  try { base = new URL(endpoint) } catch { throw new JudgeProviderError('Azure judging endpoint is invalid.') }
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash
    || !/\.(?:openai\.azure\.com|services\.ai\.azure\.com)$/.test(base.hostname)) throw new JudgeProviderError('Azure judging endpoint is invalid.')
  const azureUrl = endpoint.replace(/\/+$/, '').replace(/\/openai\/v1$/, '') + '/openai/v1/chat/completions'
  const messages = [{ role: 'system', content: prompt }, { role: 'user', content: JSON.stringify(input) }]
  const complete = async (provider: 'azure' | 'groq') => {
    const azure = provider === 'azure', apiKey = azure ? key : env('GROQ_API_KEY')
    if (!apiKey) throw new JudgeProviderError('Fallback judging is not configured. Your answer is saved.')
    let response: Response
    try {
      response = await fetcher(azure ? azureUrl : 'https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...(azure ? { 'api-key': apiKey } : { Authorization: `Bearer ${apiKey}` }) },
        signal: AbortSignal.timeout(azure ? 20000 : 25000),
        body: JSON.stringify({ model: azure ? deployment : MODEL, temperature: 0.2, max_completion_tokens: 3000, response_format: { type: 'json_object' }, messages }),
      })
    } catch { throw new JudgeProviderError(`${azure ? 'Azure' : 'Fallback'} judging could not connect. Your answer is saved.`, 503, true) }
    if (!response.ok) throw new JudgeProviderError(`${azure ? 'Azure' : 'Fallback'} judging is temporarily unavailable (${response.status}). Your answer is saved.`, response.status === 429 ? 429 : 503, response.status === 408 || response.status === 429 || response.status >= 500)
    let output: { choices?: { message?: { content?: string } }[] }
    try { output = await response.json() } catch { throw new JudgeProviderError('Judge returned an unreadable response. Your answer is saved.', 503, true) }
    // Invalid scoring output is never finalized or silently replaced with fabricated scores.
    let judgment: T
    try { judgment = parse(output.choices?.[0]?.message?.content || '') }
    catch { throw new JudgeProviderError('Judge returned invalid scoring JSON. Your answer is saved; retry.') }
    return { judgment, model: azure ? `azure:${deployment}` : MODEL, provider }
  }
  try { return await complete('azure') }
  catch (error) {
    if (!(error instanceof JudgeProviderError) || !error.transient) throw error
    // Retry the entire joint request: competitive players can never be split across models.
    return await complete('groq')
  }
}
