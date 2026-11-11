// Her tarayıcıya rastgele, anonim bir kimlik verilir; denetim kaydında aynı tarayıcının
// hareketlerini birbirine bağlamak için kullanılır. Kullanıcıdan isim istenmez.
const K_VISITOR = "sre-portal:visitor";

function safeGet(k: string): string | null {
  try { return localStorage.getItem(k); } catch { return null; }
}
function safeSet(k: string, v: string) {
  try { localStorage.setItem(k, v); } catch { /* özel pencere vb. */ }
}

let visitor = safeGet(K_VISITOR);
if (!visitor) {
  visitor = (crypto.randomUUID?.() ?? Math.random().toString(36).slice(2)) as string;
  safeSet(K_VISITOR, visitor);
}
// Agent arayüzlerine (/cloudwatch/, /eks/) giden istekler de aynı tarayıcıya bağlansın diye çerez.
document.cookie = `portal_visitor=${visitor}; Path=/; SameSite=Lax; Max-Age=31536000`;

export const identity = {
  visitor: visitor!,
  headers(): Record<string, string> {
    return { "X-Portal-Visitor": visitor! };
  },
};
