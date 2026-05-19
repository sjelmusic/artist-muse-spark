import { corsHeaders } from 'npm:@supabase/supabase-js@2/cors'
import { createClient } from 'npm:@supabase/supabase-js@2'

const GATEWAY = 'https://connector-gateway.lovable.dev/google_sheets/v4'
const DRIVE_GATEWAY = 'https://connector-gateway.lovable.dev/google_sheets'

function gwHeaders() {
  const lovable = Deno.env.get('LOVABLE_API_KEY')
  const key = Deno.env.get('GOOGLE_SHEETS_API_KEY')
  if (!lovable) throw new Error('LOVABLE_API_KEY missing')
  if (!key) throw new Error('GOOGLE_SHEETS_API_KEY missing')
  return {
    'Authorization': `Bearer ${lovable}`,
    'X-Connection-Api-Key': key,
    'Content-Type': 'application/json',
  }
}

async function gwFetch(url: string, init: RequestInit = {}) {
  const res = await fetch(url, {
    ...init,
    headers: { ...gwHeaders(), ...(init.headers || {}) },
  })
  const text = await res.text()
  let data: any = null
  try { data = text ? JSON.parse(text) : null } catch { data = text }
  if (!res.ok) {
    throw new Error(`Sheets gateway ${res.status}: ${typeof data === 'string' ? data : JSON.stringify(data)}`)
  }
  return data
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    )

    // 1. Find or create the spreadsheet
    const { data: settingRow } = await supabase
      .from('app_settings')
      .select('value')
      .eq('key', 'google_sheet')
      .maybeSingle()

    let spreadsheetId: string | null = (settingRow?.value as any)?.spreadsheet_id ?? null
    let spreadsheetUrl: string | null = (settingRow?.value as any)?.url ?? null
    let created = false

    if (!spreadsheetId) {
      const sheet = await gwFetch(`${GATEWAY}/spreadsheets`, {
        method: 'POST',
        body: JSON.stringify({
          properties: { title: 'Aesthetic Engine — Image Library' },
          sheets: [{ properties: { title: 'Images' } }],
        }),
      })
      spreadsheetId = sheet.spreadsheetId
      spreadsheetUrl = sheet.spreadsheetUrl
      created = true
      await supabase.from('app_settings').upsert({
        key: 'google_sheet',
        value: { spreadsheet_id: spreadsheetId, url: spreadsheetUrl },
        updated_at: new Date().toISOString(),
      })
    }

    // 2. Pull everything from DB
    const [{ data: artists }, { data: images }] = await Promise.all([
      supabase.from('artists').select('id,name,reference_image_id,songs,status,created_at'),
      supabase.from('generated_images').select('id,artist_id,storage_path,kind,song,is_reference,status,created_at').order('created_at', { ascending: true }),
    ])

    const artistMap = new Map((artists ?? []).map((a: any) => [a.id, a]))
    const supaUrl = Deno.env.get('SUPABASE_URL')!
    const publicUrl = (path: string) =>
      `${supaUrl}/storage/v1/object/public/artist-images/${path}`

    const header = ['artist', 'image_link', 'status', 'kind', 'song', 'created_at', 'image_id']
    const rows: any[][] = [header]
    for (const img of images ?? []) {
      const artist = artistMap.get(img.artist_id) as any
      if (!artist) continue
      let status = img.status ?? 'new'
      if (artist.reference_image_id === img.id) status = 'reference'
      else if (img.is_reference && status === 'new') status = 'uploaded-reference'
      rows.push([
        artist.name,
        publicUrl(img.storage_path),
        status,
        img.kind ?? '',
        img.song ?? '',
        img.created_at,
        img.id,
      ])
    }

    // 3. Clear + rewrite
    await gwFetch(`${GATEWAY}/spreadsheets/${spreadsheetId}/values/Images!A1:Z200000:clear`, {
      method: 'POST',
      body: '{}',
    })
    await gwFetch(
      `${GATEWAY}/spreadsheets/${spreadsheetId}/values/Images!A1?valueInputOption=RAW`,
      { method: 'PUT', body: JSON.stringify({ values: rows }) },
    )

    return new Response(
      JSON.stringify({
        ok: true,
        created,
        spreadsheet_id: spreadsheetId,
        url: spreadsheetUrl,
        rows: rows.length - 1,
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    )
  } catch (e: any) {
    console.error('sheet-sync error', e)
    return new Response(JSON.stringify({ ok: false, error: e?.message ?? String(e) }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})