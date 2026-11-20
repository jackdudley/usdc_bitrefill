/** Text to speech: { text } -> ElevenLabs -> mp3 stream. */
export const runtime = "nodejs";

const VOICE = process.env.ELEVENLABS_VOICE_ID || "JBFqnCBsd6RMkjVDRZzb"; // premade "George"

export async function POST(req: Request) {
  const { text } = await req.json().catch(() => ({}));
  if (typeof text !== "string" || !text.trim()) return Response.json({ error: "Nothing to say." }, { status: 400 });

  const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${VOICE}?output_format=mp3_44100_128`, {
    method: "POST",
    headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY ?? "", "Content-Type": "application/json" },
    body: JSON.stringify({ text: text.slice(0, 1000), model_id: "eleven_flash_v2_5" }),
  });
  if (!r.ok || !r.body) {
    console.error("tts failed:", r.status, (await r.text()).slice(0, 300));
    return Response.json({ error: `Text-to-speech failed (${r.status}).` }, { status: 502 });
  }
  return new Response(r.body, { headers: { "Content-Type": "audio/mpeg" } });
}
