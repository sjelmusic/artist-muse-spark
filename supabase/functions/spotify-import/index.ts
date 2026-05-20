import { createClient } from "npm:@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SPOTIFY_CLIENT_ID = Deno.env.get("SPOTIFY_CLIENT_ID")!;
const SPOTIFY_CLIENT_SECRET = Deno.env.get("SPOTIFY_CLIENT_SECRET")!;

const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

// Parse a Spotify artist ID from a URL, URI, or raw ID.
function parseArtistId(input: string): string | null {
  const s = input.trim();
  if (!s) return null;
  // open.spotify.com/artist/{id} or with locale prefix
  const urlMatch = s.match(/artist\/([A-Za-z0-9]{22})/);
  if (urlMatch) return urlMatch[1];
  // spotify:artist:{id}
  const uriMatch = s.match(/spotify:artist:([A-Za-z0-9]{22})/);
  if (uriMatch) return uriMatch[1];
  // raw 22-char id
  if (/^[A-Za-z0-9]{22}$/.test(s)) return s;
  return null;
}

let cachedToken: { value: string; expiresAt: number } | null = null;
async function getSpotifyToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 30_000) return cachedToken.value;
  const basic = btoa(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`);
  const resp = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  if (!resp.ok) throw new Error(`Spotify auth failed: ${resp.status} ${await resp.text()}`);
  const data = await resp.json();
  cachedToken = {
    value: data.access_token,
    expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
  };
  return cachedToken.value;
}

async function spotifyGet(path: string, token: string) {
  const resp = await fetch(`https://api.spotify.com/v1${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!resp.ok) throw new Error(`Spotify ${path} failed: ${resp.status} ${await resp.text()}`);
  return resp.json();
}

async function importOne(input: string) {
  const artistId = parseArtistId(input);
  if (!artistId) throw new Error(`couldn't parse a spotify artist id from "${input}"`);

  const token = await getSpotifyToken();
  const artist = await spotifyGet(`/artists/${artistId}`, token);
  const name: string = artist.name;
  const image = (artist.images || []).sort((a: any, b: any) => (b.width || 0) - (a.width || 0))[0];
  if (!image?.url) throw new Error(`spotify has no image for ${name}`);

  // Top tracks (US market)
  let topTracks: string[] = [];
  try {
    const tt = await spotifyGet(`/artists/${artistId}/top-tracks?market=US`, token);
    topTracks = (tt.tracks || []).slice(0, 5).map((t: any) => t.name).filter(Boolean);
  } catch (_) {
    // non-fatal
  }

  // 1. Create artist row
  const { data: created, error: aErr } = await supabase
    .from("artists")
    .insert({ name, songs: topTracks, status: "headshots_ready" })
    .select()
    .single();
  if (aErr || !created) throw aErr || new Error("couldn't create artist row");

  // 2. Download spotify image
  const imgResp = await fetch(image.url);
  if (!imgResp.ok) throw new Error(`failed to download spotify image (${imgResp.status})`);
  const contentType = imgResp.headers.get("content-type") || "image/jpeg";
  const ext = contentType.includes("png") ? "png" : "jpg";
  const bytes = new Uint8Array(await imgResp.arrayBuffer());
  const storagePath = `${created.id}/spotify-headshot-${Date.now()}.${ext}`;
  const { error: upErr } = await supabase.storage
    .from("artist-images")
    .upload(storagePath, bytes, { contentType, upsert: false });
  if (upErr) throw upErr;

  // 3. Insert as reference headshot
  const { data: img, error: iErr } = await supabase
    .from("generated_images")
    .insert({
      artist_id: created.id,
      storage_path: storagePath,
      kind: "headshot",
      prompt: `spotify reference for ${name}`,
      is_reference: true,
    })
    .select()
    .single();
  if (iErr || !img) throw iErr || new Error("couldn't save image row");

  return { artistId: created.id, name, referenceImageId: img.id, songs: topTracks };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  try {
    if (!SPOTIFY_CLIENT_ID || !SPOTIFY_CLIENT_SECRET) {
      throw new Error("Spotify credentials not configured");
    }
    const body = await req.json();
    const inputs: unknown = body?.inputs;
    if (!Array.isArray(inputs) || !inputs.length) {
      return new Response(JSON.stringify({ error: "inputs[] required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Process sequentially to be polite to Spotify + storage
    const results: Array<
      | { ok: true; input: string; artistId: string; name: string; referenceImageId: string }
      | { ok: false; input: string; error: string }
    > = [];
    for (const raw of inputs) {
      const input = String(raw);
      try {
        const r = await importOne(input);
        results.push({ ok: true, input, artistId: r.artistId, name: r.name, referenceImageId: r.referenceImageId });
      } catch (e) {
        results.push({ ok: false, input, error: e instanceof Error ? e.message : String(e) });
      }
    }

    return new Response(JSON.stringify({ results }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
