/* ============================================================
   ThreadThink Server — SQLite Connection
   ============================================================ */

import Database from 'better-sqlite3';
import { config } from '../config.js';
import { migrate } from './migrate.js';
import { mkdirSync } from 'fs';
import { dirname } from 'path';

var db = null;

export function getDb() {
  if (db) return db;

  // Ensure directory exists
  var dir = dirname(config.dbPath);
  mkdirSync(dir, { recursive: true });

  db = new Database(config.dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  migrate(db);

  return db;
}

export function closeDb() {
  if (db) { db.close(); db = null; }
}
