/** Speech to text: browser audio -> ElevenLabs Scribe -> { text }. */
export const runtime = "nodejs";

export async function POST(req: Request) {
  const file = (await req.formData().catch(() => null))?.get("file");
  if (!(file instanceof Blob) || file.size === 0 || file.size > 10_000_000)
    return Response.json({ error: "No audio received. Try again or type instead." }, { status: 400 });

  const fd = new FormData();
  fd.append("model_id", "scribe_v1");
  fd.append("file", file, "speech.webm");
  const r = await fetch("https://api.elevenlabs.io/v1/speech-to-text", {
    method: "POST",
    headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY ?? "" },
    body: fd,
  });
  if (!r.ok) {
    console.error("stt failed:", r.status, (await r.text()).slice(0, 300));
    return Response.json({ error: `Speech-to-text failed (${r.status}). Type your request instead.` }, { status: 502 });
  }
  const { text } = await r.json();
  return Response.json({ text: typeof text === "string" ? text : "" });
}
