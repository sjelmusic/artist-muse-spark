import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { Loader2, Sparkles } from "lucide-react";

interface Props {
  onCreated: () => void;
}

const PLACEHOLDER = `Olivia Dean | Dive, The Hardest Part, Ladies Room
Fred again | Delilah, Marea, Kammy
Raye | Escapism, Ice Cream Man`;

export function BulkInputForm({ onCreated }: Props) {
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(false);

  const submit = async () => {
    const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
    if (!lines.length) {
      toast.error("Add at least one artist");
      return;
    }
    setLoading(true);
    try {
      const rows = lines.map((line) => {
        const [name, songsRaw] = line.split("|").map((s) => s?.trim() ?? "");
        const songs = songsRaw
          ? songsRaw.split(",").map((s) => s.trim()).filter(Boolean)
          : [];
        return { name, songs };
      }).filter((r) => r.name);

      const { data: created, error } = await supabase
        .from("artists")
        .insert(rows)
        .select();
      if (error) throw error;

      toast.success(`${created.length} artist${created.length > 1 ? "s" : ""} added — generating headshots`);
      setText("");
      onCreated();

      // Kick off headshot generation for each (sequentially, fire-and-forget)
      for (const a of created) {
        supabase.functions
          .invoke("generate-images", { body: { mode: "headshots", artistId: a.id } })
          .then(({ error: e }) => {
            if (e) toast.error(`Headshots failed for ${a.name}: ${e.message}`);
            else {
              toast.success(`Headshots ready: ${a.name}`);
              onCreated();
            }
          });
      }
    } catch (e: any) {
      toast.error(e.message || "Failed to add artists");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="bg-card border-2 border-foreground shadow-brutal-lg p-6 space-y-4">
      <div>
        <h2 className="font-serif-display text-3xl">paste the lineup.</h2>
        <p className="text-sm text-muted-foreground mt-1">
          One artist per line. Format: <code className="bg-secondary px-1.5 py-0.5">Name | song, song, song</code>
        </p>
      </div>
      <Textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={PLACEHOLDER}
        className="min-h-[180px] border-2 border-foreground bg-background font-mono text-sm resize-none focus-visible:ring-0 focus-visible:ring-offset-0"
      />
      <Button
        onClick={submit}
        disabled={loading}
        className="w-full bg-accent hover:bg-accent/90 text-accent-foreground border-2 border-foreground shadow-brutal hover:translate-x-[2px] hover:translate-y-[2px] hover:shadow-none transition-all h-12 text-base font-bold uppercase tracking-wide"
      >
        {loading ? <Loader2 className="animate-spin mr-2" /> : <Sparkles className="mr-2" />}
        Generate headshots
      </Button>
    </div>
  );
}