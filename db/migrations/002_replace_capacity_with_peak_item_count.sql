-- Bins are no longer manually created with a predetermined capacity — any bin number
-- can be opened in Intake, auto-creating the row. Consolidation suggestions now compare
-- current occupancy against peak_item_count, a self-computed high-water mark snapshotted
-- when a bin is closed (see routes/admin.js's POST /intake/close), instead of a
-- manually-typed guess.
ALTER TABLE bins DROP COLUMN capacity;
ALTER TABLE bins ADD COLUMN peak_item_count INTEGER NOT NULL DEFAULT 0;
