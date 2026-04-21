import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { BulkInputForm } from "@/components/BulkInputForm";
import { ArtistCard, resizeToSquare } from "@/components/ArtistCard";
import { Button } from "@/components/ui/button";
import { Download } from "lucide-react";
import { toast } from "sonner";
import { publicUrl } from "@/lib/storage";
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

  const load = async () => {
    const { data } = await supabase
      .from("artists")
      .select("*")
      .order("created_at", { ascending: false });
    setArtists((data as Artist[]) || []);
  };

  useEffect(() => {
    load();
    const ch = supabase
      .channel("artists-list")
      .on("postgres_changes", { event: "*", schema: "public", table: "artists" }, () => load())
      .subscribe();
    return () => {
      supabase.removeChannel(ch);
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
      for (const a of artists) {
        const mine = imgs.filter((i) => i.artist_id === a.id);
        const chosen = mine.find((i) => i.id === a.reference_image_id);
        const exportable = [
          ...(chosen ? [chosen] : []),
          ...mine.filter((i) => i.kind === "variant"),
        ];
        if (!exportable.length) continue;
        const folder = zip.folder(a.name.replace(/[^a-z0-9]/gi, "_"))!;
        for (const img of exportable) {
          const res = await fetch(publicUrl(img.storage_path));
          const blob = await res.blob();
          const resized = await resizeToSquare(blob, 3000);
          folder.file(`${img.kind}-${img.id.slice(0, 6)}.jpg`, resized);
          total++;
        }
      }
      if (!total) {
        toast.error("no approved headshots or variants found");
        return;
      }
      const out = await zip.generateAsync({ type: "blob" });
      saveAs(out, `aesthetic-engine-lineup.zip`);
      toast.success(`zipped ${total} images across the lineup`);
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
          <div className="hidden md:block text-right text-xs uppercase tracking-widest text-muted-foreground">
            artist · songs<br />
            → headshots → set
          </div>
        </div>
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
