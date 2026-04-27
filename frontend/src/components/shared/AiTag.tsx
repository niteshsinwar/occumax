type AiTagProps = {
  className?: string;
};

export function AiTag({ className }: AiTagProps) {
  const base =
    "inline-flex items-center text-[9px] font-bold uppercase tracking-widest px-2 py-0.5 border border-accent/30 bg-accent/10 text-accent";
  return <span className={className ? `${base} ${className}` : base}>AI</span>;
}

