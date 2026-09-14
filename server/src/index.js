/* ============================================================
   ThreadThink Server — Entry Point
   ============================================================ */

import { startServer } from './app.js';

startServer().catch(function (err) {
  console.error(err);
  process.exit(1);
});
