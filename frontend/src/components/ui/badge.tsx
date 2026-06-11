import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center justify-center rounded-md border px-2 py-0.5 text-xs font-medium w-fit whitespace-nowrap shrink-0 [&>svg]:size-3 gap-1 [&>svg]:pointer-events-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive transition-[color,box-shadow] overflow-hidden",
  {
    variants: {
      variant: {
        default:
          "border-transparent bg-primary text-primary-foreground [a&]:hover:bg-primary/90",
        secondary:
          "border-transparent bg-secondary text-secondary-foreground [a&]:hover:bg-secondary/90",
        destructive:
          "border-transparent bg-destructive text-white [a&]:hover:bg-destructive/90 focus-visible:ring-destructive/20 dark:focus-visible:ring-destructive/40 dark:bg-destructive/60",
        outline:
          "text-foreground [a&]:hover:bg-accent [a&]:hover:text-accent-foreground",
      },
      color: {
        default: "",
        green:
          "border-transparent bg-green-500/15 text-green-700 dark:text-green-400",
        red: "border-transparent bg-red-500/15 text-red-700 dark:text-red-400",
        yellow:
          "border-transparent bg-yellow-500/15 text-yellow-700 dark:text-yellow-400",
        amber:
          "border-transparent bg-amber-500/15 text-amber-700 dark:text-amber-400",
        gray: "border-transparent bg-gray-500/15 text-gray-700 dark:text-gray-400",
      },
    },
    defaultVariants: {
      variant: "default",
      color: "default",
    },
  }
);

type BadgeColor = VariantProps<typeof badgeVariants>["color"];

function Badge({
  className,
  variant,
  color,
  asChild = false,
  ...props
}: React.ComponentProps<"span"> &
  VariantProps<typeof badgeVariants> & { asChild?: boolean; color?: BadgeColor }) {
  const Comp = asChild ? Slot : "span";

  return (
    <Comp
      data-slot="badge"
      className={cn(badgeVariants({ variant, color }), className)}
      {...props}
    />
  );
}

export { Badge, badgeVariants };
export type { BadgeColor };
