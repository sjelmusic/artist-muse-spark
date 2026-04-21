import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { fetchImageBlob, publicUrl } from "@/lib/storage";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { Check, Download, Heart, Loader2, Plus, Trash2, Wand2, X } from "lucide-react";
import JSZip from "jszip";
import { saveAs } from "file-saver";

// Resize an image blob into a centered square JPEG of the given size (cover crop).
export async function resizeToSquare(blob: Blob, size: number): Promise<Blob> {
  // Try createImageBitmap first; fall back to <img> + objectURL for blobs the
  // browser refuses to decode directly (some PNG variants, odd MIME types).
  let source: CanvasImageSource;
  let width: number;
  let height: number;
  try {
    const bitmap = await createImageBitmap(blob);
    source = bitmap;
    width = bitmap.width;
    height = bitmap.height;
  } catch {
    const url = URL.createObjectURL(blob);
    try {
      const img = await new Promise<HTMLImageElement>((resolve, reject) => {
        const el = new Image();
        el.onload = () => resolve(el);
        el.onerror = () => reject(new Error("image decode failed"));
        el.src = url;
      });
      source = img;
      width = img.naturalWidth;
      height = img.naturalHeight;
    } finally {
      // Revoke after we've drawn — defer to next tick
      setTimeout(() => URL.revokeObjectURL(url), 0);
    }
  }
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const scale = Math.max(size / width, size / height);
  const w = width * scale;
  const h = height * scale;
  ctx.drawImage(source, (size - w) / 2, (size - h) / 2, w, h);
  return await new Promise<Blob>((resolve) =>
    canvas.toBlob((b) => resolve(b!), "image/jpeg", 0.78)
  );
}

type Artist = {
  id: string;
  name: string;
  songs: string[];
  status: string;
  reference_image_id: string | null;
};

type Image = {
  id: string;
  artist_id: string;
  storage_path: string;
  kind: string;
  song: string | null;
  is_reference: boolean;
  liked: boolean;
};

interface Props {
  artist: Artist;
  onChange: () => void;
}

export function ArtistCard({ artist, onChange }: Props) {
  const [images, setImages] = useState<Image[]>([]);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    const { data } = await supabase
      .from("generated_images")
      .select("*")
      .eq("artist_id", artist.id)
      .order("created_at", { ascending: true });
    setImages((data as Image[]) || []);
  };

  useEffect(() => {
    load();
    const ch = supabase
      .channel(`artist-${artist.id}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "generated_images", filter: `artist_id=eq.${artist.id}` },
        () => load()
      )
      .subscribe();
    return () => {
      supabase.removeChannel(ch);
    };
  }, [artist.id]);

  const headshots = images.filter((i) => i.kind === "headshot");
  const variants = images.filter((i) => i.kind === "variant");

  const chooseReference = async (img: Image) => {
    setBusy(true);
    try {
      const { error } = await supabase.functions.invoke("generate-images", {
        body: { mode: "variants", artistId: artist.id, referenceImageId: img.id },
      });
      if (error) throw error;
      toast.success(`Generating variants for ${artist.name}…`);
      onChange();
    } catch (e: any) {
      toast.error(e.message || "Failed");
    } finally {
      setBusy(false);
    }
  };

  const generateExtra = async (flavor: "wild" | "cinematic" | "aesthetic" | "plain") => {
    setBusy(true);
    try {
      const { error } = await supabase.functions.invoke("generate-images", {
        body: { mode: "extra", artistId: artist.id, flavor },
      });
      if (error) throw error;
      toast.success(`Generating 10 ${flavor} shots for ${artist.name}…`);
    } catch (e: any) {
      toast.error(e.message || "Failed");
    } finally {
      setBusy(false);
    }
  };

  const deleteImage = async (img: Image) => {
    // Optimistic UI: remove immediately, then clean up in background
    setImages((prev) => prev.filter((i) => i.id !== img.id));
    void supabase.from("generated_images").delete().eq("id", img.id);
    void supabase.storage.from("artist-images").remove([img.storage_path]);
  };

  const toggleLike = async (img: Image) => {
    const next = !img.liked;
    setImages((prev) => prev.map((i) => (i.id === img.id ? { ...i, liked: next } : i)));
    const { error } = await supabase
      .from("generated_images")
      .update({ liked: next })
      .eq("id", img.id);
    if (error) {
      // revert
      setImages((prev) => prev.map((i) => (i.id === img.id ? { ...i, liked: !next } : i)));
      toast.error("couldn't save like");
    }
  };

  const deleteArtist = async () => {
    if (!confirm(`Delete ${artist.name} and all images?`)) return;
    const paths = images.map((i) => i.storage_path);
    if (paths.length) await supabase.storage.from("artist-images").remove(paths);
    await supabase.from("artists").delete().eq("id", artist.id);
    onChange();
  };

  const downloadAll = async () => {
    // Only the chosen reference headshot + remaining (non-deleted) variants
    const chosen = images.find((i) => i.id === artist.reference_image_id);
    const exportable = [
      ...(chosen ? [chosen] : []),
      ...images.filter((i) => i.kind === "variant"),
    ];
    if (!exportable.length) {
      toast.error("nothing approved to export yet");
      return;
    }
    toast.info("Resizing to 3000×3000 and zipping…");
    const zip = new JSZip();
    const safeName = artist.name.replace(/[^a-z0-9]/gi, "_");
    const folder = zip.folder(safeName)!;
    const results = await Promise.all(
      exportable.map(async (img) => {
        try {
          const blob = await fetchImageBlob(img.storage_path);
          const resized = await resizeToSquare(blob, 3000);
          return { ok: true as const, resized };
        } catch (error) {
          console.error("Skipping export image", img.storage_path, error);
          return { ok: false as const };
        }
      })
    );
    let idx = 1;
    let skipped = 0;
    for (const r of results) {
      if (r.ok) {
        folder.file(`${safeName}-${String(idx).padStart(2, "0")}.jpg`, r.resized);
        idx++;
      } else {
        skipped++;
      }
    }
    if (idx === 1) {
      toast.error("No valid images could be exported");
      return;
    }
    const out = await zip.generateAsync({ type: "blob" });
    saveAs(out, `${artist.name}.zip`);
    if (skipped) {
      toast.warning(`Exported with ${skipped} skipped bad file${skipped === 1 ? "" : "s"}`);
    }
  };

  const isLoading =
    artist.status === "pending" ||
    (artist.status === "reference_chosen" && variants.length === 0);

  return (
    <div className="bg-card border-2 border-foreground shadow-brutal-lg overflow-hidden">
      <header className="flex items-start justify-between p-5 border-b-2 border-foreground bg-background">
        <div>
          <h3 className="font-serif-display text-4xl leading-none">{artist.name}</h3>
          {artist.songs.length > 0 && (
            <p className="text-xs text-muted-foreground mt-2 uppercase tracking-wider">
              {artist.songs.join(" · ")}
            </p>
          )}
        </div>
        <div className="flex gap-2">
          {images.length > 0 && (
            <Button
              size="sm"
              variant="outline"
              onClick={downloadAll}
              className="border-2 border-foreground hover:bg-foreground hover:text-background"
            >
              <Download className="w-4 h-4 mr-1" />
              ZIP
            </Button>
          )}
          <Button
            size="sm"
            variant="outline"
            onClick={deleteArtist}
            className="border-2 border-foreground hover:bg-destructive hover:text-destructive-foreground hover:border-destructive"
          >
            <Trash2 className="w-4 h-4" />
          </Button>
        </div>
      </header>

      <div className="p-5 space-y-6">
        {/* Headshots */}
        <section>
          <div className="flex items-center justify-between mb-3">
            <h4 className="text-xs uppercase tracking-[0.2em] font-bold">
              {artist.reference_image_id ? "01 — chosen reference" : "01 — pick your headshot"}
            </h4>
            {isLoading && headshots.length === 0 && (
              <span className="text-xs flex items-center gap-2 text-muted-foreground">
                <Loader2 className="w-3 h-3 animate-spin" /> generating
              </span>
            )}
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {headshots.length === 0
              ? Array.from({ length: 4 }).map((_, i) => (
                  <div
                    key={i}
                    className="aspect-square bg-secondary border-2 border-foreground grain animate-pulse"
                  />
                ))
              : headshots.map((img) => {
                  const chosen = img.id === artist.reference_image_id;
                  return (
                    <div key={img.id} className="relative group">
                      <div
                        className={`aspect-square border-2 border-foreground overflow-hidden ${
                          chosen ? "shadow-brutal-accent ring-4 ring-accent" : ""
                        }`}
                      >
                        <img
                          src={publicUrl(img.storage_path)}
                          alt={`${artist.name} headshot`}
                          className="w-full h-full object-cover"
                          loading="lazy"
                        />
                      </div>
                      {!artist.reference_image_id && (
                        <button
                          disabled={busy}
                          onClick={() => chooseReference(img)}
                          className="absolute inset-0 bg-foreground/0 hover:bg-foreground/70 transition-colors flex items-center justify-center opacity-0 hover:opacity-100"
                        >
                          <span className="bg-accent text-accent-foreground px-3 py-1.5 text-xs font-bold uppercase tracking-wider border-2 border-background flex items-center gap-1">
                            <Wand2 className="w-3 h-3" /> use this
                          </span>
                        </button>
                      )}
                      {chosen && (
                        <div className="absolute top-2 right-2 bg-accent text-accent-foreground p-1 border-2 border-foreground">
                          <Check className="w-3 h-3" />
                        </div>
                      )}
                      {!chosen && (
                        <div className="absolute top-2 right-2 flex gap-1 z-10">
                          <button
                            onClick={() => toggleLike(img)}
                            className={`border-2 border-foreground p-1 transition-all ${
                              img.liked
                                ? "bg-accent text-accent-foreground opacity-100"
                                : "bg-background opacity-0 group-hover:opacity-100 hover:bg-accent hover:text-accent-foreground"
                            }`}
                            title={img.liked ? "liked — used as reference" : "like"}
                          >
                            <Heart className={`w-3 h-3 ${img.liked ? "fill-current" : ""}`} />
                          </button>
                          <button
                            onClick={() => deleteImage(img)}
                            className="bg-background border-2 border-foreground p-1 opacity-0 group-hover:opacity-100 hover:bg-destructive hover:text-destructive-foreground transition-all"
                            title="delete"
                          >
                            <X className="w-3 h-3" />
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })}
          </div>
        </section>

        {/* Variants */}
        {artist.reference_image_id && (
          <section>
            <div className="flex items-center justify-between mb-3">
              <h4 className="text-xs uppercase tracking-[0.2em] font-bold">
                02 — the set ({variants.length})
              </h4>
              <div className="flex items-center gap-3">
                {isLoading && (
                  <span className="text-xs flex items-center gap-2 text-muted-foreground">
                    <Loader2 className="w-3 h-3 animate-spin" /> generating
                  </span>
                )}
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => generateExtra("wild")}
                  className="border-2 border-foreground hover:bg-accent hover:text-accent-foreground h-7 text-xs"
                >
                  <Plus className="w-3 h-3 mr-1" /> 10 wild
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => generateExtra("cinematic")}
                  className="border-2 border-foreground hover:bg-accent hover:text-accent-foreground h-7 text-xs"
                >
                  <Plus className="w-3 h-3 mr-1" /> 10 cinematic
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => generateExtra("aesthetic")}
                  className="border-2 border-foreground hover:bg-accent hover:text-accent-foreground h-7 text-xs"
                >
                  <Plus className="w-3 h-3 mr-1" /> 10 aesthetic
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => generateExtra("plain")}
                  className="border-2 border-foreground hover:bg-accent hover:text-accent-foreground h-7 text-xs"
                >
                  <Plus className="w-3 h-3 mr-1" /> 10 plain
                </Button>
              </div>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
              {variants.length === 0 && isLoading
                ? Array.from({ length: 6 }).map((_, i) => (
                    <div
                      key={i}
                      className="aspect-square bg-secondary border-2 border-foreground grain animate-pulse"
                    />
                  ))
                : variants.map((img) => (
                    <div key={img.id} className="relative group">
                      <div className="aspect-square border-2 border-foreground overflow-hidden">
                        <img
                          src={publicUrl(img.storage_path)}
                          alt={`${artist.name} variant`}
                          className="w-full h-full object-cover"
                          loading="lazy"
                        />
                      </div>
                      {img.song && (
                        <div className="absolute bottom-2 left-2 right-2 bg-background/90 border border-foreground px-2 py-1 text-[10px] uppercase tracking-wider truncate">
                          {img.song}
                        </div>
                      )}
                      <button
                        onClick={() => deleteImage(img)}
                        className="absolute top-2 right-2 bg-background border-2 border-foreground p-1 opacity-0 group-hover:opacity-100 hover:bg-destructive hover:text-destructive-foreground transition-all"
                        title="delete"
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </div>
                  ))}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}