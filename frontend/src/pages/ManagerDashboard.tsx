import { Navigate } from "react-router-dom";

export function ManagerDashboard() {
  // Manager tab was removed for the hackathon demo flow. Keep this route safe for legacy links.
  return <Navigate to="/dashboard" replace />;
}
