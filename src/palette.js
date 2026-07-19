/* ============================================================
   ThreadThink — Color Palette
   ============================================================ */

export const PALETTE = [
  { name:'amber',  bg:'#fff8e1', border:'#ff8f00', header:'#e65100', badge:'#bf360c', dot:'#ff8f00' },
  { name:'green',  bg:'#e8f5e9', border:'#43a047', header:'#2e7d32', badge:'#1b5e20', dot:'#66bb6a' },
  { name:'blue',   bg:'#e3f2fd', border:'#1e88e5', header:'#1565c0', badge:'#0d47a1', dot:'#42a5f5' },
  { name:'pink',   bg:'#fce4ec', border:'#e91e63', header:'#ad1457', badge:'#880e4f', dot:'#ec407a' },
  { name:'purple', bg:'#f3e5f5', border:'#8e24aa', header:'#6a1b9a', badge:'#4a148c', dot:'#ab47bc' },
  { name:'teal',   bg:'#e0f2f1', border:'#00897b', header:'#00695c', badge:'#004d40', dot:'#26a69a' },
];

export function getColor(index) {
  return PALETTE[index % PALETTE.length];
}
