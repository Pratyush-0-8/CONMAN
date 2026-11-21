import { QUESTION_PROMPT, questionInspiration, recentQuestionDetails, excludedSituations } from './questionPrompt.ts'

export const DEFAULT_QUESTION_MODEL='@cf/google/gemma-4-26b-a4b-it'
export class CloudflareError extends Error {
  status: number
  quotaExhausted: boolean
  retryAfter: number
  retryable: boolean
  usage: unknown
  requestId: string | null
  constructor(message: string,status: number,quotaExhausted=false,retryAfter=0,retryable=false,usage: unknown=null,requestId: string | null=null) {
    super(message); this.status=status; this.quotaExhausted=quotaExhausted; this.retryAfter=retryAfter; this.retryable=retryable; this.usage=usage; this.requestId=requestId
  }
}
export interface CloudflareOutput { output: unknown; usage: unknown; requestId: string | null; status: number }

// One HTTP attempt per call. The orchestrator reserves/logs each attempt before bounded retries.
export async function runQuestionModel({ accountId,apiToken,model=DEFAULT_QUESTION_MODEL,count,history,feedback='',fetcher=fetch }: {
  accountId: string; apiToken: string; model?: string; count: 5 | 10; history: string[]; feedback?: string; fetcher?: typeof fetch
}): Promise<CloudflareOutput> {
  if (!accountId || !apiToken || !/^@(?:cf|hf)\/[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/.test(model)) throw new CloudflareError('Cloudflare credentials/model are not configured correctly',400)
  let response: Response
  try {
    response=await fetcher(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai/run/${model}`,{
      method:'POST',headers:{ Authorization:`Bearer ${apiToken}`,'Content-Type':'application/json' },signal:AbortSignal.timeout(70000),
      body: JSON.stringify({
        messages: [
          { role: 'system', content: QUESTION_PROMPT },
          {
            role: 'user',
            content: JSON.stringify({
              count,
              creativeInspiration: questionInspiration(),
              recentlyUsedDetails: recentQuestionDetails(history),
              excludedSituations: excludedSituations(history),
              correction: /duplicate/i.test(feedback)
                ? 'The prior batch repeated an archived question. Invent completely unrelated premises; avoid rewording earlier ideas.'
                : feedback.slice(0, 300)
            })
          }
        ],
        stream: false,
        response_format: { type: 'json_object' },
        chat_template_kwargs: {
          enable_thinking: false
        },
        max_tokens: 4096,
        temperature: 0.7
      }),
    })
  } catch { throw new CloudflareError('Cloudflare request timed out or could not connect',0,false,0,true) }
  const requestId=response.headers.get('cf-ray') || response.headers.get('x-request-id')
  const raw=await response.text()
  let data: any
  try { data=JSON.parse(raw) } catch { const quota=/used up.*(?:neurons|daily)|daily.*(?:allocation|quota)|quota.*exhaust/i.test(raw); throw new CloudflareError(`Cloudflare returned malformed JSON (${response.status})`,response.status,quota,0,!quota && (response.ok || response.status===429 || response.status>=500),null,requestId) }
  const result=data.result ?? data
  const usage=result?.usage ?? data.usage ?? null
  if (!response.ok || data.success===false) {
    const errors=Array.isArray(data.errors) ? data.errors : []
    const message=errors.map((error: any) => String(error.message || '')).join('; ').slice(0,350) || `Cloudflare request failed (${response.status})`
    const exhausted=errors.some((error: any) => Number(error.code)===3036) || /used up.*(?:neurons|daily)|daily.*(?:allocation|quota)|quota.*exhaust/i.test(message)
    const retryHeader=response.headers.get('retry-after')
    const seconds=retryHeader ? (/^\d+$/.test(retryHeader) ? Number(retryHeader) : Math.ceil((Date.parse(retryHeader)-Date.now())/1000)) : 0
    throw new CloudflareError(message,response.status,exhausted,Math.max(0,Math.min(86400,Number.isFinite(seconds) ? seconds : 0)),!exhausted && (response.status===429 || response.status===408 || response.status>=500),usage,requestId)
  }
  const output=result?.response ?? result?.choices?.[0]?.message?.content ?? (Array.isArray(result?.questions) ? result : undefined)
  if (output===undefined) throw new CloudflareError('Cloudflare returned no structured question output',response.status,false,0,true,usage,requestId)
  return { output,usage,requestId,status:response.status }
}
