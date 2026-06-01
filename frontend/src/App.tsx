import { BrowserRouter, Routes, Route, NavLink, Navigate } from "react-router-dom";
import { Dashboard } from "./pages/Dashboard";
import { DashboardV2 } from "./pages/DashboardV2";
import { ReceptionistView } from "./pages/ReceptionistView";
import { BookingView } from "./pages/BookingView";
import { AdminPanel } from "./pages/AdminPanel";
import { Users, Settings, Grid3x3, CalendarCheck } from "lucide-react";
import type { ReactNode } from "react";

/** Padded main + white content card for routes that are not the full-bleed Overview (/dashboard). */
function PageShell({ children }: { children: ReactNode }) {
  return (
    <main className="flex-1 w-full max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-10">
      <div className="bg-surface rounded-sm shadow-subtle border border-border/70 border-t-4 border-t-accent p-8 sm:p-10 min-h-[600px] relative">
        {children}
      </div>
    </main>
  );
}

/** Top Level Application Shell */
export default function App() {
  return (
    <BrowserRouter>
      <AppLayout />
    </BrowserRouter>
  );
}

function AppLayout() {
  return (
    <div className="flex flex-col min-h-screen bg-bg">
      {/* Top Navigation Bar — dark chrome (OPTIHOST mockup) */}
      <header className="bg-nav border-b border-nav-border sticky top-0 z-[100] shadow-[0_4px_24px_rgba(0,0,0,0.25)]">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between items-center h-[72px]">
            <div className="flex items-center gap-10 h-full">
              <div className="flex items-center gap-3">
                <img src="/favicon.png" alt="Optihost Logo" className="w-8 h-8 rounded-md shadow-sm" />
                <div className="text-[26px] font-serif font-black text-occuyellow tracking-wide uppercase">
                  Opti<span className="text-accent italic font-light">host</span>
                </div>
              </div>
              <nav className="flex items-center gap-8 hidden md:flex h-full pt-1">
                <NavLink
                  to="/dashboard"
                  className={({ isActive }) =>
                    `flex items-center gap-2 h-full border-b-[3px] font-bold transition-colors text-[11px] uppercase tracking-[0.15em] ${isActive ? "border-occuyellow text-occuyellow" : "border-transparent text-nav-muted hover:text-[#E8E0D8] hover:border-white/15"}`
                  }
                >
                  <Grid3x3 className="w-4 h-4 shrink-0" /> Overview
                </NavLink>
                <NavLink
                  to="/receptionist"
                  className={({ isActive }) =>
                    `flex items-center gap-2 h-full border-b-[3px] font-bold transition-colors text-[11px] uppercase tracking-[0.15em] ${isActive ? "border-occuyellow text-occuyellow" : "border-transparent text-nav-muted hover:text-[#E8E0D8] hover:border-white/15"}`
                  }
                >
                  <Users className="w-4 h-4 shrink-0" /> Front Desk
                </NavLink>
                <NavLink
                  to="/admin"
                  className={({ isActive }) =>
                    `flex items-center gap-2 h-full border-b-[3px] font-bold transition-colors text-[11px] uppercase tracking-[0.15em] ${isActive ? "border-occuyellow text-occuyellow" : "border-transparent text-nav-muted hover:text-[#E8E0D8] hover:border-white/15"}`
                  }
                >
                  <Settings className="w-4 h-4 shrink-0" /> Settings
                </NavLink>
              </nav>
            </div>
            <div className="flex items-center gap-3">
              <NavLink
                to="/booking"
                className={({ isActive }) =>
                  `hidden sm:inline-flex items-center gap-2 rounded-full border px-4 py-1.5 text-[9px] font-bold uppercase tracking-[0.18em] transition-colors ${
                    isActive
                      ? "border-occuyellow bg-occuyellow text-nav"
                      : "border-white/15 bg-nav-elevated/80 text-[#E8E0D8] hover:border-occuyellow/50 hover:text-occuyellow"
                  }`
                }
              >
                <CalendarCheck className="w-3.5 h-3.5 shrink-0" /> Website Preview
              </NavLink>

            </div>
          </div>
        </div>
      </header>

      <Routes>
        <Route path="/" element={<Navigate to="/dashboard" replace />} />
        <Route path="/manager" element={<Navigate to="/dashboard" replace />} />
        <Route
          path="/dashboard"
          element={
            <main className="flex-1 w-full flex flex-col min-h-0">
              <Dashboard />
            </main>
          }
        />
        <Route
          path="/dashboard-v2"
          element={
            <PageShell>
              <DashboardV2 />
            </PageShell>
          }
        />
        <Route
          path="/receptionist"
          element={
            <PageShell>
              <ReceptionistView />
            </PageShell>
          }
        />
        <Route
          path="/booking"
          element={
            <main className="flex-1 w-full">
              <BookingView />
            </main>
          }
        />
        <Route
          path="/admin"
          element={
            <PageShell>
              <AdminPanel />
            </PageShell>
          }
        />
        <Route path="*" element={<Navigate to="/dashboard" replace />} />
      </Routes>

      {/* Luxury Footer */}
      <footer className="bg-surface border-t border-border mt-auto w-full">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
            <div>
              <div className="flex items-center gap-3 mb-4">
                <img src="/favicon.png" alt="Optihost Logo" className="w-6 h-6 rounded-sm shadow-sm opacity-80" />
                <div className="text-xl font-serif font-black text-text tracking-wide uppercase">
                  Opti<span className="text-accent italic font-light">host</span>
                </div>
              </div>
              <p className="text-xs text-text-muted font-medium leading-relaxed max-w-xs">
                Smart booking and revenue management for independent hotels. Fill more rooms, earn more per room, spend less time on admin.
              </p>
            </div>
            <div className="md:ml-auto">
              <h4 className="font-bold text-[10px] text-text uppercase tracking-[0.15em] mb-4">System</h4>
              <ul className="space-y-2 text-xs font-medium text-text-muted">
                <li>AI-powered room optimisation</li>
                <li>Dynamic pricing recommendations</li>
                <li>Occupancy forecasting & analytics</li>
                <li>AI front desk assistant</li>
              </ul>
            </div>
            <div className="md:ml-auto">
              <h4 className="font-bold text-[10px] text-text uppercase tracking-[0.15em] mb-4">Diagnostic</h4>
              <ul className="space-y-2 text-xs font-medium text-text-muted">
                <li><span className="inline-block w-2 h-2 rounded-full bg-occugreen mr-2" /> Database Concurrency</li>
                <li><span className="inline-block w-2 h-2 rounded-full bg-occugreen mr-2" /> Yield Syncing Active</li>
                <li>Last cycle: {(new Date()).toISOString().split('T')[0]}</li>
              </ul>
            </div>
          </div>
          <div className="border-t border-border mt-10 pt-6 flex flex-col md:flex-row justify-between items-center text-[10px] uppercase font-bold tracking-widest text-text-muted">
            <p>&copy; {new Date().getFullYear()} Optihost · Built for independent hotels</p>
            <p className="mt-2 md:mt-0">Made with care for hospitality</p>
          </div>
        </div>
      </footer>
    </div>
  );
}
