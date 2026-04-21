import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { BulkInputForm } from "@/components/BulkInputForm";
import { ArtistCard } from "@/components/ArtistCard";

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
            <span className="text-xs uppercase tracking-widest text-muted-foreground">
              {artists.length} artist{artists.length === 1 ? "" : "s"}
            </span>
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
