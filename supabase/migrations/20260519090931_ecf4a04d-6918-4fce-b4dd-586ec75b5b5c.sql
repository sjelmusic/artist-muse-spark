ALTER TABLE public.generated_images
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'new';

UPDATE public.generated_images SET status = 'used' WHERE used = true;
UPDATE public.generated_images SET status = 'approved' WHERE liked = true AND used = false;

CREATE INDEX IF NOT EXISTS generated_images_status_idx ON public.generated_images (artist_id, status);