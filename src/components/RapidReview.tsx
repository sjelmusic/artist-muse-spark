import { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { thumbUrl } from "@/lib/storage";
import { ArrowLeft, ArrowRight, CheckCheck, Loader2, X } from "lucide-react";
import { toast } from "sonner";

type Row = {
  id: string;
  artist_id: string;
  storage_path: string;
  kind: string;
  song: string | null;
  artist_name: string;
  songs: string[];
};

interface Props {
  open: boolean;
  onClose: () => void;
}

export function RapidReview({ open, onClose }: Props) {
  const [queue, setQueue] = useState<Row[]>([]);
  const [idx, setIdx] = useState(0);
  const [loading, setLoading] = useState(false);
  const [counts, setCounts] = useState({ approved: 0, disapproved: 0, used: 0, skipped: 0 });
  const animRef = useRef<"left" | "right" | "up" | "down" | null>(null);
  const [anim, setAnim] = useState<"left" | "right" | "up" | "down" | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const { data: imgs } = await supabase
        .from("generated_images")
        .select("id, artist_id, storage_path, kind, song")
        .eq("status", "new")
        .eq("is_reference", false)
        .eq("kind", "variant")
        .order("created_at", { ascending: false })
        .limit(500);
      const artistIds = Array.from(new Set((imgs ?? []).map((i: any) => i.artist_id)));
      const { data: artists } = await supabase
        .from("artists")
        .select("id, name, songs, reference_image_id")
        .in("id", artistIds.length ? artistIds : ["00000000-0000-0000-0000-000000000000"]);
      const aMap = new Map((artists ?? []).map((a: any) => [a.id, a]));
      const rows: Row[] = (imgs ?? [])
        .filter((i: any) => {
          const a = aMap.get(i.artist_id) as any;
          // only artists that already have a chosen reference,
          // and skip the reference headshot itself
          return a && a.reference_image_id && a.reference_image_id !== i.id;
        })
        .map((i: any) => {
          const a = aMap.get(i.artist_id) as any;
          return {
            id: i.id,
            artist_id: i.artist_id,
            storage_path: i.storage_path,
            kind: i.kind,
            song: i.song,
            artist_name: a?.name ?? "—",
            songs: a?.songs ?? [],
          };
        });
      setQueue(rows);
      setIdx(0);
      setCounts({ approved: 0, disapproved: 0, used: 0, skipped: 0 });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (open) load();
  }, [open]);

  const current = queue[idx];
  const next1 = queue[idx + 1];
  const next2 = queue[idx + 2];

  const advance = (status: "approved" | "disapproved" | "used" | null, dir: "left" | "right" | "up" | "down") => {
    if (!current) return;
    animRef.current = dir;
    setAnim(dir);
    if (status) {
      // optimistic
      const id = current.id;
      void supabase
        .from("generated_images")
        .update({
          status,
          liked: status === "approved",
          used: status === "used",
        })
        .eq("id", id)
        .then(({ error }) => {
          if (error) toast.error("save failed — refresh & retry");
        });
      setCounts((c) => ({ ...c, [status]: c[status] + 1 }));
    } else {
      setCounts((c) => ({ ...c, skipped: c.skipped + 1 }));
    }
    window.setTimeout(() => {
      setAnim(null);
      setIdx((i) => i + 1);
    }, 140);
  };

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
        return;
      }
      if (!current) return;
      if (e.key === "ArrowRight") {
        e.preventDefault();
        advance("approved", "right");
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        advance("disapproved", "left");
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        advance("used", "up");
      } else if (e.key === "ArrowDown" || e.key === " ") {
        e.preventDefault();
        advance(null, "down");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, current, idx, queue]);

  const done = !loading && (!queue.length || idx >= queue.length);

  const animClass = useMemo(() => {
    if (!anim) return "";
    if (anim === "right") return "translate-x-[120%] rotate-12 opacity-0";
    if (anim === "left") return "-translate-x-[120%] -rotate-12 opacity-0";
    if (anim === "up") return "-translate-y-[120%] opacity-0";
    return "translate-y-[40%] opacity-0";
  }, [anim]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 bg-background grain flex flex-col">
      {/* Header */}
      <div className="border-b-2 border-foreground px-6 py-3 flex items-center justify-between">
        <div>
          <div className="text-[10px] uppercase tracking-[0.3em] font-bold text-muted-foreground">
            rapid review
          </div>
          <div className="font-serif-display text-2xl leading-none">
            {loading ? "loading queue…" : done ? "all caught up" : `${idx + 1} / ${queue.length}`}
          </div>
        </div>
        <div className="flex items-center gap-4 text-[10px] uppercase tracking-widest font-bold">
          <span className="text-accent-foreground bg-accent px-2 py-1 border-2 border-foreground">✓ {counts.approved}</span>
          <span className="text-destructive-foreground bg-destructive px-2 py-1 border-2 border-foreground">✗ {counts.disapproved}</span>
          <span className="text-background bg-foreground px-2 py-1 border-2 border-foreground">used {counts.used}</span>
          <span className="text-muted-foreground border-2 border-foreground px-2 py-1">skip {counts.skipped}</span>
          <button
            onClick={onClose}
            className="border-2 border-foreground p-2 hover:bg-foreground hover:text-background"
            title="close (esc)"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Stage */}
      <div className="flex-1 flex flex-col items-center justify-center px-6 py-8 overflow-hidden">
        {loading ? (
          <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
        ) : done ? (
          <div className="text-center space-y-4">
            <div className="font-serif-display text-6xl">done.</div>
            <p className="text-sm text-muted-foreground uppercase tracking-widest">
              {counts.approved} approved · {counts.disapproved} rejected · {counts.used} used · {counts.skipped} skipped
            </p>
            <div className="flex gap-2 justify-center">
              <button
                onClick={load}
                className="border-2 border-foreground px-4 py-2 text-xs uppercase tracking-widest font-bold hover:bg-foreground hover:text-background"
              >
                reload queue
              </button>
              <button
                onClick={onClose}
                className="border-2 border-foreground px-4 py-2 text-xs uppercase tracking-widest font-bold hover:bg-foreground hover:text-background"
              >
                close
              </button>
            </div>
          </div>
        ) : (
          <div className="relative w-full max-w-md aspect-square">
            {/* Preload next two underneath */}
            {next2 && (
              <img
                src={thumbUrl(next2.storage_path, 500)}
                className="absolute inset-0 w-full h-full object-cover border-2 border-foreground opacity-30 scale-[0.92] translate-y-4"
                alt=""
                aria-hidden
              />
            )}
            {next1 && (
              <img
                src={thumbUrl(next1.storage_path, 500)}
                className="absolute inset-0 w-full h-full object-cover border-2 border-foreground opacity-60 scale-95 translate-y-2"
                alt=""
                aria-hidden
              />
            )}
            {current && (
              <div
                className={`absolute inset-0 transition-all duration-150 ease-out ${animClass}`}
              >
                <img
                  src={thumbUrl(current.storage_path, 600)}
                  alt={current.artist_name}
                  className="w-full h-full object-cover border-2 border-foreground shadow-brutal-lg bg-secondary"
                  draggable={false}
                />
                <div className="absolute top-3 left-3 bg-background border-2 border-foreground px-2 py-1 text-[10px] uppercase tracking-widest font-bold">
                  {current.artist_name}
                </div>
                {current.songs.length > 0 && (
                  <div className="absolute top-3 right-3 bg-background border-2 border-foreground px-2 py-1 text-[10px] uppercase tracking-widest text-muted-foreground max-w-[60%] truncate">
                    {current.songs.slice(0, 3).join(" · ")}
                  </div>
                )}
                {current.song && (
                  <div className="absolute bottom-3 left-3 right-3 bg-background/90 border-2 border-foreground px-2 py-1 text-[10px] uppercase tracking-widest truncate">
                    {current.song}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Action bar / keymap */}
      {!done && !loading && (
        <div className="border-t-2 border-foreground px-6 py-4 flex items-center justify-center gap-3">
          <button
            onClick={() => advance("disapproved", "left")}
            className="flex items-center gap-2 border-2 border-foreground bg-background px-4 py-3 text-xs uppercase tracking-widest font-bold hover:bg-destructive hover:text-destructive-foreground"
          >
            <ArrowLeft className="w-4 h-4" /> reject
          </button>
          <button
            onClick={() => advance(null, "down")}
            className="border-2 border-foreground bg-background px-4 py-3 text-xs uppercase tracking-widest font-bold hover:bg-foreground hover:text-background"
          >
            skip (↓)
          </button>
          <button
            onClick={() => advance("used", "up")}
            className="flex items-center gap-2 border-2 border-foreground bg-background px-4 py-3 text-xs uppercase tracking-widest font-bold hover:bg-foreground hover:text-background"
          >
            <CheckCheck className="w-4 h-4" /> used (↑)
          </button>
          <button
            onClick={() => advance("approved", "right")}
            className="flex items-center gap-2 border-2 border-foreground bg-background px-4 py-3 text-xs uppercase tracking-widest font-bold hover:bg-accent hover:text-accent-foreground"
          >
            approve <ArrowRight className="w-4 h-4" />
          </button>
        </div>
      )}
    </div>
  );
}