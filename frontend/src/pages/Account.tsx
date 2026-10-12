import { useEffect, useState, type FormEvent } from "react";
import { useNavigate } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import QRCode from "qrcode";
import { api } from "../api";
import { useMe } from "../App";
import { formatDate } from "../ui/format";

export function Account() {
  const me = useMe();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const received = useQuery({ queryKey: ["received-invites"], queryFn: api.receivedInvites });
  const accept = useMutation({
    mutationFn: api.acceptInvite,
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ["workspaces"] });
      navigate(`/w/${r.workspaceId}`);
    },
  });

  return (
    <>
      <header className="page-head"><h1>Minha conta</h1></header>
      <section className="card">
        <p><strong>{me.data?.name}</strong> · {me.data?.email}</p>
        {me.data?.demoExpiresAt && <p className="small muted">Conta de demonstração: some em {formatDate(me.data.demoExpiresAt)}. Para guardar seus fluxos, crie uma conta.</p>}
      </section>

      {received.data && received.data.length > 0 && (
        <section className="card" aria-labelledby="recebidos">
          <h2 id="recebidos">Convites para você</h2>
          <ul className="plain">
            {received.data.map((i) => (
              <li key={i.id} className="row">
                <span><strong>{i.workspace}</strong> · como {i.role}{i.invitedBy && ` · por ${i.invitedBy}`}</span>
                <button type="button" className="primary small" disabled={accept.isPending} onClick={() => accept.mutate(i.id)}>Aceitar</button>
              </li>
            ))}
          </ul>
          {accept.error && <p className="error" role="alert">{accept.error.message}</p>}
        </section>
      )}

      <TwoFactor enabled={!!me.data?.twoFactorEnabled} />
    </>
  );
}

/** 2FA opcional: QR code para o app autenticador, códigos de recuperação e desativar com senha + código. */
function TwoFactor({ enabled }: { enabled: boolean }) {
  const qc = useQueryClient();
  const [qr, setQr] = useState("");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [recovery, setRecovery] = useState<string[] | null>(null);
  const setup = useMutation({ mutationFn: api.setup2fa });
  const enable = useMutation({
    mutationFn: () => api.enable2fa(code.trim()),
    onSuccess: (r) => { setRecovery(r.recoveryCodes); setCode(""); setup.reset(); qc.invalidateQueries({ queryKey: ["me"] }); },
  });
  const disable = useMutation({
    mutationFn: () => api.disable2fa(password, code.trim()),
    onSuccess: () => { setPassword(""); setCode(""); qc.invalidateQueries({ queryKey: ["me"] }); },
  });

  useEffect(() => {
    if (!setup.data) return setQr("");
    QRCode.toDataURL(setup.data.otpauthUrl, { margin: 1, width: 200 }).then(setQr, () => setQr(""));
  }, [setup.data]);

  if (recovery) {
    return (
      <section className="card" aria-labelledby="rec">
        <h2 id="rec">Códigos de recuperação</h2>
        <p>Guarde num lugar seguro. Cada um entra <strong>uma vez</strong> se você perder o celular. Eles não serão mostrados de novo.</p>
        <ul className="codes" aria-label="Códigos de recuperação">{recovery.map((c) => <li key={c}><code>{c}</code></li>)}</ul>
        <button type="button" className="primary" onClick={() => setRecovery(null)}>Já guardei</button>
      </section>
    );
  }

  return (
    <section className="card stack" aria-labelledby="tfa">
      <h2 id="tfa">Verificação em duas etapas {enabled && <span className="badge s-succeeded">ativa</span>}</h2>
      {enabled ? (
        <form className="stack" onSubmit={(e: FormEvent) => { e.preventDefault(); disable.mutate(); }}>
          <p className="small muted">Para desativar, confirme a senha e um código do app (ou de recuperação).</p>
          <label htmlFor="d-pass">Senha</label>
          <input id="d-pass" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          <label htmlFor="d-code">Código</label>
          <input id="d-code" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} required />
          {disable.error && <p className="error" role="alert">{disable.error.message}</p>}
          <button className="danger ghost" disabled={disable.isPending}>Desativar</button>
        </form>
      ) : setup.data ? (
        <form className="stack" onSubmit={(e: FormEvent) => { e.preventDefault(); enable.mutate(); }}>
          <p className="small">Leia o QR code no Google Authenticator, Authy ou Microsoft Authenticator.</p>
          {qr && <img src={qr} width={200} height={200} alt="QR code para o app autenticador" />}
          <p className="small muted">Sem câmera? Digite a chave: <code className="secret">{setup.data.secret.replace(/(.{4})/g, "$1 ").trim()}</code></p>
          <label htmlFor="e-code">Digite o código de 6 dígitos do app</label>
          <input id="e-code" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} required />
          {enable.error && <p className="error" role="alert">{enable.error.message}</p>}
          <button className="primary" disabled={enable.isPending}>Confirmar e ativar</button>
        </form>
      ) : (
        <>
          <p className="small muted">Além da senha, o login pede um código do app autenticador no celular.</p>
          {setup.error && <p className="error" role="alert">{setup.error.message}</p>}
          <button type="button" className="primary" disabled={setup.isPending} onClick={() => setup.mutate()}>Ativar verificação em duas etapas</button>
        </>
      )}
    </section>
  );
}
