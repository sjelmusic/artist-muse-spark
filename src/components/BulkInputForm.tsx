import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { Loader2, Sparkles, Upload, X } from "lucide-react";

interface Props {
  onCreated: () => void;
}

const PLACEHOLDER = `Olivia Dean | smoky jazz bar, velvet, golden hour
Fred again | rave afterglow, blurred neon, sweaty euphoria
Raye | red lipstick, late night confession, sequins`;

export function BulkInputForm({ onCreated }: Props) {
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(false);

  // Single-artist-with-own-headshot flow
  const [soloName, setSoloName] = useState("");
  const [soloSongs, setSoloSongs] = useState("");
  const [soloFile, setSoloFile] = useState<File | null>(null);
  const [soloPreview, setSoloPreview] = useState<string | null>(null);
  const [soloLoading, setSoloLoading] = useState(false);

  const onSoloFile = (f: File | null) => {
    setSoloFile(f);
    if (soloPreview) URL.revokeObjectURL(soloPreview);
    setSoloPreview(f ? URL.createObjectURL(f) : null);
  };

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

  const submitSolo = async () => {
    const name = soloName.trim();
    if (!name) {
      toast.error("artist name required");
      return;
    }
    if (!soloFile) {
      toast.error("pick an image to use as the headshot");
      return;
    }
    if (!soloFile.type.startsWith("image/")) {
      toast.error("file must be an image");
      return;
    }
    if (soloFile.size > 15 * 1024 * 1024) {
      toast.error("image must be under 15mb");
      return;
    }
    const songs = soloSongs
      ? soloSongs.split(",").map((s) => s.trim()).filter(Boolean)
      : [];

    setSoloLoading(true);
    try {
      // 1. Create the artist row up front (so we have an id for the storage path)
      const { data: artist, error: aErr } = await supabase
        .from("artists")
        .insert({ name, songs, status: "headshots_ready" })
        .select()
        .single();
      if (aErr || !artist) throw aErr || new Error("couldn't create artist");

      // 2. Upload the file
      const ext = (soloFile.name.split(".").pop() || "jpg").toLowerCase();
      const path = `${artist.id}/upload-headshot-${Date.now()}.${ext}`;
      const { error: upErr } = await supabase.storage
        .from("artist-images")
        .upload(path, soloFile, { contentType: soloFile.type, upsert: false });
      if (upErr) throw upErr;

      // 3. Insert as a headshot image
      const { data: img, error: iErr } = await supabase
        .from("generated_images")
        .insert({
          artist_id: artist.id,
          storage_path: path,
          kind: "headshot",
          prompt: "user-uploaded reference",
          is_reference: true,
        })
        .select()
        .single();
      if (iErr || !img) throw iErr || new Error("couldn't save image");

      // 4. Kick off variant generation using this as the reference
      toast.success(`${name} added — generating the set from your image`);
      setSoloName("");
      setSoloSongs("");
      onSoloFile(null);
      onCreated();

      supabase.functions
        .invoke("generate-images", {
          body: { mode: "variants", artistId: artist.id, referenceImageId: img.id },
        })
        .then(({ error: e }) => {
          if (e) toast.error(`variants failed for ${name}: ${e.message}`);
          else {
            toast.success(`set ready: ${name}`);
            onCreated();
          }
        });
    } catch (e: any) {
      toast.error(e.message || "failed to add artist");
    } finally {
      setSoloLoading(false);
    }
  };

  return (
    <div className="space-y-4">
      {/* BULK */}
      <div className="bg-card border-2 border-foreground shadow-brutal-lg p-6 space-y-4">
        <div>
          <h2 className="font-serif-display text-3xl">paste the lineup.</h2>
          <p className="text-sm text-muted-foreground mt-1">
            One artist per line. Format: <code className="bg-secondary px-1.5 py-0.5">Name | keyword, keyword, keyword</code>
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

      {/* SOLO + OWN IMAGE */}
      <div className="bg-card border-2 border-foreground shadow-brutal-lg p-6 space-y-4">
        <div>
          <h3 className="font-serif-display text-2xl">or — bring your own face.</h3>
          <p className="text-sm text-muted-foreground mt-1">
            Upload one image and we'll skip the headshot step entirely — your image becomes the reference and we go straight to the set.
          </p>
        </div>
        <div className="grid md:grid-cols-[140px_1fr] gap-4 items-start">
          {/* Upload box */}
          <label
            htmlFor="solo-file"
            className="relative aspect-square border-2 border-dashed border-foreground bg-background cursor-pointer flex items-center justify-center overflow-hidden hover:bg-secondary transition-colors"
          >
            {soloPreview ? (
              <>
                <img src={soloPreview} alt="upload preview" className="w-full h-full object-cover" />
                <button
                  type="button"
                  onClick={(e) => {
                    e.preventDefault();
                    onSoloFile(null);
                  }}
                  className="absolute top-1 right-1 bg-background border-2 border-foreground p-1 hover:bg-destructive hover:text-destructive-foreground"
                  title="remove"
                >
                  <X className="w-3 h-3" />
                </button>
              </>
            ) : (
              <div className="text-center text-xs uppercase tracking-widest text-muted-foreground p-2 flex flex-col items-center gap-2">
                <Upload className="w-5 h-5" />
                drop image
              </div>
            )}
            <input
              id="solo-file"
              type="file"
              accept="image/*"
              className="sr-only"
              onChange={(e) => onSoloFile(e.target.files?.[0] ?? null)}
            />
          </label>

          <div className="space-y-3">
            <Input
              value={soloName}
              onChange={(e) => setSoloName(e.target.value)}
              placeholder="artist name"
              maxLength={120}
              className="border-2 border-foreground bg-background focus-visible:ring-0 focus-visible:ring-offset-0"
            />
            <Input
              value={soloSongs}
              onChange={(e) => setSoloSongs(e.target.value)}
              placeholder="keywords (comma separated, optional)"
              maxLength={400}
              className="border-2 border-foreground bg-background focus-visible:ring-0 focus-visible:ring-offset-0"
            />
            <Button
              onClick={submitSolo}
              disabled={soloLoading}
              className="w-full bg-foreground hover:bg-foreground/90 text-background border-2 border-foreground shadow-brutal hover:translate-x-[2px] hover:translate-y-[2px] hover:shadow-none transition-all h-11 text-sm font-bold uppercase tracking-wide"
            >
              {soloLoading ? <Loader2 className="animate-spin mr-2 w-4 h-4" /> : <Sparkles className="mr-2 w-4 h-4" />}
              use my image → generate set
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}