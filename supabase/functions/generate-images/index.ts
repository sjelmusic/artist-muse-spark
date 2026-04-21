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

async function callAI(content: any) {
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
  return url; // data:image/png;base64,...
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

    if (mode === "headshots") {
      // Generate 4 headshots
      const prompt = `you are creating a real flash image in minimal environment for a cool gen-z person called ${artist.name}. Very real very cool very minimal artsy aesthetic. not cluttered. movement`;
      const created: any[] = [];
      for (let i = 0; i < 4; i++) {
        const dataUrl = await callAI(prompt);
        const path = await uploadImage(artistId, dataUrl, `headshot-${i + 1}`);
        const { data: img, error: iErr } = await supabase
          .from("generated_images")
          .insert({ artist_id: artistId, storage_path: path, kind: "headshot", prompt })
          .select()
          .single();
        if (iErr) throw iErr;
        created.push(img);
      }
      await supabase.from("artists").update({ status: "headshots_ready" }).eq("id", artistId);
      return new Response(JSON.stringify({ images: created }), {
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
      const created: any[] = [];
      // 6 variant images, cycling through songs for inspiration
      for (let i = 0; i < 6; i++) {
        const song = songs.length ? songs[i % songs.length] : null;
        const songLine = song
          ? ` Setting and mood inspired by the vibe of the song "${song}".`
          : "";
        const prompt = `you are creating a real flash image in minimal environment for this person in reference pic. Very real, very cool. different setting, different pose & outfit but exactly the same person.${songLine}`;

        const dataUrl = await callAI([
          { type: "text", text: prompt },
          { type: "image_url", image_url: { url: refDataUrl } },
        ]);
        const path = await uploadImage(artistId, dataUrl, `variant-${i + 1}`);
        const { data: img, error: iErr } = await supabase
          .from("generated_images")
          .insert({
            artist_id: artistId,
            storage_path: path,
            kind: "variant",
            song,
            prompt,
          })
          .select()
          .single();
        if (iErr) throw iErr;
        created.push(img);
      }
      await supabase.from("artists").update({ status: "variants_ready" }).eq("id", artistId);
      return new Response(JSON.stringify({ images: created }), {
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