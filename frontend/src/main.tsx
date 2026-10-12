import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter } from "react-router";
import { ApiError } from "./api";
import { App } from "./App";
import { initConsent } from "./consent";
import "@xyflow/react/dist/style.css";
import "./styles.css";

/** Sessão expirou em qualquer chamada: volta para o login guardando onde a pessoa estava. */
function onError(err: unknown) {
  if (err instanceof ApiError && err.status === 401 && !location.pathname.startsWith("/entrar")) {
    location.assign(`/entrar?voltar=${encodeURIComponent(location.pathname + location.search)}`);
  }
}

const queryClient = new QueryClient({
  queryCache: new QueryCache({ onError }),
  mutationCache: new MutationCache({ onError }),
  defaultOptions: {
    // 4xx não melhora tentando de novo; falha de rede/5xx tenta mais uma vez
    queries: { retry: (n, err) => !(err instanceof ApiError && err.status >= 400 && err.status < 500) && n < 1, staleTime: 5_000 },
  },
});

initConsent("/privacidade.html");

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
