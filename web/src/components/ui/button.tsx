import { cva, type VariantProps } from "class-variance-authority";
import type { ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

export const buttonVariants = cva(
  "inline-flex min-h-11 items-center justify-center gap-2 rounded-full px-5 text-sm font-bold transition-colors disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        primary: "bg-brand-700 text-on-brand hover:bg-brand-800",
        dark: "bg-ink-surface text-white hover:opacity-90",
        sun: "bg-sun text-[#0F1B2D] hover:bg-sun-hover",
        outline: "border border-control bg-card text-ink hover:bg-canvas",
        ghost: "text-ink hover:bg-canvas",
        danger: "bg-critical text-white hover:opacity-90",
      },
      size: {
        sm: "min-h-9 px-3.5 text-xs",
        md: "",
        lg: "min-h-12 px-6 text-base",
        icon: "size-11 px-0",
      },
    },
    defaultVariants: { variant: "primary", size: "md" },
  },
);

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

export function Button({ className, variant, size, type = "button", ...props }: ButtonProps) {
  return <button type={type} className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}
