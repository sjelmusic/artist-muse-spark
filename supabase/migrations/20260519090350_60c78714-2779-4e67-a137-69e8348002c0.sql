CREATE TABLE IF NOT EXISTS public.app_settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.app_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "public read app_settings" ON public.app_settings FOR SELECT USING (true);
CREATE POLICY "public insert app_settings" ON public.app_settings FOR INSERT WITH CHECK (true);
CREATE POLICY "public update app_settings" ON public.app_settings FOR UPDATE USING (true);
CREATE POLICY "public delete app_settings" ON public.app_settings FOR DELETE USING (true);