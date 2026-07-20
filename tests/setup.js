/* ============================================================
   Test Setup — provides DOM APIs in Node.js environment
   ============================================================ */

import { JSDOM } from 'jsdom';

var dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
  url: 'http://localhost',
});
globalThis.document = dom.window.document;
globalThis.window = dom.window;
