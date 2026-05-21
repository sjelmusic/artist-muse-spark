import { useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { fetchImageBlob, publicUrl, thumbUrl } from "@/lib/storage";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { Check, CheckCheck, Download, Link2, Loader2, Pencil, Plus, ThumbsDown, ThumbsUp, Trash2, Upload, Wand2, X } from "lucide-react";
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
  status: "new" | "approved" | "disapproved" | "used" | string;
};

interface Props {
  artist: Artist;
  onChange: () => void;
}

export function ArtistCard({ artist, onChange }: Props) {
  const [images, setImages] = useState<Image[]>([]);
  const [busy, setBusy] = useState(false);
  const [editingKeywords, setEditingKeywords] = useState(false);
  const [keywordDraft, setKeywordDraft] = useState(artist.songs.join(", "));
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const toggleSelected = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  useEffect(() => {
    if (!editingKeywords) setKeywordDraft(artist.songs.join(", "));
  }, [artist.songs, editingKeywords]);

  const saveKeywords = async () => {
    const next = keywordDraft
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const { error } = await supabase
      .from("artists")
      .update({ songs: next })
      .eq("id", artist.id);
    if (error) {
      toast.error("couldn't save keywords");
      return;
    }
    setEditingKeywords(false);
    toast.success("keywords updated");
    onChange();
  };

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

  const StatusButtons = ({ img, alwaysVisible }: { img: Image; alwaysVisible?: boolean }) => {
    const baseHidden = alwaysVisible ? "" : "opacity-0 group-hover:opacity-100";
    return (
      <>
        <button
          onClick={() => setStatus(img, "approved")}
          className={`border-2 border-foreground p-1 transition-all ${
            img.status === "approved"
              ? "bg-accent text-accent-foreground opacity-100"
              : `bg-background ${baseHidden} hover:bg-accent hover:text-accent-foreground`
          }`}
          title={img.status === "approved" ? "approved — feeds future prompts. click to unset" : "approve"}
        >
          <ThumbsUp className={`w-3 h-3 ${img.status === "approved" ? "fill-current" : ""}`} />
        </button>
        <button
          onClick={() => setStatus(img, "disapproved")}
          className={`border-2 border-foreground p-1 transition-all ${
            img.status === "disapproved"
              ? "bg-destructive text-destructive-foreground opacity-100"
              : `bg-background ${baseHidden} hover:bg-destructive hover:text-destructive-foreground`
          }`}
          title={img.status === "disapproved" ? "disapproved. click to unset" : "disapprove"}
        >
          <ThumbsDown className={`w-3 h-3 ${img.status === "disapproved" ? "fill-current" : ""}`} />
        </button>
        <button
          onClick={() => setStatus(img, "used")}
          className={`border-2 border-foreground p-1 transition-all ${
            img.status === "used"
              ? "bg-foreground text-background opacity-100"
              : `bg-background ${baseHidden} hover:bg-foreground hover:text-background`
          }`}
          title={img.status === "used" ? "tagged as used — click to untag" : "mark as used"}
        >
          <CheckCheck className="w-3 h-3" />
        </button>
      </>
    );
  };

  const statusBadgeFor = (status: string) => {
    if (status === "used") return { label: "used", className: "bg-foreground text-background" };
    if (status === "disapproved") return { label: "nope", className: "bg-destructive text-destructive-foreground" };
    if (status === "approved") return { label: "approved", className: "bg-accent text-accent-foreground" };
    return null;
  };

  const dimmedClass = (status: string) =>
    status === "used" || status === "disapproved" ? "opacity-40 grayscale" : "";

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

  const uploadReferences = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setUploading(true);
    let ok = 0;
    let fail = 0;
    try {
      for (const file of Array.from(files)) {
        if (!file.type.startsWith("image/")) { fail++; continue; }
        if (file.size > 15 * 1024 * 1024) { fail++; continue; }
        const ext = (file.name.split(".").pop() || "jpg").toLowerCase();
        const path = `${artist.id}/upload-headshot-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.${ext}`;
        const { error: upErr } = await supabase.storage
          .from("artist-images")
          .upload(path, file, { contentType: file.type, upsert: false });
        if (upErr) { fail++; continue; }
        const { error: iErr } = await supabase
          .from("generated_images")
          .insert({
            artist_id: artist.id,
            storage_path: path,
            kind: "headshot",
            prompt: "user-uploaded reference",
            is_reference: true,
            status: artist.reference_image_id ? "approved" : "new",
            liked: !!artist.reference_image_id,
          });
        if (iErr) { fail++; continue; }
        ok++;
      }
      if (ok) toast.success(`added ${ok} reference${ok === 1 ? "" : "s"}`);
      if (fail) toast.error(`${fail} file${fail === 1 ? "" : "s"} skipped`);
      load();
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const setStatus = async (img: Image, target: Image["status"]) => {
    // Toggle: clicking the current status returns it to 'new'.
    const next = img.status === target ? "new" : target;
    setImages((prev) => prev.map((i) => (i.id === img.id ? { ...i, status: next } : i)));
    const { error } = await supabase
      .from("generated_images")
      .update({ status: next, liked: next === "approved", used: next === "used" })
      .eq("id", img.id);
    if (error) {
      setImages((prev) => prev.map((i) => (i.id === img.id ? { ...i, status: img.status } : i)));
      toast.error("couldn't update status");
    }
  };

  const bulkSetSelected = async (target: "approved" | "disapproved") => {
    const ids = variants
      .filter((i) => selected.has(i.id) && i.status !== target)
      .map((i) => i.id);
    if (ids.length === 0) {
      toast.info("nothing selected");
      return;
    }
    setImages((prev) =>
      prev.map((i) => (ids.includes(i.id) ? { ...i, status: target } : i))
    );
    const { error } = await supabase
      .from("generated_images")
      .update({
        status: target,
        liked: target === "approved",
        used: false,
      })
      .in("id", ids);
    if (error) {
      toast.error("bulk update failed");
      load();
      return;
    }
    setSelected(new Set());
    toast.success(`${target === "approved" ? "approved" : "disapproved"} ${ids.length}`);
  };

  const downloadOne = async (img: Image) => {
    try {
      const blob = await fetchImageBlob(img.storage_path);
      const resized = await resizeToSquare(blob, 3000);
      const safeName = artist.name.replace(/[^a-z0-9]/gi, "_");
      saveAs(resized, `${safeName}-${img.id.slice(0, 6)}.jpg`);
    } catch (e) {
      console.error(e);
      toast.error("download failed");
    }
  };

  const copyLink = async (img: Image) => {
    const url = publicUrl(img.storage_path);
    try {
      await navigator.clipboard.writeText(url);
      toast.success("high-res link copied");
    } catch {
      // Fallback for older browsers / insecure contexts
      const ta = document.createElement("textarea");
      ta.value = url;
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
        toast.success("high-res link copied");
      } catch {
        toast.error("couldn't copy link");
      }
      document.body.removeChild(ta);
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
        <div className="flex-1 min-w-0 mr-4">
          <h3 className="font-serif-display text-4xl leading-none">{artist.name}</h3>
          {editingKeywords ? (
            <div className="mt-2 flex gap-2 items-center">
              <input
                value={keywordDraft}
                onChange={(e) => setKeywordDraft(e.target.value)}
                placeholder="keyword, keyword, keyword"
                className="flex-1 border-2 border-foreground bg-background px-2 py-1 text-xs uppercase tracking-wider focus:outline-none"
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === "Enter") saveKeywords();
                  if (e.key === "Escape") setEditingKeywords(false);
                }}
              />
              <button
                onClick={saveKeywords}
                className="border-2 border-foreground bg-accent text-accent-foreground p-1 hover:bg-foreground hover:text-background"
                title="save"
              >
                <Check className="w-3 h-3" />
              </button>
              <button
                onClick={() => setEditingKeywords(false)}
                className="border-2 border-foreground bg-background p-1 hover:bg-destructive hover:text-destructive-foreground"
                title="cancel"
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          ) : (
            <button
              onClick={() => setEditingKeywords(true)}
              className="mt-2 group flex items-center gap-2 text-left"
              title="edit keywords"
            >
              <p className="text-xs text-muted-foreground uppercase tracking-wider">
                {artist.songs.length > 0 ? artist.songs.join(" · ") : "+ add keywords"}
              </p>
              <Pencil className="w-3 h-3 text-muted-foreground opacity-0 group-hover:opacity-100" />
            </button>
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
            <div className="flex items-center gap-3">
              {isLoading && headshots.length === 0 && (
                <span className="text-xs flex items-center gap-2 text-muted-foreground">
                  <Loader2 className="w-3 h-3 animate-spin" /> generating
                </span>
              )}
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                multiple
                className="sr-only"
                onChange={(e) => uploadReferences(e.target.files)}
              />
              <Button
                size="sm"
                variant="outline"
                disabled={uploading}
                onClick={() => fileInputRef.current?.click()}
                className="border-2 border-foreground hover:bg-foreground hover:text-background h-7 text-xs"
                title="upload your own image(s) as reference — added to the reference pool"
              >
                {uploading ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <Upload className="w-3 h-3 mr-1" />}
                upload reference
              </Button>
            </div>
          </div>
          <div className="grid grid-cols-3 md:grid-cols-6 gap-2">
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
                          src={thumbUrl(img.storage_path, 400)}
                          alt={`${artist.name} headshot`}
                          className={`w-full h-full object-cover transition-all ${dimmedClass(img.status)}`}
                          loading="lazy"
                        />
                      </div>
                      {(() => {
                        const badge = statusBadgeFor(img.status);
                        return badge ? (
                          <div className={`absolute bottom-1 left-1 ${badge.className} px-1.5 py-0.5 text-[9px] uppercase tracking-widest font-bold border border-foreground pointer-events-none z-10`}>
                            {badge.label}
                          </div>
                        ) : null;
                      })()}
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
                          <StatusButtons img={img} />
                          <button
                            onClick={() => downloadOne(img)}
                            className="bg-background border-2 border-foreground p-1 opacity-0 group-hover:opacity-100 hover:bg-foreground hover:text-background transition-all"
                            title="download 3000×3000"
                          >
                            <Download className="w-3 h-3" />
                          </button>
                          <button
                            onClick={() => copyLink(img)}
                            className="bg-background border-2 border-foreground p-1 opacity-0 group-hover:opacity-100 hover:bg-foreground hover:text-background transition-all"
                            title="copy high-res link"
                          >
                            <Link2 className="w-3 h-3" />
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
                  disabled={busy || variants.length === 0}
                  onClick={() => bulkSetVariants("approved")}
                  className="border-2 border-foreground hover:bg-accent hover:text-accent-foreground h-7 text-xs"
                  title="approve all variants"
                >
                  <ThumbsUp className="w-3 h-3 mr-1" /> approve all
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy || variants.length === 0}
                  onClick={() => bulkSetVariants("disapproved")}
                  className="border-2 border-foreground hover:bg-destructive hover:text-destructive-foreground h-7 text-xs"
                  title="disapprove all variants"
                >
                  <ThumbsDown className="w-3 h-3 mr-1" /> reject all
                </Button>
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
            <div className="grid grid-cols-3 md:grid-cols-5 gap-2">
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
                          src={thumbUrl(img.storage_path, 400)}
                          alt={`${artist.name} variant`}
                          className={`w-full h-full object-cover transition-all ${dimmedClass(img.status)}`}
                          loading="lazy"
                        />
                      </div>
                      {(() => {
                        const badge = statusBadgeFor(img.status);
                        return badge ? (
                          <div className={`absolute bottom-1 left-1 ${badge.className} px-1.5 py-0.5 text-[9px] uppercase tracking-widest font-bold border border-foreground pointer-events-none z-10`}>
                            {badge.label}
                          </div>
                        ) : null;
                      })()}
                      {img.song && (
                        <div className="absolute bottom-2 left-2 right-2 bg-background/90 border border-foreground px-2 py-1 text-[10px] uppercase tracking-wider truncate">
                          {img.song}
                        </div>
                      )}
                      <div className="absolute top-2 right-2 flex gap-1">
                        <StatusButtons img={img} />
                        <button
                          onClick={() => downloadOne(img)}
                          className="bg-background border-2 border-foreground p-1 opacity-0 group-hover:opacity-100 hover:bg-foreground hover:text-background transition-all"
                          title="download 3000×3000"
                        >
                          <Download className="w-3 h-3" />
                        </button>
                        <button
                          onClick={() => copyLink(img)}
                          className="bg-background border-2 border-foreground p-1 opacity-0 group-hover:opacity-100 hover:bg-foreground hover:text-background transition-all"
                          title="copy high-res link"
                        >
                          <Link2 className="w-3 h-3" />
                        </button>
                        <button
                          onClick={() => deleteImage(img)}
                          className="bg-background border-2 border-foreground p-1 opacity-0 group-hover:opacity-100 hover:bg-destructive hover:text-destructive-foreground transition-all"
                          title="delete"
                        >
                          <X className="w-3 h-3" />
                        </button>
                      </div>
                    </div>
                  ))}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}