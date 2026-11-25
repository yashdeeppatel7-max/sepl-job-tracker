-- New PO status "RFD" (ready for despatch). Added on its own: a new enum value can only be used
-- after this change is committed (0020 uses it).
alter type job_status add value if not exists 'rfd' after 'in_progress';
