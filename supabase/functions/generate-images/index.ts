import { createClient } from "npm:@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const MODEL = "google/gemini-3.1-flash-image-preview";
const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

async function callAIOnce(content: any) {
  const resp = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${LOVABLE_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: "user", content }],
      modalities: ["image", "text"],
    }),
  });
  if (!resp.ok) {
    const text = await resp.text();
    if (resp.status === 429) throw new Error("RATE_LIMIT");
    if (resp.status === 402) throw new Error("PAYMENT_REQUIRED");
    throw new Error(`AI error ${resp.status}: ${text}`);
  }
  const data = await resp.json();
  const url = data.choices?.[0]?.message?.images?.[0]?.image_url?.url;
  if (!url) throw new Error("No image returned");
  return url;
}

async function callAI(content: any, attempts = 3): Promise<string> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await callAIOnce(content);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg === "RATE_LIMIT" || msg === "PAYMENT_REQUIRED") throw e;
      lastErr = e;
      await new Promise((r) => setTimeout(r, 800 * (i + 1)));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("AI failed");
}

function dataUrlToBytes(dataUrl: string): { bytes: Uint8Array; mime: string } {
  const m = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!m) throw new Error("Invalid data URL");
  const mime = m[1];
  const b64 = m[2];
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return { bytes, mime };
}

async function uploadImage(artistId: string, dataUrl: string, label: string) {
  const { bytes, mime } = dataUrlToBytes(dataUrl);
  const ext = mime.split("/")[1] || "png";
  const path = `${artistId}/${label}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}.${ext}`;
  const { error } = await supabase.storage.from("artist-images").upload(path, bytes, {
    contentType: mime,
    upsert: false,
  });
  if (error) throw error;
  return path;
}

async function fetchAsDataUrl(publicUrl: string): Promise<string> {
  const r = await fetch(publicUrl);
  const buf = new Uint8Array(await r.arrayBuffer());
  const mime = r.headers.get("content-type") || "image/png";
  let binary = "";
  for (let i = 0; i < buf.length; i++) binary += String.fromCharCode(buf[i]);
  return `data:${mime};base64,${btoa(binary)}`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const body = await req.json();
    const { mode, artistId } = body;

    if (!artistId || !mode) {
      return new Response(JSON.stringify({ error: "Missing artistId or mode" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: artist, error: aErr } = await supabase
      .from("artists")
      .select("*")
      .eq("id", artistId)
      .single();
    if (aErr || !artist) throw new Error("Artist not found");

    // Variation pools — flash lighting always stays
    const colors = ["warm red", "icy blue", "acid green", "buttery yellow", "dusty pink", "deep violet", "burnt orange", "cool grey", "cream", "electric teal"];
    const motions = ["subtle movement", "completely still", "mid-step motion", "hair caught in motion", "frozen pose", "slight sway", "no movement at all"];
    const temps = ["warm tones", "cool tones", "neutral tones", "high contrast", "soft warm haze", "crisp cold air"];
    const times = ["golden hour", "midday", "blue hour", "late night", "early morning", "overcast afternoon", "dusk"];
    const locations = ["empty hallway", "concrete stairwell", "white studio", "tiled bathroom", "parking garage", "rooftop", "kitchen corner", "hotel lobby", "back alley", "bedroom with sheer curtains", "elevator", "diner booth"];
    const pick = <T,>(arr: T[], i: number) => arr[(i + Math.floor(Math.random() * arr.length)) % arr.length];

    if (mode === "headshots") {
      const basePrompt = (i: number) =>
        `you are creating a real flash image for a cool gen-z person called ${artist.name}. always shot with direct flash lighting. SQUARE 1:1 aspect ratio composition. very real, very cool, minimal artsy aesthetic, not cluttered. setting: ${pick(locations, i)}. dominant color accent: ${pick(colors, i)}. ${pick(motions, i)}. ${pick(temps, i)}. ${pick(times, i)}.`;
      const job = (async () => {
        const tasks = Array.from({ length: 4 }, (_, i) =>
          (async () => {
            const prompt = basePrompt(i);
            const dataUrl = await callAI(prompt);
            const path = await uploadImage(artistId, dataUrl, `headshot-${i + 1}`);
            const { error: iErr } = await supabase
              .from("generated_images")
              .insert({ artist_id: artistId, storage_path: path, kind: "headshot", prompt });
            if (iErr) throw iErr;
          })()
        );
        const results = await Promise.allSettled(tasks);
        const failed = results.filter((r) => r.status === "rejected").length;
        if (failed) console.error(`Headshots: ${failed} failed`);
        await supabase.from("artists").update({ status: "headshots_ready" }).eq("id", artistId);
      })();
      // @ts-ignore EdgeRuntime is provided by Deno deploy
      EdgeRuntime.waitUntil(job);
      return new Response(JSON.stringify({ accepted: true }), {
        status: 202,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (mode === "variants") {
      const { referenceImageId } = body;
      if (!referenceImageId) throw new Error("Missing referenceImageId");

      const { data: refImg, error: rErr } = await supabase
        .from("generated_images")
        .select("*")
        .eq("id", referenceImageId)
        .single();
      if (rErr || !refImg) throw new Error("Reference image not found");

      // Mark reference + update artist
      await supabase
        .from("generated_images")
        .update({ is_reference: true })
        .eq("id", referenceImageId);
      await supabase
        .from("artists")
        .update({ reference_image_id: referenceImageId, status: "reference_chosen" })
        .eq("id", artistId);

      const { data: pub } = supabase.storage
        .from("artist-images")
        .getPublicUrl(refImg.storage_path);
      const refDataUrl = await fetchAsDataUrl(pub.publicUrl);

      const songs: string[] = artist.songs || [];
      const job = (async () => {
        const variantTasks = Array.from({ length: 6 }, (_, i) =>
          (async () => {
            const song = songs.length ? songs[i % songs.length] : null;
            const songLine = song
              ? ` Setting and mood inspired by the vibe of the song "${song}".`
              : "";
            const prompt = `you are creating a real flash image for this person in reference pic. always shot with direct flash lighting. SQUARE 1:1 aspect ratio composition. very real, very cool. exactly the same person, but different setting, different pose, different outfit. setting: ${pick(locations, i)}. dominant color accent: ${pick(colors, i)}. ${pick(motions, i)}. ${pick(temps, i)}. ${pick(times, i)}.${songLine}`;
            const dataUrl = await callAI([
              { type: "text", text: prompt },
              { type: "image_url", image_url: { url: refDataUrl } },
            ]);
            const path = await uploadImage(artistId, dataUrl, `variant-${i + 1}`);
            const { error: iErr } = await supabase
              .from("generated_images")
              .insert({
                artist_id: artistId,
                storage_path: path,
                kind: "variant",
                song,
                prompt,
              });
            if (iErr) throw iErr;
          })()
        );
        const vResults = await Promise.allSettled(variantTasks);
        const failed = vResults.filter((r) => r.status === "rejected").length;
        if (failed) console.error(`Variants: ${failed} failed`);
        await supabase.from("artists").update({ status: "variants_ready" }).eq("id", artistId);
      })();
      // @ts-ignore EdgeRuntime is provided by Deno deploy
      EdgeRuntime.waitUntil(job);
      return new Response(JSON.stringify({ accepted: true }), {
        status: 202,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (mode === "extra") {
      const flavor: "wild" | "cinematic" | "aesthetic" | "plain" =
        body.flavor === "wild" ||
        body.flavor === "cinematic" ||
        body.flavor === "aesthetic" ||
        body.flavor === "plain"
          ? body.flavor
          : "cinematic";

      const refId = artist.reference_image_id;
      if (!refId) throw new Error("No reference image chosen yet");

      const { data: refImg, error: rErr } = await supabase
        .from("generated_images")
        .select("*")
        .eq("id", refId)
        .single();
      if (rErr || !refImg) throw new Error("Reference image not found");

      const { data: pub } = supabase.storage
        .from("artist-images")
        .getPublicUrl(refImg.storage_path);
      const refDataUrl = await fetchAsDataUrl(pub.publicUrl);

      // ---- WILD ----
      const wildLocations = [
        "neon-lit laundromat at 3am", "carwash with foam everywhere", "abandoned amusement park", "claw machine arcade", "behind a fast-food drive-thru", "in a kiddie pool full of jello", "inflatable bouncy castle", "convenience store fridge aisle", "petting zoo with a goat", "horse stable", "field with cows in the background", "parking lot full of seagulls", "a giant pile of stuffed animals", "covered in glitter in a bathtub", "wrapped in caution tape", "surrounded by balloons", "rooftop with pigeons taking off", "in a phone booth full of receipts", "dog park with golden retrievers running by",
      ];
      const wildMoods = [
        "y2k chaos", "deranged but cute", "screaming-laughing energy", "weird candid moment", "with a parrot on shoulder", "holding a tiny dog", "playing with a cat", "covered in confetti", "blowing bubblegum", "sticking tongue out", "weirdly proud pose", "off-balance falling motion", "frozen mid-jump", "looking shocked at the camera",
      ];
      const wildIntensities = ["maximalist chaos", "feral but fashion", "ironic and over-the-top", "playful absurd", "campy and loud", "tabloid paparazzi feel", "viral meme energy"];

      // ---- CINEMATIC ----
      const cinematicLocations = [
        "empty motel room with one lamp on", "long hotel corridor with patterned carpet", "rain-soaked city street at night", "vintage car interior at night", "diner booth at 2am", "stairwell with dramatic shadows", "passenger seat of a car, headlights passing", "neon-lit underpass", "smoky bar with red lighting", "elevator with flickering light", "wet asphalt with reflected signs", "phone booth at night", "balcony overlooking city lights", "warm wood-paneled room with a single window",
      ];
      const cinematicMoods = [
        "shallow depth of field, cinematic medium shot", "shot on 35mm film feel", "subject looking off-camera, contemplative", "candid in-between moment", "back to camera, head turned slightly", "leaning against a wall, smoking", "seated, relaxed posture", "wind in hair, calm expression", "lit cigarette as quiet prop", "rain on skin",
      ];
      const cinematicIntensities = ["moody and intimate", "romantic melancholy", "quiet confidence", "noir-tinted", "cinematic stillness", "warm nostalgic", "slow-burn drama"];

      // ---- AESTHETIC ---- (person very far, very close, or even absent)
      const aestheticLocations = [
        "tiny silhouette at end of long empty hallway", "lone figure walking across vast empty parking lot", "small figure in middle of huge empty field", "person dwarfed by a giant concrete wall", "extreme close-up of just the eye", "extreme close-up of hands holding a flower", "macro of skin texture and a single earring", "back of the head only, hair detail", "just shoes on a tiled floor", "STILL LIFE: an empty chair, a coat draped over it (no person)", "STILL LIFE: a half-drunk glass of wine on a windowsill (no person)", "STILL LIFE: rumpled bed with morning light, no person", "STILL LIFE: open window with curtain blowing, no person", "wide aerial-feel shot, person tiny in the corner", "person reflected small in a huge mirror across the room", "shot through a doorway, person far away in the next room",
      ];
      const aestheticMoods = [
        "extreme wide shot, brutal negative space", "extreme macro close-up", "object-focused still life, no figure", "minimal composition, rule of thirds", "architectural symmetry, person as accent", "tight crop on a single detail", "shot from very far away with a long lens feel",
      ];
      const aestheticIntensities = ["minimalist and refined", "lonely and beautiful", "editorial fine-art", "gallery-worthy quiet", "fashion campaign minimalism", "negative-space heavy"];

      const flavorConfig = {
        wild: {
          locations: wildLocations,
          moods: wildMoods,
          intensities: wildIntensities,
          directive:
            "make it WILD and PLAYFUL: chaotic, fun, slightly absurd. animals, props, weird settings welcome. still cool, still flash-photo real. different outfit, different pose.",
        },
        cinematic: {
          locations: cinematicLocations,
          moods: cinematicMoods,
          intensities: cinematicIntensities,
          directive:
            "make it CINEMATIC: feels like a still from an indie movie. moody, intentional, beautifully composed. different outfit, different pose.",
        },
        aesthetic: {
          locations: aestheticLocations,
          moods: aestheticMoods,
          intensities: aestheticIntensities,
          directive:
            "make it AESTHETIC and minimal: the person is either VERY FAR away (tiny in the frame, lots of negative space), or in EXTREME CLOSE-UP (a hand, an eye, a detail), or NOT VISIBLE AT ALL (a still-life of an object/scene that represents them). gallery-worthy, fine-art editorial.",
        },
      } as const;
      const cfg = flavorConfig[flavor];

      const songs: string[] = artist.songs || [];
      const job = (async () => {
        const tasks = Array.from({ length: 10 }, (_, i) =>
          (async () => {
            const song = songs.length ? songs[i % songs.length] : null;
            const songLine = song ? ` Loose vibe inspired by the song "${song}".` : "";
            const prompt = `you are creating a real flash image inspired by this person in reference pic. always shot with direct flash lighting. SQUARE 1:1 aspect ratio composition. when the person is visible, keep the face identical to the reference. ${cfg.directive} setting: ${pick(cfg.locations, i)}. dominant color accent: ${pick(colors, i)}. ${pick(cfg.moods, i)}. ${pick(temps, i)}. ${pick(times, i)}. overall mood: ${pick(cfg.intensities, i)}.${songLine}`;
            const dataUrl = await callAI([
              { type: "text", text: prompt },
              { type: "image_url", image_url: { url: refDataUrl } },
            ]);
            const path = await uploadImage(artistId, dataUrl, `${flavor}-${i + 1}`);
            const { error: iErr } = await supabase
              .from("generated_images")
              .insert({
                artist_id: artistId,
                storage_path: path,
                kind: "variant",
                song,
                prompt,
              });
            if (iErr) throw iErr;
          })()
        );
        const results = await Promise.allSettled(tasks);
        const failed = results.filter((r) => r.status === "rejected").length;
        if (failed) console.error(`Extra (${flavor}): ${failed} failed`);
      })();
      // @ts-ignore EdgeRuntime is provided by Deno deploy
      EdgeRuntime.waitUntil(job);
      return new Response(JSON.stringify({ accepted: true }), {
        status: 202,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ error: "Unknown mode" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    console.error("generate-images error:", msg);
    const status =
      msg === "RATE_LIMIT" ? 429 : msg === "PAYMENT_REQUIRED" ? 402 : 500;
    return new Response(JSON.stringify({ error: msg }), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});