import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

/**
 * shadcn's Button, re-skinned. The corners are cut rather than rounded and the
 * primary variant emits light instead of being filled — a solid button reads
 * as a form, and this page is meant to read as a machine.
 */
const buttonVariants = cva(
  "cut inline-flex items-center justify-center gap-2 whitespace-nowrap text-xs uppercase tracking-[0.14em] font-medium transition-all disabled:pointer-events-none disabled:opacity-40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-cyan",
  {
    variants: {
      variant: {
        default:
          "bg-cyan/10 text-cyan border border-cyan/40 hover:bg-cyan/20 hover:shadow-[0_0_24px_-4px_rgba(0,229,255,0.6)]",
        magenta:
          "bg-magenta/10 text-magenta border border-magenta/40 hover:bg-magenta/20 hover:shadow-[0_0_24px_-4px_rgba(255,43,209,0.6)]",
        ghost: "text-ash border border-edge hover:text-bone hover:border-ash/60",
        solid:
          "bg-cyan text-void border border-cyan hover:bg-cyan/90 hover:shadow-[0_0_30px_-4px_rgba(0,229,255,0.8)]",
      },
      size: {
        default: "h-10 px-5",
        sm: "h-8 px-3 text-[10px]",
        lg: "h-12 px-8 text-sm",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  }
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...props} />
    );
  }
);
Button.displayName = "Button";

export { Button, buttonVariants };
