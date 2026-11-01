-- Recruitment: the candidate's thumb impression, and certificates tied to the qualification they
-- prove (ref_key: the education level such as GRADUATION or BED, or the test such as CTET), so the
-- school sees each degree's certificate beside it. Additive only.
alter table candidate_document drop constraint candidate_document_kind_check;
alter table candidate_document add constraint candidate_document_kind_check
  check (kind in ('PHOTO', 'SIGNATURE', 'THUMB', 'ID_PROOF', 'EDUCATION', 'CATEGORY', 'PWD', 'ESM', 'EXPERIENCE', 'TEST', 'OTHER'));
alter table candidate_document add column ref_key text check (ref_key is null or ref_key ~ '^[A-Z_]{2,20}$');
