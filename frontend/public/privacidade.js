// Fora do HTML: a CSP do servidor não deixa rodar script inline.
document.getElementById("rever").addEventListener("click", () => {
  try { localStorage.removeItem("consent-analytics"); } catch { /* modo privado */ }
  document.getElementById("ok").textContent = "Pronto: o aviso aparece de novo na próxima visita.";
});
