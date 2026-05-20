import { useState } from "react";
import { Link } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import { ArrowLeft, Loader2, Music } from "lucide-react";

const PLACEHOLDER = `https://open.spotify.com/artist/3TVXtAsR1Inumwj472S9r4
https://open.spotify.com/artist/06HL4z0CvFAxyc27GXpf02
spotify:artist:1Xyo4u8uXC1ZmMpatF05PJ`;

type Result =
  | { ok: true; input: string; artistId: string; name: string; referenceImageId: string }
  | { ok: false; input: string; error: string };

const BulkSpotify = () => {
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<Result[]>([]);

  const submit = async () => {
    const inputs = text.split("\n").map((l) => l.trim()).filter(Boolean);
    if (!inputs.length) {
      toast.error("paste at least one spotify link");
      return;
    }
    setLoading(true);
    setResults([]);
    try {
      const { data, error } = await supabase.functions.invoke("spotify-import", {
        body: { inputs },
      });
      if (error) throw error;
      const res: Result[] = data?.results || [];
      setResults(res);

      const ok = res.filter((r): r is Extract<Result, { ok: true }> => r.ok);
      const failed = res.filter((r) => !r.ok);
      if (ok.length) toast.success(`imported ${ok.length} artist${ok.length === 1 ? "" : "s"} · firing variants`);
      if (failed.length) toast.error(`${failed.length} failed — see below`);

      // Kick off variant generation for each successful import (fire-and-forget)
      for (const r of ok) {
        supabase.functions
          .invoke("generate-images", {
            body: { mode: "variants", artistId: r.artistId, referenceImageId: r.referenceImageId },
          })
          .then(({ error: e }) => {
            if (e) toast.error(`variants failed for ${r.name}: ${e.message}`);
            else toast.success(`set ready: ${r.name}`);
          });
      }
      if (ok.length) setText("");
    } catch (e: any) {
      toast.error(e.message || "import failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-background grain">
      <header className="border-b-2 border-foreground bg-background sticky top-0 z-20">
        <div className="max-w-3xl mx-auto px-6 py-4 flex items-end justify-between">
          <div>
            <div className="text-[10px] uppercase tracking-[0.3em] font-bold text-muted-foreground">
              bulk import
            </div>
            <h1 className="font-serif-display text-4xl md:text-5xl leading-none flex items-center gap-3">
              <Music className="w-8 h-8" />
              spotify lineup<span className="text-accent">.</span>
            </h1>
          </div>
          <Link
            to="/"
            className="flex items-center gap-1.5 border-2 border-foreground px-3 py-1.5 text-[10px] uppercase tracking-widest font-bold hover:bg-foreground hover:text-background transition-colors"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            back to dashboard
          </Link>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-6 py-10 space-y-6">
        <div className="bg-card border-2 border-foreground shadow-brutal-lg p-6 space-y-4">
          <div>
            <h2 className="font-serif-display text-2xl">paste spotify artist links.</h2>
            <p className="text-sm text-muted-foreground mt-1">
              One per line. We'll grab their official photo as the reference, pull their top 5 tracks as keywords, then auto-generate 6 styled variants per artist.
            </p>
          </div>
          <Textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={PLACEHOLDER}
            className="min-h-[200px] border-2 border-foreground bg-background font-mono text-sm resize-none focus-visible:ring-0 focus-visible:ring-offset-0"
          />
          <Button
            onClick={submit}
            disabled={loading}
            className="w-full bg-accent hover:bg-accent/90 text-accent-foreground border-2 border-foreground shadow-brutal hover:translate-x-[2px] hover:translate-y-[2px] hover:shadow-none transition-all h-12 text-base font-bold uppercase tracking-wide"
          >
            {loading ? <Loader2 className="animate-spin mr-2" /> : <Music className="mr-2" />}
            {loading ? "importing from spotify…" : "import lineup"}
          </Button>
        </div>

        {results.length > 0 && (
          <div className="bg-card border-2 border-foreground p-6 space-y-3">
            <h3 className="font-serif-display text-xl">results</h3>
            <ul className="space-y-1.5 text-sm font-mono">
              {results.map((r, i) => (
                <li
                  key={i}
                  className={`flex items-start gap-2 ${
                    r.ok ? "text-foreground" : "text-destructive"
                  }`}
                >
                  <span className="shrink-0">{r.ok ? "✓" : "✗"}</span>
                  <span className="truncate">
                    {r.ok ? r.name : `${r.input} — ${r.error}`}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </main>
    </div>
  );
};

export default BulkSpotify;