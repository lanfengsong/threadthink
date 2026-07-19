/* ============================================================
   ThreadThink Server — Crypto Service (API Key encryption)
   ============================================================ */

import crypto from 'crypto';
import { config } from '../config.js';

var ALGORITHM = 'aes-256-gcm';
var KEY_LENGTH = 32;

function getKey() {
  var key = Buffer.from(config.encryptionSecret, 'utf-8');
  if (key.length < KEY_LENGTH) {
    // Pad or hash to 32 bytes
    return crypto.createHash('sha256').update(config.encryptionSecret).digest();
  }
  return key.slice(0, KEY_LENGTH);
}

export function encrypt(plaintext) {
  if (!plaintext) return null;
  var key = getKey();
  var iv = crypto.randomBytes(16);
  var cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  var encrypted = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);
  var tag = cipher.getAuthTag();

  // Format: iv:tag:ciphertext (all base64)
  return iv.toString('base64') + ':' + tag.toString('base64') + ':' + encrypted.toString('base64');
}

export function decrypt(ciphertext) {
  if (!ciphertext) return null;
  var parts = ciphertext.split(':');
  if (parts.length !== 3) return null;

  var key = getKey();
  var iv = Buffer.from(parts[0], 'base64');
  var tag = Buffer.from(parts[1], 'base64');
  var encrypted = Buffer.from(parts[2], 'base64');

  var decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);

  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf-8');
}
