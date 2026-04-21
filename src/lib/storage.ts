import { supabase } from "@/integrations/supabase/client";

export function publicUrl(path: string) {
  return supabase.storage.from("artist-images").getPublicUrl(path).data.publicUrl;
}