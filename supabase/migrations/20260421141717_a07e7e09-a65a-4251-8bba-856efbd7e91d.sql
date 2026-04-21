
-- Artists table
CREATE TABLE public.artists (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  name TEXT NOT NULL,
  songs TEXT[] NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending', -- pending, headshots_ready, reference_chosen, variants_ready
  reference_image_id UUID,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Generated images table
CREATE TABLE public.generated_images (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  artist_id UUID NOT NULL REFERENCES public.artists(id) ON DELETE CASCADE,
  storage_path TEXT NOT NULL,
  kind TEXT NOT NULL, -- 'headshot' | 'variant'
  song TEXT,
  prompt TEXT,
  is_reference BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

CREATE INDEX idx_images_artist ON public.generated_images(artist_id);

ALTER TABLE public.artists ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.generated_images ENABLE ROW LEVEL SECURITY;

-- Public shared workspace: anyone can do anything
CREATE POLICY "public read artists" ON public.artists FOR SELECT USING (true);
CREATE POLICY "public insert artists" ON public.artists FOR INSERT WITH CHECK (true);
CREATE POLICY "public update artists" ON public.artists FOR UPDATE USING (true);
CREATE POLICY "public delete artists" ON public.artists FOR DELETE USING (true);

CREATE POLICY "public read images" ON public.generated_images FOR SELECT USING (true);
CREATE POLICY "public insert images" ON public.generated_images FOR INSERT WITH CHECK (true);
CREATE POLICY "public update images" ON public.generated_images FOR UPDATE USING (true);
CREATE POLICY "public delete images" ON public.generated_images FOR DELETE USING (true);

-- Storage bucket for generated images
INSERT INTO storage.buckets (id, name, public) VALUES ('artist-images', 'artist-images', true);

CREATE POLICY "public read artist-images" ON storage.objects FOR SELECT USING (bucket_id = 'artist-images');
CREATE POLICY "public upload artist-images" ON storage.objects FOR INSERT WITH CHECK (bucket_id = 'artist-images');
CREATE POLICY "public update artist-images" ON storage.objects FOR UPDATE USING (bucket_id = 'artist-images');
CREATE POLICY "public delete artist-images" ON storage.objects FOR DELETE USING (bucket_id = 'artist-images');
