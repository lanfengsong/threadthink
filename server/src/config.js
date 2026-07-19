/* ============================================================
   ThreadThink Server — Configuration
   ============================================================ */

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

var __dirname = dirname(fileURLToPath(import.meta.url));
var rootDir = resolve(__dirname, '../..');

// Load .env if exists (simple loader, no dotenv dependency)
try {
  var envPath = resolve(rootDir, '.env');
  var envContent = readFileSync(envPath, 'utf-8');
  envContent.split('\n').forEach(function (line) {
    var trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    var eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) return;
    var key = trimmed.slice(0, eqIdx).trim();
    var val = trimmed.slice(eqIdx + 1).trim();
    if (!process.env[key]) process.env[key] = val;
  });
} catch (e) { /* .env not found, use env vars directly */ }

export var config = {
  port: parseInt(process.env.PORT, 10) || 3000,
  host: process.env.HOST || '0.0.0.0',

  // JWT
  jwtSecret: process.env.JWT_SECRET || 'dev-secret-change-in-production',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '7d',

  // Encryption for API keys
  encryptionSecret: process.env.ENCRYPTION_SECRET || 'dev-encryption-key-32chars!!',

  // Database
  dbPath: process.env.DB_PATH || resolve(rootDir, 'data', 'threadthink.db'),

  // CORS
  corsOrigin: process.env.CORS_ORIGIN || 'http://localhost:5173',
};
