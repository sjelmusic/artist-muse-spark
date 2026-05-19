import { useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { BulkInputForm } from "@/components/BulkInputForm";
import { ArtistCard, resizeToSquare } from "@/components/ArtistCard";
import { Button } from "@/components/ui/button";
import { Check, Download, Heart, HelpCircle, Pencil, Plus, Sheet, Trash2, Wand2, X } from "lucide-react";
import { toast } from "sonner";
import { fetchImageBlob } from "@/lib/storage";
import JSZip from "jszip";
import { saveAs } from "file-saver";

type Artist = {
  id: string;
  name: string;
  songs: string[];
  status: string;
  reference_image_id: string | null;
  created_at: string;
};

const Index = () => {
  const [artists, setArtists] = useState<Artist[]>([]);
  const [zipping, setZipping] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [sheetUrl, setSheetUrl] = useState<string | null>(null);
  const syncTimer = useRef<number | null>(null);

  const runSync = async (opts: { silent?: boolean } = {}) => {
    setSyncing(true);
    try {
      const { data, error } = await supabase.functions.invoke("sheet-sync");
      if (error) throw error;
      if (data?.url) setSheetUrl(data.url);
      if (!opts.silent) {
        if (data?.created) toast.success("created a fresh google sheet for you");
        else toast.success(`synced ${data?.rows ?? 0} rows to your sheet`);
      }
    } catch (e: any) {
      if (!opts.silent) toast.error(e.message || "sheet sync failed");
      console.error("sheet-sync", e);
    } finally {
      setSyncing(false);
    }
  };

  const scheduleSync = () => {
    if (syncTimer.current) window.clearTimeout(syncTimer.current);
    syncTimer.current = window.setTimeout(() => runSync({ silent: true }), 2500);
  };

  const load = async () => {
    const { data } = await supabase
      .from("artists")
      .select("*")
      .order("created_at", { ascending: false });
    setArtists((data as Artist[]) || []);
  };

  useEffect(() => {
    load();
    // load saved sheet url
    supabase
      .from("app_settings")
      .select("value")
      .eq("key", "google_sheet")
      .maybeSingle()
      .then(({ data }) => {
        const url = (data?.value as any)?.url;
        if (url) setSheetUrl(url);
      });
    const ch = supabase
      .channel("artists-list")
      .on("postgres_changes", { event: "*", schema: "public", table: "artists" }, () => {
        load();
        scheduleSync();
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "generated_images" }, () => {
        scheduleSync();
      })
      .subscribe();
    return () => {
      supabase.removeChannel(ch);
      if (syncTimer.current) window.clearTimeout(syncTimer.current);
    };
  }, []);

  const downloadAllArtists = async () => {
    setZipping(true);
    try {
      const { data: imgs } = await supabase
        .from("generated_images")
        .select("*");
      if (!imgs?.length) {
        toast.error("nothing to export yet");
        return;
      }
      toast.info("resizing every approved image to 3000×3000…");
      const zip = new JSZip();
      let total = 0;
      let skipped = 0;

      type Job = { artistName: string; img: any };
      const jobs: Job[] = [];
      for (const a of artists) {
        const mine = imgs.filter((i) => i.artist_id === a.id);
        const chosen = mine.find((i) => i.id === a.reference_image_id);
        const exportable = [
          ...(chosen ? [chosen] : []),
          ...mine.filter((i) => i.kind === "variant"),
        ];
        for (const img of exportable) jobs.push({ artistName: a.name, img });
      }

      // Process in parallel chunks to avoid melting the browser on huge lineups
      const CHUNK = 8;
      const processed: { artistName: string; resized: Blob | null }[] = [];
      for (let i = 0; i < jobs.length; i += CHUNK) {
        const slice = jobs.slice(i, i + CHUNK);
        const out = await Promise.all(
          slice.map(async (job) => {
            try {
              const blob = await fetchImageBlob(job.img.storage_path);
              const resized = await resizeToSquare(blob, 3000);
              return { artistName: job.artistName, resized };
            } catch (error) {
              console.error("Skipping export image", job.img.storage_path, error);
              return { artistName: job.artistName, resized: null };
            }
          })
        );
        processed.push(...out);
      }

      const counters = new Map<string, number>();
      for (const p of processed) {
        if (!p.resized) {
          skipped++;
          continue;
        }
        const safeName = p.artistName.replace(/[^a-z0-9]/gi, "_");
        const folder = zip.folder(safeName)!;
        const idx = (counters.get(safeName) ?? 0) + 1;
        counters.set(safeName, idx);
        folder.file(`${safeName}-${String(idx).padStart(2, "0")}.jpg`, p.resized);
        total++;
      }
      if (!total) {
        toast.error("no approved headshots or variants found");
        return;
      }
      const out = await zip.generateAsync({ type: "blob" });
      saveAs(out, `aesthetic-engine-lineup.zip`);
      toast.success(
        skipped
          ? `zipped ${total} images across the lineup · skipped ${skipped} bad files`
          : `zipped ${total} images across the lineup`
      );
    } catch (e: any) {
      toast.error(e.message || "zip failed");
    } finally {
      setZipping(false);
    }
  };

  return (
    <div className="min-h-screen bg-background grain">
      {/* Top bar */}
      <header className="border-b-2 border-foreground bg-background sticky top-0 z-20">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-end justify-between">
          <div>
            <div className="text-[10px] uppercase tracking-[0.3em] font-bold text-muted-foreground">
              issue 001 · spring '26
            </div>
            <h1 className="font-serif-display text-5xl md:text-6xl leading-none">
              aesthetic engine<span className="text-accent">.</span>
            </h1>
          </div>
          <button
            onClick={() => setShowHelp((s) => !s)}
            className="flex items-center gap-1.5 border-2 border-foreground px-3 py-1.5 text-[10px] uppercase tracking-widest font-bold hover:bg-foreground hover:text-background transition-colors"
          >
            <HelpCircle className="w-3.5 h-3.5" />
            {showHelp ? "hide" : "how it works"}
          </button>
        </div>
        {showHelp && (
          <div className="border-t-2 border-foreground bg-secondary">
            <div className="max-w-6xl mx-auto px-6 py-5 grid md:grid-cols-2 gap-x-10 gap-y-4 text-xs">
              <div>
                <h3 className="font-serif-display text-xl mb-2">the flow</h3>
                <ol className="space-y-1.5 text-muted-foreground leading-relaxed list-decimal list-inside">
                  <li>paste a lineup (or upload your own face) → 4 headshots get generated.</li>
                  <li>pick one as your reference → 6 styled variants are auto-generated.</li>
                  <li>add 10 more in any flavor: <b>wild</b>, <b>cinematic</b>, <b>aesthetic</b>, or <b>plain</b> (no person, just vibe).</li>
                  <li>like your favorites → they join the reference pool for future generations.</li>
                  <li>zip the lot at 3000×3000 when you're happy.</li>
                </ol>
              </div>
              <div>
                <h3 className="font-serif-display text-xl mb-2">icons</h3>
                <ul className="space-y-1.5 text-muted-foreground leading-relaxed">
                  <li className="flex items-center gap-2"><Wand2 className="w-3.5 h-3.5 shrink-0" /> <b>use this</b> — picks a headshot as the reference for variants.</li>
                  <li className="flex items-center gap-2"><Check className="w-3.5 h-3.5 shrink-0" /> the currently chosen reference.</li>
                  <li className="flex items-center gap-2"><Heart className="w-3.5 h-3.5 shrink-0" /> <b>like</b> — adds the image to the reference pool, randomly sampled in future prompts.</li>
                  <li className="flex items-center gap-2"><Download className="w-3.5 h-3.5 shrink-0" /> <b>download</b> — single image (per tile) or zip (per artist / whole lineup), all at 3000×3000.</li>
                  <li className="flex items-center gap-2"><Plus className="w-3.5 h-3.5 shrink-0" /> <b>+ 10 …</b> — generates 10 more variants in that flavor.</li>
                  <li className="flex items-center gap-2"><Pencil className="w-3.5 h-3.5 shrink-0" /> <b>keywords</b> — click them under the artist name to edit. randomly woven into prompts (sometimes 0, sometimes 1–3) to anchor the vibe.</li>
                  <li className="flex items-center gap-2"><X className="w-3.5 h-3.5 shrink-0" /> delete a single image · <Trash2 className="w-3.5 h-3.5 shrink-0 ml-1" /> delete the whole artist.</li>
                </ul>
              </div>
            </div>
          </div>
        )}
      </header>

      <main className="max-w-6xl mx-auto px-6 py-10 space-y-10">
        <BulkInputForm onCreated={load} />

        <section>
          <div className="flex items-baseline justify-between mb-4">
            <h2 className="font-serif-display text-4xl">the dashboard</h2>
            <div className="flex items-center gap-3">
              <span className="text-xs uppercase tracking-widest text-muted-foreground">
                {artists.length} artist{artists.length === 1 ? "" : "s"}
              </span>
              <Button
                size="sm"
                variant="outline"
                disabled={syncing}
                onClick={() => runSync()}
                className="border-2 border-foreground hover:bg-foreground hover:text-background"
                title={sheetUrl ?? "creates a google sheet on first sync"}
              >
                <Sheet className="w-4 h-4 mr-1" />
                {syncing ? "syncing…" : sheetUrl ? "sync sheet" : "create sheet"}
              </Button>
              {sheetUrl && (
                <a
                  href={sheetUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="text-[10px] uppercase tracking-widest font-bold underline underline-offset-4"
                >
                  open sheet
                </a>
              )}
              {artists.length > 0 && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={zipping}
                  onClick={downloadAllArtists}
                  className="border-2 border-foreground hover:bg-foreground hover:text-background"
                >
                  <Download className="w-4 h-4 mr-1" />
                  {zipping ? "zipping…" : "zip all approved"}
                </Button>
              )}
            </div>
          </div>

          {artists.length === 0 ? (
            <div className="border-2 border-dashed border-foreground/40 p-12 text-center">
              <p className="font-serif-display text-2xl text-muted-foreground">
                no one in the lineup yet.
              </p>
              <p className="text-sm text-muted-foreground mt-2">
                paste some artists above to start the engine.
              </p>
            </div>
          ) : (
            <div className="space-y-8">
              {artists.map((a) => (
                <ArtistCard key={a.id} artist={a} onChange={load} />
              ))}
            </div>
          )}
        </section>
      </main>

      <footer className="border-t-2 border-foreground py-6 mt-20">
        <div className="max-w-6xl mx-auto px-6 text-xs uppercase tracking-widest text-muted-foreground flex justify-between">
          <span>made with movement</span>
          <span>nano banana 2 · gemini 3.1 flash image</span>
        </div>
      </footer>
    </div>
  );
};

export default Index;
