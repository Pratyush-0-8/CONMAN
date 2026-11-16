import { useEffect, useRef, useState } from 'react'

export type MicStatus = 'listening' | 'denied' | 'unsupported' | 'error'

/** Tries the browser Web Speech API; falls back to a simulated transcript so the demo always works. */
export function useSpeech(sample: string) {
  const [text, setText] = useState('')
  const [status, setStatus] = useState<MicStatus>('listening')
  const [simulated, setSimulated] = useState(false)
  const ref = useRef('')
  const set = (t: string) => { ref.current = t; setText(t) }

  useEffect(() => {
    let rec: any, sim: ReturnType<typeof setInterval> | undefined, stopped = false
    const simulate = () => {
      if (sim) return
      setSimulated(true)
      const words = sample.split(' ')
      let i = 0
      sim = setInterval(() => { i++; set(words.slice(0, i).join(' ')); if (i >= words.length && sim) clearInterval(sim) }, Math.min(380, 12500 / words.length))
    }
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
    if (!SR) { setStatus('unsupported'); simulate() }
    else {
      try {
        rec = new SR(); rec.continuous = true; rec.interimResults = true; rec.lang = 'en-US'
        rec.onresult = (e: any) => { let s = ''; for (let i = 0; i < e.results.length; i++) s += e.results[i][0].transcript; set(s.trim()) }
        rec.onerror = (e: any) => {
          if (stopped) return
          if (e.error === 'not-allowed' || e.error === 'service-not-allowed') { setStatus('denied'); simulate() }
          else if (e.error === 'audio-capture' || e.error === 'network' || e.error === 'language-not-supported') { setStatus('error'); simulate() }
        }
        rec.start()
      } catch { setStatus('error'); simulate() }
    }
    return () => { stopped = true; if (sim) clearInterval(sim); try { rec?.abort() } catch { /* noop */ } }
  }, [sample])

  return { text, status, simulated, get final() { return ref.current } }
}
