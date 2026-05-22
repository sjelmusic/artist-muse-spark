import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";

function extractStoragePath(line: string): string | null {
  const s = line.trim();
  if (!s) return null;
  // Match anything after `artist-images/` and strip query string.
  const m = s.match(/artist-images\/([^?#\s]+)/);
  if (m) return decodeURIComponent(m[1]);
  // Otherwise assume the line is already a raw storage path.
  if (!s.startsWith("http")) return s.replace(/^\/+/, "");
  return null;
}

export function MarkUsedDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    const lines = text.split(/\r?\n/);
    const paths = Array.from(
      new Set(lines.map(extractStoragePath).filter((p): p is string => !!p))
    );
    if (!paths.length) {
      toast.error("no valid links found");
      return;
    }
    setBusy(true);
    try {
      // Chunk to stay well below any URL/IN limit.
      const CHUNK = 200;
      let matched = 0;
      for (let i = 0; i < paths.length; i += CHUNK) {
        const slice = paths.slice(i, i + CHUNK);
        const { data, error } = await supabase
          .from("generated_images")
          .update({ used: true, status: "used", liked: false })
          .in("storage_path", slice)
          .select("id");
        if (error) throw error;
        matched += data?.length ?? 0;
      }
      const { error: syncError } = await supabase.functions.invoke("sheet-sync");
      if (syncError) throw syncError;
      const missing = paths.length - matched;
      toast.success(
        `marked ${matched} image${matched === 1 ? "" : "s"} as used${
          missing > 0 ? ` · ${missing} link${missing === 1 ? "" : "s"} didn't match anything` : ""
        }`
      );
      setText("");
      onClose();
    } catch (e: any) {
      toast.error(e.message || "failed to mark used");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-2xl border-2 border-foreground">
        <DialogHeader>
          <DialogTitle className="font-serif-display text-3xl">mark as used</DialogTitle>
          <DialogDescription>
            paste image links (one per line). anything matching an image in your library gets
            flagged <b>used</b> — they'll drop out of the google sheet and future variant prompts.
          </DialogDescription>
        </DialogHeader>
        <Textarea
          rows={14}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={"https://...supabase.co/storage/v1/object/public/artist-images/abc/xyz.jpg\nhttps://...\n..."}
          className="font-mono text-xs"
        />
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose} disabled={busy}>
            cancel
          </Button>
          <Button onClick={submit} disabled={busy || !text.trim()}>
            {busy ? "marking…" : "mark used"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
