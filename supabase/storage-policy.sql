-- Storage bucket policy for attachments
-- Run this in the Supabase Dashboard SQL Editor AFTER creating the 'attachments' bucket.

-- Users can upload to their own folder
CREATE POLICY "user_upload" ON storage.objects FOR INSERT
  WITH CHECK (bucket_id = 'attachments' AND (storage.foldername(name))[1] = auth.uid()::text);

-- Users can read their own files
CREATE POLICY "user_read" ON storage.objects FOR SELECT
  USING (bucket_id = 'attachments' AND (storage.foldername(name))[1] = auth.uid()::text);

-- Users can update (re-upload / upsert) their own files
CREATE POLICY "user_update" ON storage.objects FOR UPDATE
  USING (bucket_id = 'attachments' AND (storage.foldername(name))[1] = auth.uid()::text)
  WITH CHECK (bucket_id = 'attachments' AND (storage.foldername(name))[1] = auth.uid()::text);

-- Users can delete their own files
CREATE POLICY "user_delete" ON storage.objects FOR DELETE
  USING (bucket_id = 'attachments' AND (storage.foldername(name))[1] = auth.uid()::text);
