import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../api";

/**
 * /convite#token: o token vem no fragmento da URL, que o navegador não manda para o servidor
 * (não aparece em log nem no Referer). Lê, limpa da barra de endereço e aceita.
 */
export function AcceptInvite() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [error, setError] = useState("");
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return; // StrictMode roda o efeito duas vezes em dev; o convite é de uso único
    started.current = true;
    const token = location.hash.slice(1);
    history.replaceState(null, "", "/convite");
    if (!token) return setError("Link de convite incompleto. Peça um novo para quem convidou.");
    api.acceptLink(token).then(
      (r) => {
        qc.invalidateQueries({ queryKey: ["workspaces"] });
        navigate(`/w/${r.workspaceId}`, { replace: true });
      },
      (e: Error) => setError(e.message),
    );
  }, [navigate, qc]);

  return error ? <p className="error card" role="alert">{error}</p> : <p className="muted" role="status">Entrando no workspace…</p>;
}
