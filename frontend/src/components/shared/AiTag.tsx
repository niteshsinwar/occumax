type AiTagProps = {
  className?: string;
  /** Hover help explaining how AI is used in this UI. */
  title?: string;
};

export function AiTag({ className, title }: AiTagProps) {
  const base =
    "inline-flex items-center text-[9px] font-bold uppercase tracking-widest px-2 py-0.5 border border-accent/30 bg-accent/10 text-accent";
  return (
    <span
      className={className ? `${base} ${className}` : base}
      title={title ?? "AI-assisted"}
    >
      AI
    </span>
  );
}

