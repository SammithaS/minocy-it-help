-- Custom migration: FTS5 keyword index over KB chunks (drizzle-kit can't model virtual tables).
-- One row per chunk; chunk_id matches the Vectorize vector id (e.g. 'KB-002#quick') so the
-- two result lists can be fused with Reciprocal Rank Fusion.
CREATE VIRTUAL TABLE `kb_fts` USING fts5(
  `chunk_id` UNINDEXED,
  `article_id` UNINDEXED,
  `section` UNINDEXED,
  `title`,
  `tags`,
  `content`,
  tokenize = 'porter unicode61 remove_diacritics 2'
);
