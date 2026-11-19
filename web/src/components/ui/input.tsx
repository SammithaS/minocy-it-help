import type { InputHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        "min-h-11 w-full rounded-2xl border border-control bg-card px-4 text-sm text-ink placeholder:text-muted focus:border-brand-700 focus:outline-none",
        className,
      )}
      {...props}
    />
  );
}
