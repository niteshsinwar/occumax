import { useEffect, useState, useCallback } from "react";
import { CheckCircle2, AlertCircle, Info } from "lucide-react";

interface ToastProps {
  message: string;
  type?: "info" | "success" | "error";
  onClose: () => void;
  duration?: number;
}

export function Toast({ message, type = "info", onClose, duration = 4000 }: ToastProps) {
  useEffect(() => {
    const t = setTimeout(onClose, duration);
    return () => clearTimeout(t);
  }, [onClose, duration]);

  const config = {
    info:    { icon: <Info className="w-4 h-4 text-accent" />, color: "border-accent", bg: "bg-surface" },
    success: { icon: <CheckCircle2 className="w-4 h-4 text-occugreen" />, color: "border-occugreen", bg: "bg-surface" },
    error:   { icon: <AlertCircle className="w-4 h-4 text-occured" />, color: "border-occured", bg: "bg-surface" },
  };

  const { icon, color, bg } = config[type];

  return (
    <div className={`${bg} border border-border border-l-4 ${color} rounded-sm px-6 py-4 flex items-center gap-4 text-sm font-semibold shadow-subtle animate-in slide-in-from-bottom-5 fade-in duration-300 transform min-w-[300px]`}>
      <div className="shrink-0">{icon}</div>
      <div className="text-text tracking-wide">{message}</div>
    </div>
  );
}

let _toastSeq = 0;

// Global toast state hook
export function useToast() {
  const [toasts, setToasts] = useState<Array<{ id: number; message: string; type: "info" | "success" | "error" }>>([]);

  const show = useCallback((message: string, type: "info" | "success" | "error" = "info") => {
    const id = ++_toastSeq;
    setToasts((prev) => [...prev, { id, message, type }]);
  }, []);

  const remove = useCallback((id: number) => setToasts((prev) => prev.filter((t) => t.id !== id)), []);

  const Toasts = () => (
    <div className="fixed bottom-10 right-10 flex flex-col items-end gap-3 z-[1000]">
      {toasts.map((t) => (
        <Toast key={t.id} message={t.message} type={t.type} onClose={() => remove(t.id)} />
      ))}
    </div>
  );

  return { show, Toasts };
}
