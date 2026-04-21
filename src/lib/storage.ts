import { supabase } from "@/integrations/supabase/client";

export function publicUrl(path: string) {
  return supabase.storage.from("artist-images").getPublicUrl(path).data.publicUrl;
}

export async function fetchImageBlob(path: string) {
  const res = await fetch(publicUrl(path));

  if (!res.ok) {
    throw new Error(`file fetch failed (${res.status})`);
  }

  const contentType = res.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("image/")) {
    throw new Error("file is not an image");
  }

  const blob = await res.blob();
  if (!blob.size) {
    throw new Error("image file is empty");
  }

  return blob;
}