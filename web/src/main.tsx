import { StrictMode, Suspense, lazy } from "react";
import { createRoot } from "react-dom/client";
import { HashRouter, Navigate, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/500.css";
import "@fontsource/ibm-plex-sans/600.css";
import "@fontsource/ibm-plex-sans/700.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "./index.css";
import Layout from "./components/Layout";
import { Loading } from "./components/ui";
import { installClickTracking } from "./lib/audit";
import { applyTheme, getTheme } from "./lib/theme";

const Overview = lazy(() => import("./pages/Overview"));
const Alerts = lazy(() => import("./pages/Alerts"));
const RuleDetail = lazy(() => import("./pages/RuleDetail"));
const Incidents = lazy(() => import("./pages/Incidents"));
const IncidentDetail = lazy(() => import("./pages/IncidentDetail"));
const Slo = lazy(() => import("./pages/Slo"));
const SloDetail = lazy(() => import("./pages/SloDetail"));
const Value = lazy(() => import("./pages/Value"));
const Changes = lazy(() => import("./pages/Changes"));
const Admin = lazy(() => import("./pages/Admin"));
const Cluster = lazy(() => import("./pages/Cluster"));
const Work = lazy(() => import("./pages/Work"));

applyTheme(getTheme());
installClickTracking();

const qc = new QueryClient({
  defaultOptions: { queries: { staleTime: 60_000, retry: 1, refetchOnWindowFocus: false } },
});

// HashRouter: sayfalar "/#/alerts" gibi açılır; böylece nginx'teki agent proxy kuralına düşmez.
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={qc}>
      <HashRouter>
        <Suspense fallback={<div className="px-8"><Loading /></div>}>
          <Routes>
            <Route element={<Layout />}>
              <Route index element={<Overview />} />
              <Route path="alerts" element={<Alerts />} />
              <Route path="alerts/:org/:uid" element={<RuleDetail />} />
              <Route path="incidents" element={<Incidents />} />
              <Route path="incidents/:id" element={<IncidentDetail />} />
              <Route path="slo" element={<Slo />} />
              <Route path="slo/:service" element={<SloDetail />} />
              <Route path="value" element={<Value />} />
              <Route path="changes" element={<Changes />} />
              <Route path="cluster" element={<Cluster />} />
              <Route path="work" element={<Work />} />
              <Route path="admin" element={<Admin />} />
              <Route path="gelen-alertler" element={<Navigate to="/alerts" replace />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Route>
          </Routes>
        </Suspense>
      </HashRouter>
    </QueryClientProvider>
  </StrictMode>,
);
