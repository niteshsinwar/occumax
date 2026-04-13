import { BrowserRouter, Routes, Route, NavLink, Navigate } from "react-router-dom";
import { ManagerDashboard } from "./pages/ManagerDashboard";
import { Dashboard } from "./pages/Dashboard";
import { ReceptionistView } from "./pages/ReceptionistView";
import { AdminPanel } from "./pages/AdminPanel";
import { LayoutDashboard, Users, Settings, Grid3x3 } from "lucide-react";

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
      {/* Top Navigation Bar */}
      <header className="bg-surface border-b border-border sticky top-0 z-[100] shadow-sm">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between items-center h-[72px]">
            <div className="flex items-center gap-10 h-full">
              <div className="text-[26px] font-serif font-black text-text tracking-wide uppercase">
                Opti<span className="text-accent italic font-light">host</span>
              </div>
              <nav className="flex items-center gap-8 hidden md:flex h-full pt-1">
                <NavLink
                  to="/manager"
                  className={({ isActive }) => `flex items-center gap-2 h-full border-b-[3px] font-bold transition-colors text-[11px] uppercase tracking-[0.15em] ${isActive ? "border-accent text-accent" : "border-transparent text-text-muted hover:text-text hover:border-text/20"}`}
                >
                  <LayoutDashboard className="w-4 h-4" /> Manager
                </NavLink>
                <NavLink
                  to="/dashboard"
                  className={({ isActive }) => `flex items-center gap-2 h-full border-b-[3px] font-bold transition-colors text-[11px] uppercase tracking-[0.15em] ${isActive ? "border-accent text-accent" : "border-transparent text-text-muted hover:text-text hover:border-text/20"}`}
                >
                  <Grid3x3 className="w-4 h-4" /> Dashboard
                </NavLink>
                <NavLink
                  to="/receptionist"
                  className={({ isActive }) => `flex items-center gap-2 h-full border-b-[3px] font-bold transition-colors text-[11px] uppercase tracking-[0.15em] ${isActive ? "border-accent text-accent" : "border-transparent text-text-muted hover:text-text hover:border-text/20"}`}
                >
                  <Users className="w-4 h-4" /> Receptionist
                </NavLink>
                <NavLink
                  to="/admin"
                  className={({ isActive }) => `flex items-center gap-2 h-full border-b-[3px] font-bold transition-colors text-[11px] uppercase tracking-[0.15em] ${isActive ? "border-accent text-accent" : "border-transparent text-text-muted hover:text-text hover:border-text/20"}`}
                >
                  <Settings className="w-4 h-4" /> Admin
                </NavLink>
              </nav>
            </div>
            <div className="flex items-center">
              <div className="text-[9px] font-bold text-text-muted uppercase tracking-[0.2em] bg-surface-2 px-4 py-1.5 rounded-sm border border-border shadow-subtle relative overflow-hidden">
                <div className="absolute top-0 left-0 w-1 h-full bg-text" />
                V2 Yield Operations
              </div>
            </div>
          </div>
        </div>
      </header>
      
      {/* Main Content Area */}
      <main className="flex-1 w-full max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-10">
        <div className="bg-surface rounded-sm shadow-subtle border border-border/70 border-t-4 border-t-accent p-8 sm:p-10 min-h-[600px] relative">
          <Routes>
            <Route path="/" element={<Navigate to="/manager" replace />} />
            <Route path="/manager" element={<ManagerDashboard />} />
            <Route path="/dashboard" element={<Dashboard />} />
            <Route path="/receptionist" element={<ReceptionistView />} />
            <Route path="/admin" element={<AdminPanel />} />
            <Route path="*" element={<Navigate to="/manager" replace />} />
          </Routes>
        </div>
      </main>

      {/* Luxury Footer */}
      <footer className="bg-surface border-t border-border mt-auto w-full">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
            <div>
              <div className="text-xl font-serif font-black text-text tracking-wide uppercase mb-4">
                Opti<span className="text-accent italic font-light">host</span>
              </div>
              <p className="text-xs text-text-muted font-medium leading-relaxed max-w-xs">
                The pinnacle of deterministic property yield engineering. Harness the power of continuous combinatorial algorithms to eliminate fragmentation and achieve absolute matrix convergence.
              </p>
            </div>
            <div className="md:ml-auto">
              <h4 className="font-bold text-[10px] text-text uppercase tracking-[0.15em] mb-4">System</h4>
              <ul className="space-y-2 text-xs font-medium text-text-muted">
                <li>V2 Matrix Optimization Engine</li>
                <li>Zero-Latency Booking Resolution</li>
                <li>HHI Automated Reallocation</li>
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
            <p>&copy; {new Date().getFullYear()} Genius Hacks • Art Royalty & Aesthetics</p>
            <p className="mt-2 md:mt-0">Confidential · Enterprise Class Infrastructure</p>
          </div>
        </div>
      </footer>
    </div>
  );
}
