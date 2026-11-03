"use strict";
function initializeMatchDeletionAudit(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS match_deletion_audit (
    match_id TEXT PRIMARY KEY, actor_id TEXT NOT NULL, deleted_at INTEGER NOT NULL,
    reason TEXT NOT NULL, markets TEXT NOT NULL, elo_outcome TEXT NOT NULL
  );
  CREATE TRIGGER IF NOT EXISTS match_deletion_audit_no_update BEFORE UPDATE ON match_deletion_audit BEGIN SELECT RAISE(ABORT,'Deletion audit is append-only'); END;
  CREATE TRIGGER IF NOT EXISTS match_deletion_audit_no_delete BEFORE DELETE ON match_deletion_audit BEGIN SELECT RAISE(ABORT,'Deletion audit is append-only'); END;`);
}
module.exports={initializeMatchDeletionAudit};
