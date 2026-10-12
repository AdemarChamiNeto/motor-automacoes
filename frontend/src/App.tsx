import { lazy, Suspense } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { api, ApiError } from "./api";
import { Layout } from "./Layout";
import { Login } from "./pages/Login";

// o editor (React Flow) só baixa quando alguém abre um fluxo
const Editor = lazy(() => import("./pages/Editor").then((m) => ({ default: m.Editor })));
const Executions = lazy(() => import("./pages/Executions").then((m) => ({ default: m.Executions })));
const Workflows = lazy(() => import("./pages/Workflows").then((m) => ({ default: m.Workflows })));
const Credentials = lazy(() => import("./pages/Credentials").then((m) => ({ default: m.Credentials })));
const Members = lazy(() => import("./pages/Members").then((m) => ({ default: m.Members })));
const Account = lazy(() => import("./pages/Account").then((m) => ({ default: m.Account })));
const AcceptInvite = lazy(() => import("./pages/AcceptInvite").then((m) => ({ default: m.AcceptInvite })));

export const useMe = () =>
  useQuery({ queryKey: ["me"], queryFn: () => api.me().catch((e) => (e instanceof ApiError && e.status === 401 ? null : Promise.reject(e))) });

export const useWorkspaces = (enabled = true) => useQuery({ queryKey: ["workspaces"], queryFn: api.workspaces, enabled });

const Loading = () => <p className="center muted" role="status">Carregando…</p>;

/** Só entra logado; sem sessão, vai para o login e volta depois para a mesma página. */
function Private({ children }: { children: React.ReactNode }) {
  const me = useMe();
  const loc = useLocation();
  // isFetching: o cache pode ter um null antigo (antes do login) enquanto busca de novo
  if (me.isPending || (!me.data && me.isFetching)) return <Loading />;
  if (me.isError) return <p className="center error" role="alert">{(me.error as Error).message}</p>;
  if (!me.data) return <Navigate to={`/entrar?voltar=${encodeURIComponent(loc.pathname + loc.search + loc.hash)}`} replace />;
  return <>{children}</>;
}

/** "/" → primeiro workspace da pessoa. */
function Home() {
  const ws = useWorkspaces();
  if (ws.isPending) return <Loading />;
  const first = ws.data?.[0];
  return first ? <Navigate to={`/w/${first.id}`} replace /> : <Navigate to="/conta" replace />;
}

export function App() {
  return (
    <Suspense fallback={<Loading />}>
      <Routes>
        <Route path="/entrar" element={<Login />} />
        <Route path="/" element={<Private><Home /></Private>} />
        <Route element={<Private><Layout /></Private>}>
          <Route path="/w/:ws" element={<Workflows />} />
          <Route path="/w/:ws/credenciais" element={<Credentials />} />
          <Route path="/w/:ws/membros" element={<Members />} />
          <Route path="/w/:ws/fluxos/:id/execucoes" element={<Executions />} />
          <Route path="/conta" element={<Account />} />
          <Route path="/convite" element={<AcceptInvite />} />
        </Route>
        {/* o editor ocupa a tela toda */}
        <Route path="/w/:ws/fluxos/:id" element={<Private><Editor /></Private>} />
        <Route path="*" element={<p className="center">Página não encontrada. <a href="/">Voltar ao início</a></p>} />
      </Routes>
    </Suspense>
  );
}
