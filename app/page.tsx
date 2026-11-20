"use client";
import { useEffect, useRef, useState } from "react";
import type { SessionView, Payment } from "../src/agent";
import type { Contact } from "../src/contacts";

type Stage = "idle" | "listening" | "transcribing" | "thinking" | "speaking";

// Hands-free turn detection. Calibration knobs: raise VOICE_RMS if background noise sets it
// off, lower it if it misses a quiet voice. END_SILENCE_MS is the pause that ends your turn.
const VOICE_RMS = 0.03;
const END_SILENCE_MS = 1200;
const MAX_TURN_MS = 20_000;

const usd = (n: number) => `$${n.toFixed(2)}`;
/** Empty WAV, played during a tap to unlock audio. */
const SILENT = "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=";

export default function Home() {
  const [view, setView] = useState<SessionView | null>(null);
  const [stage, setStage] = useState<Stage>("idle");
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const [voiceOff, setVoiceOff] = useState(false);
  const [replyBlocked, setReplyBlocked] = useState(false);
  const [live, setLive] = useState(false); // hands-free conversation on
  const [hearing, setHearing] = useState(false); // voice detected in the current turn
  const liveRef = useRef(false); // same as `live`, readable from async callbacks
  const busyRef = useRef(false);
  const discard = useRef(false); // set when a recording is cancelled, not finished
  const mic = useRef<{ stream: MediaStream; ctx: AudioContext; analyser: AnalyserNode } | null>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  const bottom = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    fetch("/api/chat").then(r => r.json()).then(j => setView(j.state)).catch(() => setError("Can't reach the server."));
  }, []);
  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [view?.transcript.length, stage]);

  // Browsers only allow sound right after a tap, but replies arrive seconds later. So during
  // the tap we play a silent clip to unlock one audio element, then reuse it for every reply.
  function unlockAudio() {
    if (audio.current) return;
    audio.current = new Audio(SILENT);
    audio.current.play().catch(() => {});
  }

  async function speak(text: string) {
    const a = (audio.current ??= new Audio());
    a.pause();
    try {
      const r = await fetch("/api/tts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }) });
      if (!r.ok) throw new Error();
      if (a.src.startsWith("blob:")) URL.revokeObjectURL(a.src);
      a.src = URL.createObjectURL(await r.blob());
      setVoiceOff(false);
      try {
        await a.play();
      } catch {
        return setReplyBlocked(true);
      }
      setReplyBlocked(false);
      // resolve when the reply finishes (or is stopped), so listening resumes after it
      await new Promise(done => {
        a.onended = a.onerror = a.onpause = () => done(null);
      });
    } catch {
      setVoiceOff(true);
    }
  }

  /** One user turn, spoken or typed: send it, show and speak the reply, then listen again. */
  async function submit(text: string) {
    text = text.trim();
    if (!text || busyRef.current) return;
    busyRef.current = true; // only while waiting on the server; a click can cut off a spoken reply
    cancelListening();
    unlockAudio();
    audio.current?.pause();
    setReplyBlocked(false);
    setError("");
    setDraft("");
    setStage("thinking");
    setView(v => v && { ...v, pending: null, transcript: [...v.transcript, { role: "user", text }] });
    let reply = "";
    try {
      const r = await fetch("/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }) });
      const j = await r.json();
      if (j.state) setView(j.state);
      if (!r.ok) throw new Error(j.error ?? `Request failed (${r.status}).`);
      reply = j.reply;
    } catch (e: any) {
      setError(e.message);
    }
    busyRef.current = false;
    if (reply) {
      setStage("speaking");
      await speak(reply);
    }
    if (busyRef.current) return; // a newer turn started while this reply was playing
    setStage("idle");
    if (liveRef.current) listen();
  }

  async function startConversation() {
    unlockAudio();
    setError("");
    const ctx = new AudioContext(); // created during the tap so it isn't suspended
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      ctx.createMediaStreamSource(stream).connect(analyser);
      mic.current = { stream, ctx, analyser };
    } catch {
      ctx.close();
      return setError("Microphone blocked. Allow it in the browser, or type below.");
    }
    liveRef.current = true;
    setLive(true);
    listen();
  }

  function stopConversation() {
    liveRef.current = false;
    setLive(false);
    cancelListening();
    audio.current?.pause();
    mic.current?.stream.getTracks().forEach(t => t.stop());
    mic.current?.ctx.close();
    mic.current = null;
  }

  function cancelListening() {
    if (recorder.current?.state === "recording") {
      discard.current = true;
      recorder.current.stop();
    }
    setStage(s => (s === "listening" ? "idle" : s));
  }

  /** Record until the user has spoken and then paused; silence alone is never sent. */
  function listen() {
    const m = mic.current;
    if (!m || !liveRef.current || busyRef.current) return;
    const rec = new MediaRecorder(m.stream);
    const chunks: Blob[] = [];
    const buf = new Float32Array(m.analyser.fftSize);
    const startedAt = performance.now();
    let spokeAt = 0;
    let lastVoice = 0;

    const timer = setInterval(() => {
      if (rec.state !== "recording") return clearInterval(timer);
      m.analyser.getFloatTimeDomainData(buf);
      const rms = Math.sqrt(buf.reduce((sum, x) => sum + x * x, 0) / buf.length);
      const now = performance.now();
      if (rms > VOICE_RMS) {
        lastVoice = now;
        if (!spokeAt) {
          spokeAt = now;
          setHearing(true);
        }
      }
      const turnOver = spokeAt > 0 && (now - lastVoice > END_SILENCE_MS || now - spokeAt > MAX_TURN_MS);
      const quietTooLong = !spokeAt && now - startedAt > 30_000; // restart so recordings stay small
      if (turnOver || quietTooLong) rec.stop();
    }, 50);

    rec.ondataavailable = e => chunks.push(e.data);
    rec.onstop = async () => {
      clearInterval(timer);
      setHearing(false);
      if (discard.current) {
        discard.current = false;
        return;
      }
      if (!liveRef.current) return;
      if (!spokeAt) return listen();
      setStage("transcribing");
      try {
        const fd = new FormData();
        fd.append("file", new Blob(chunks, { type: rec.mimeType }), "speech");
        const r = await fetch("/api/stt", { method: "POST", body: fd });
        const j = await r.json();
        if (!r.ok) throw new Error(j.error);
        if (j.text?.trim()) return submit(j.text);
        setStage("idle");
        listen(); // only noise; keep listening
      } catch (e: any) {
        setError(e.message || "Speech-to-text failed. Type your request instead.");
        stopConversation();
        setStage("idle");
      }
    };
    recorder.current = rec;
    rec.start();
    setStage("listening");
  }

  const busy = stage === "transcribing" || stage === "thinking";
  const spentPct = view ? Math.min(100, (view.spentUsd / view.budgetUsd) * 100) : 0;

  return (
    <div className="mx-auto flex min-h-dvh max-w-5xl flex-col px-4 sm:px-6">
      <header className="flex flex-wrap items-end justify-between gap-x-8 gap-y-3 py-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Gift agent</h1>
          <p className="text-sm text-muted">Ask for a gift card. It quotes the price, you say yes, it pays in USDC.</p>
        </div>
        {view && (
          <div className="w-full sm:w-72" aria-label="Session budget">
            <div className="mb-1.5 flex items-baseline justify-between text-sm">
              <span>
                <span className="text-lg font-semibold tabular-nums">{usd(view.remainingUsd)}</span>
                <span className="text-muted"> left of {usd(view.budgetUsd)}</span>
              </span>
              {view.dryRun && (
                <span className="rounded-full border border-amber px-2 py-0.5 text-xs font-medium text-amber">Test mode</span>
              )}
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-line" role="meter" aria-valuemin={0} aria-valuemax={view.budgetUsd} aria-valuenow={view.remainingUsd}>
              <div className="h-full rounded-full bg-mint transition-[width] duration-500" style={{ width: `${100 - spentPct}%` }} />
            </div>
            <p className="mt-1 text-xs text-muted">Max {usd(view.hardCapUsd)} per card</p>
          </div>
        )}
      </header>

      <div className="grid flex-1 gap-6 pb-6 md:grid-cols-[1fr_17rem]">
        <main className="flex min-h-[60dvh] flex-col">
          <ol className="flex-1 space-y-3" aria-live="polite">
            {view?.transcript.length === 0 && (
              <li className="pt-10 text-muted">
                Tap the mic once, then just talk. Try <q className="text-ink">Get me a $5 Starbucks card.</q>
              </li>
            )}
            {view?.transcript.map((m, i) => (
              <li key={i} className={m.role === "user" ? "flex justify-end" : "flex"}>
                <p
                  className={
                    m.role === "user"
                      ? "max-w-[80%] rounded-2xl rounded-br-sm bg-cobalt px-4 py-2.5 text-white"
                      : "max-w-[80%] rounded-2xl rounded-bl-sm bg-surface px-4 py-2.5 ring-1 ring-line"
                  }
                >
                  {m.text}
                </p>
              </li>
            ))}
            {stage !== "idle" && stage !== "speaking" && (
              <li className="text-sm text-muted">
                {stage === "listening"
                  ? hearing
                    ? "Hearing you…"
                    : "Listening. Just talk, and pause when you're done."
                  : stage === "transcribing"
                    ? "Transcribing…"
                    : "Working on it…"}
              </li>
            )}
          </ol>
          <div ref={bottom} />

          {view?.pending && !busy && (
            <section className="mt-5" aria-label="Waiting for your confirmation">
              <div className="receipt-edge" />
              <div className="bg-surface px-5 pb-5 pt-3 shadow-[0_8px_24px_-12px_rgb(20_33_61_/_0.35)]">
                <p className="text-sm text-muted">Confirm purchase</p>
                <div className="mt-1 flex flex-wrap items-baseline justify-between gap-x-4">
                  <p className="text-lg font-medium">
                    {view.pending.product}, {view.pending.value} {view.pending.currency}
                  </p>
                  <p className="text-4xl font-semibold tabular-nums tracking-tight">{usd(view.pending.priceUsd)}</p>
                </div>
                <p className="mt-1 text-sm text-muted">Paid in USDC on Base. Say “yes” or use the buttons.</p>
                <div className="mt-4 flex gap-3">
                  <button
                    onClick={() => submit("yes")}
                    className="rounded-lg bg-mint px-5 py-2.5 font-medium text-white hover:brightness-110 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-mint"
                  >
                    Yes, buy it
                  </button>
                  <button
                    onClick={() => submit("no")}
                    className="rounded-lg px-5 py-2.5 font-medium ring-1 ring-line hover:bg-mist focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cobalt"
                  >
                    No
                  </button>
                </div>
              </div>
            </section>
          )}

          {error && <p role="alert" className="mt-4 text-sm text-amber">{error}</p>}
          {voiceOff && !error && <p className="mt-4 text-sm text-muted">Voice replies are unavailable, so replies show as text only.</p>}
          {replyBlocked && (
            <button
              onClick={() => audio.current?.play().then(() => setReplyBlocked(false), () => {})}
              className="mt-4 self-start rounded-lg px-4 py-2 text-sm font-medium text-cobalt ring-1 ring-line hover:bg-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cobalt"
            >
              Play reply
            </button>
          )}

          <form
            className="sticky bottom-0 mt-4 flex items-center gap-3 bg-mist py-4"
            onSubmit={e => {
              e.preventDefault();
              submit(draft);
            }}
          >
            <button
              type="button"
              onClick={live ? stopConversation : startConversation}
              aria-pressed={live}
              aria-label={live ? "Stop conversation" : "Start talking"}
              className={`grid size-14 shrink-0 place-items-center rounded-full text-white transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cobalt ${
                !live ? "bg-cobalt hover:brightness-110" : hearing ? "bg-amber motion-safe:animate-pulse" : "bg-mint"
              }`}
            >
              {live ? (
                <svg viewBox="0 0 24 24" className="size-5" fill="currentColor" aria-hidden><rect x="6" y="6" width="12" height="12" rx="2" /></svg>
              ) : (
                <svg viewBox="0 0 24 24" className="size-6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
                  <rect x="9" y="3" width="6" height="12" rx="3" />
                  <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
                </svg>
              )}
            </button>
            <label className="sr-only" htmlFor="draft">Type a request</label>
            <input
              id="draft"
              value={draft}
              onChange={e => setDraft(e.target.value)}
              disabled={busy}
              placeholder="Or type here"
              className="min-w-0 flex-1 rounded-lg bg-surface px-4 py-3 ring-1 ring-line placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-cobalt disabled:opacity-60"
            />
            <button
              type="submit"
              disabled={busy || !draft.trim()}
              className="rounded-lg px-4 py-3 font-medium ring-1 ring-line hover:bg-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cobalt disabled:opacity-40"
            >
              Send
            </button>
          </form>
        </main>

        <aside aria-label="Orders" className="md:border-l md:border-line md:pl-6">
          <h2 className="font-semibold">Orders</h2>
          {!view?.payments.length ? (
            <p className="mt-2 text-sm text-muted">Each purchase appears here with its on-chain payment receipt.</p>
          ) : (
            <ul className="mt-3 space-y-5">
              {[...view.payments].reverse().map(p => (
                <Order key={p.invoiceId} p={p} />
              ))}
            </ul>
          )}
          <Contacts />
        </aside>
      </div>
    </div>
  );
}

function Contacts() {
  const [list, setList] = useState<Contact[]>([]);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [err, setErr] = useState("");

  useEffect(() => {
    fetch("/api/contacts").then(r => r.json()).then(j => setList(j.contacts ?? [])).catch(() => {});
  }, []);

  async function save(method: "POST" | "DELETE", body: object) {
    setErr("");
    const r = await fetch("/api/contacts", { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const j = await r.json();
    if (!r.ok) return setErr(j.error ?? "Couldn't save the contact.");
    setList(j.contacts);
    if (method === "POST") {
      setName("");
      setEmail("");
    }
  }

  const field =
    "w-full rounded-lg bg-surface px-3 py-2 text-sm ring-1 ring-line placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-cobalt";
  return (
    <section className="mt-10" aria-labelledby="contacts-h">
      <h2 id="contacts-h" className="font-semibold">Contacts</h2>
      <p className="mt-1 text-sm text-muted">Say “send Alex a $5 Starbucks card” and it emails Alex here.</p>
      {list.length > 0 && (
        <ul className="mt-3 space-y-2">
          {list.map(c => (
            <li key={c.name} className="flex items-baseline justify-between gap-2 text-sm">
              <span className="min-w-0">
                <span className="font-medium">{c.name}</span>
                <span className="block truncate text-muted">{c.email}</span>
              </span>
              <button
                onClick={() => save("DELETE", { name: c.name })}
                aria-label={`Remove ${c.name}`}
                className="shrink-0 rounded px-1.5 text-muted hover:text-ink focus-visible:outline-2 focus-visible:outline-cobalt"
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      <form
        className="mt-3 space-y-2"
        onSubmit={e => {
          e.preventDefault();
          save("POST", { name, email });
        }}
      >
        <label className="sr-only" htmlFor="c-name">Name</label>
        <input id="c-name" value={name} onChange={e => setName(e.target.value)} placeholder="Name" className={field} />
        <label className="sr-only" htmlFor="c-email">Email</label>
        <input id="c-email" type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="Email" className={field} />
        <button
          type="submit"
          disabled={!name.trim() || !email.trim()}
          className="w-full rounded-lg py-2 text-sm font-medium ring-1 ring-line hover:bg-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cobalt disabled:opacity-40"
        >
          Add contact
        </button>
        {err && <p role="alert" className="text-sm text-amber">{err}</p>}
      </form>
    </section>
  );
}

const STATUS: Record<string, string> = {
  all_delivered: "Delivered",
  not_delivered: "Processing",
  dry_run: "Test only, not paid",
};

function Order({ p }: { p: Payment }) {
  const delivered = p.status === "all_delivered";
  return (
    <li className="text-sm">
      <div className="flex items-baseline justify-between gap-3">
        <span className="font-medium">{p.product}</span>
        <span className="tabular-nums">{usd(p.amountUsd)}</span>
      </div>
      <p className={delivered ? "text-mint" : p.status === "dry_run" ? "text-amber" : "text-muted"}>
        {STATUS[p.status ?? ""] ?? p.status ?? "Paid, checking delivery"}
      </p>
      {p.sentTo && <p className="text-muted">Emailed to {p.sentTo}</p>}
      {(p.redemption as any[] | undefined)?.map((r, i) => (
        <div key={i} className="mt-1">
          {r.link && (
            <a href={r.link} target="_blank" rel="noreferrer" className="text-cobalt underline underline-offset-2">
              Open gift card
            </a>
          )}
          {r.code && <p className="font-medium tabular-nums">Code: {r.code}</p>}
          {r.pin && <p className="tabular-nums">PIN: {r.pin}</p>}
        </div>
      ))}
      {p.basescan && (
        <a href={p.basescan} target="_blank" rel="noreferrer" className="mt-1 block text-muted underline underline-offset-2 hover:text-ink">
          Payment on Basescan
        </a>
      )}
    </li>
  );
}
