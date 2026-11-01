-- School websites: PDFs (almanac, mandatory disclosure, forms) as well as photos, and larger photos
-- for banners and sliders. Additive only.
alter table site_asset drop constraint site_asset_content_type_check;
alter table site_asset add constraint site_asset_content_type_check check (content_type in ('image/png', 'image/jpeg', 'image/webp', 'application/pdf'));
alter table site_asset drop constraint site_asset_bytes_check;
alter table site_asset add constraint site_asset_bytes_check check (octet_length(bytes) between 1 and 10485760);
