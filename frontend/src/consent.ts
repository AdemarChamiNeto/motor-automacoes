/**
 * Google Analytics 4 e Microsoft Clarity só depois do consentimento (LGPD).
 * Os IDs vêm de VITE_GA_ID e VITE_CLARITY_ID (são públicos: aparecem no HTML de qualquer site).
 * Sem nenhum ID configurado, nada é carregado e o aviso nem aparece.
 */
const GA_ID = import.meta.env.VITE_GA_ID as string | undefined;
const CLARITY_ID = import.meta.env.VITE_CLARITY_ID as string | undefined;
const KEY = "consent-analytics";

type Choice = "granted" | "denied";

const store = {
  get: (): Choice | null => {
    try {
      const v = localStorage.getItem(KEY);
      return v === "granted" || v === "denied" ? v : null;
    } catch {
      return null;
    }
  },
  set: (v: Choice) => {
    try { localStorage.setItem(KEY, v); } catch { /* modo privado: vale só nesta visita */ }
  },
};

let loaded = false;
function load() {
  if (loaded) return;
  loaded = true;
  if (GA_ID) {
    const s = document.createElement("script");
    s.async = true;
    s.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(GA_ID)}`;
    document.head.appendChild(s);
    const w = window as unknown as { dataLayer: unknown[]; gtag: (...a: unknown[]) => void };
    w.dataLayer = w.dataLayer || [];
    w.gtag = function gtag() { w.dataLayer.push(arguments); }; // eslint-disable-line prefer-rest-params
    w.gtag("consent", "default", { ad_storage: "denied", ad_user_data: "denied", ad_personalization: "denied", analytics_storage: "granted" });
    w.gtag("js", new Date());
    w.gtag("config", GA_ID, { anonymize_ip: true });
  }
  if (CLARITY_ID) {
    const w = window as unknown as { clarity: { (...a: unknown[]): void; q?: unknown[] } };
    w.clarity = w.clarity || function (...a: unknown[]) { (w.clarity.q = w.clarity.q || []).push(a); };
    const s = document.createElement("script");
    s.async = true;
    s.src = `https://www.clarity.ms/tag/${encodeURIComponent(CLARITY_ID)}`;
    document.head.appendChild(s);
  }
}

function banner(privacyUrl: string) {
  const el = document.createElement("div");
  el.setAttribute("role", "region");
  el.setAttribute("aria-label", "Aviso de cookies");
  el.style.cssText =
    "position:fixed;left:16px;right:16px;bottom:16px;z-index:9999;max-width:560px;margin:0 auto;padding:14px 16px;" +
    "border-radius:12px;background:#1b1b1f;color:#f4f4f5;font:14px/1.45 system-ui,sans-serif;box-shadow:0 10px 30px rgba(0,0,0,.35)";
  el.innerHTML =
    `<p style="margin:0 0 10px">Usamos cookies de estatística (Google Analytics e Microsoft Clarity) para entender como o site é usado. ` +
    `Nada é coletado sem a sua permissão. <a href="${privacyUrl}" style="color:#c4b5fd">Privacidade</a></p>` +
    `<div style="display:flex;gap:8px;justify-content:flex-end">` +
    `<button type="button" data-c="denied" style="padding:6px 12px;border-radius:8px;border:1px solid #52525b;background:transparent;color:inherit;cursor:pointer">Recusar</button>` +
    `<button type="button" data-c="granted" style="padding:6px 12px;border-radius:8px;border:0;background:#7c3aed;color:#fff;cursor:pointer">Aceitar</button></div>`;
  el.addEventListener("click", (e) => {
    const choice = (e.target as HTMLElement).dataset.c as Choice | undefined;
    if (!choice) return;
    store.set(choice);
    el.remove();
    if (choice === "granted") load();
  });
  document.body.appendChild(el);
}

/** Chamar uma vez na subida do app. */
export function initConsent(privacyUrl: string) {
  if (!GA_ID && !CLARITY_ID) return;
  const choice = store.get();
  if (choice === "granted") load();
  else if (choice === null) banner(privacyUrl);
}

/** Usado pela página de privacidade: apaga a escolha para o aviso aparecer de novo. */
export function resetConsent() {
  try { localStorage.removeItem(KEY); } catch { /* nada a fazer */ }
}
