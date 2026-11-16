import { useCallback, useEffect, useRef, useState } from 'react'

export type MicStatus = 'starting' | 'listening' | 'denied' | 'unsupported' | 'error' | 'stopped'

export async function requestMicrophone() {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('Microphone access is unavailable. Open this app over HTTPS in a browser with microphone support, then retry.')
  }
  let stream: MediaStream | undefined
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    if (!stream.getAudioTracks().some((track) => track.readyState === 'live')) {
      throw new Error('No working microphone was found. Connect a microphone, then retry.')
    }
  } catch (error) {
    const name = error instanceof DOMException ? error.name : ''
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      throw new Error('Allow microphone access in your browser’s site settings, then retry. If this preview blocks access, open the app in its own tab.')
    }
    if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
      throw new Error('No microphone was found. Connect a microphone, then retry.')
    }
    if (name === 'NotReadableError' || name === 'AbortError') {
      throw new Error('Your microphone could not be opened. Check your system microphone settings and close other apps using it, then retry.')
    }
    throw error instanceof Error ? error : new Error('Could not access your microphone. Check your browser and device settings, then retry.')
  } finally {
    // This is a permission check only; recognition opens the mic during speaking.
    stream?.getTracks().forEach((track) => track.stop())
  }
}

interface RecognitionResult { [index: number]: { transcript: string } }
interface Recognition {
  continuous: boolean
  interimResults: boolean
  lang: string
  onstart: (() => void) | null
  onresult: ((event: { results: ArrayLike<RecognitionResult> }) => void) | null
  onerror: ((event: { error: string }) => void) | null
  onend: (() => void) | null
  start(): void
  stop(): void
  abort(): void
}
type SpeechWindow = Window & { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition }

export function useSpeech() {
  const [text, setText] = useState('')
  const [status, setStatus] = useState<MicStatus>('starting')
  const [attempt, setAttempt] = useState(0)
  const transcript = useRef('')
  const stop = useRef<() => Promise<string>>(() => Promise.resolve(transcript.current))

  useEffect(() => {
    let disposed = false, stopping = false, failed = false, active = false
    let saved = transcript.current
    let restart: ReturnType<typeof setTimeout> | undefined
    let finalWait: ReturnType<typeof setTimeout> | undefined
    let resolveFinal: ((text: string) => void) | undefined
    let finishing: Promise<string> | undefined
    const SR = (window as SpeechWindow).SpeechRecognition || (window as SpeechWindow).webkitSpeechRecognition
    let rec: Recognition | undefined
    const complete = () => {
      if (finalWait) clearTimeout(finalWait)
      resolveFinal?.(transcript.current)
      resolveFinal = undefined
    }
    stop.current = () => {
      if (finishing) return finishing
      stopping = true
      if (restart) clearTimeout(restart)
      setStatus('stopped')
      finishing = new Promise<string>((resolve) => { resolveFinal = resolve })
      if (!rec || !active) complete()
      else {
        // stop() allows the last result to arrive; abort() would discard it.
        finalWait = setTimeout(() => {
          complete()
          try { rec?.abort() } catch { /* Already stopped. */ }
        }, 1000)
        try { rec.stop() } catch { complete() }
      }
      return finishing
    }
    if (!SR) setStatus('unsupported')
    else {
      try {
        rec = new SR()
        rec.continuous = true
        rec.interimResults = true
        rec.lang = 'en-US'
        const start = () => {
          if (disposed || stopping || failed || !rec) return
          saved = transcript.current
          setStatus('starting')
          try { rec.start(); active = true } catch { failed = true; active = false; setStatus('error') }
        }
        rec.onstart = () => { if (!disposed && !stopping) setStatus('listening') }
        rec.onresult = (event) => {
          if (disposed) return
          // Each session's result list includes both final and changing interim results.
          const current = Array.from(event.results, (result) => result[0].transcript.trim()).filter(Boolean).join(' ')
          transcript.current = [saved, current].filter(Boolean).join(' ')
          setText(transcript.current)
        }
        rec.onerror = (event) => {
          if (disposed || stopping) return
          if (event.error === 'no-speech') return
          failed = true
          setStatus(event.error === 'not-allowed' || event.error === 'service-not-allowed' ? 'denied' : 'error')
        }
        rec.onend = () => {
          active = false
          if (disposed) return
          if (stopping) complete()
          else if (!failed) restart = setTimeout(start, 100)
        }
        start()
      } catch { setStatus('error') }
    }
    return () => {
      disposed = true
      if (restart) clearTimeout(restart)
      complete()
      try { rec?.abort() } catch { /* Already stopped. */ }
    }
  }, [attempt])

  const finish = useCallback(() => stop.current(), [])
  const retry = useCallback(() => setAttempt((n) => n + 1), [])
  return { text, status, finish, retry }
}
