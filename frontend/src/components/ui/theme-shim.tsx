import * as React from "react";
import { cn } from "@/lib/utils";
import { Textarea as TextArea } from "./textarea";

type Responsive<T> = T | { initial?: T; sm?: T; md?: T; lg?: T; xl?: T };

type SpacingValue = string | number;

type LayoutProps<T extends React.ElementType> = {
  as?: T;
  p?: SpacingValue;
  px?: SpacingValue;
  py?: SpacingValue;
  pt?: SpacingValue;
  pr?: SpacingValue;
  pb?: SpacingValue;
  pl?: SpacingValue;
  m?: SpacingValue;
  mx?: SpacingValue;
  my?: SpacingValue;
  mt?: SpacingValue;
  mr?: SpacingValue;
  mb?: SpacingValue;
  ml?: SpacingValue;
  size?: string;
  color?: string;
  weight?: string;
  align?: string;
  direction?: Responsive<"row" | "column">;
  justify?: string;
  gap?: SpacingValue;
  display?: Responsive<string>;
  columns?: Responsive<string>;
  width?: SpacingValue;
  wrap?: "wrap" | "nowrap";
} & Omit<React.ComponentPropsWithRef<T>, "as" | "color" | "size">;

const toSpacingValue = (value: SpacingValue | undefined) => {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "number") return `${value * 0.25}rem`;
  if (/^\d+$/.test(value)) return `${Number(value) * 0.25}rem`;
  return value;
};

const spacingStyle = (props: Record<string, unknown>): React.CSSProperties => {
  const style: React.CSSProperties = {};
  const set = (keys: Array<keyof React.CSSProperties>, value: unknown) => {
    const spacing = toSpacingValue(value as SpacingValue);
    if (!spacing) return;
    keys.forEach((key) => {
      (style as Record<string, string>)[key] = spacing;
    });
  };

  set(["padding"], props.p);
  set(["paddingLeft", "paddingRight"], props.px);
  set(["paddingTop", "paddingBottom"], props.py);
  set(["paddingTop"], props.pt);
  set(["paddingRight"], props.pr);
  set(["paddingBottom"], props.pb);
  set(["paddingLeft"], props.pl);
  set(["margin"], props.m);
  set(["marginLeft", "marginRight"], props.mx);
  set(["marginTop", "marginBottom"], props.my);
  set(["marginTop"], props.mt);
  set(["marginRight"], props.mr);
  set(["marginBottom"], props.mb);
  set(["marginLeft"], props.ml);
  set(["gap"], props.gap);
  const width = props.width as SpacingValue | undefined;
  const widthValue = toSpacingValue(width);
  if (widthValue) {
    style.width = widthValue;
  }

  return style;
};

const mergeStyle = (
  shim: Record<string, unknown>,
  style?: React.CSSProperties
): React.CSSProperties | undefined => {
  const shimStyle = spacingStyle(shim);
  if (Object.keys(shimStyle).length === 0) return style;
  return { ...shimStyle, ...style };
};

const directionClass = (value?: Responsive<"row" | "column">) => {
  if (!value) return "";
  if (typeof value === "string") {
    return value === "column" ? "flex-col" : "flex-row";
  }

  return cn(
    value.initial && (value.initial === "column" ? "flex-col" : "flex-row"),
    value.sm && (value.sm === "column" ? "sm:flex-col" : "sm:flex-row"),
    value.md && (value.md === "column" ? "md:flex-col" : "md:flex-row"),
    value.lg && (value.lg === "column" ? "lg:flex-col" : "lg:flex-row"),
    value.xl && (value.xl === "column" ? "xl:flex-col" : "xl:flex-row")
  );
};

const displayClass = (value?: Responsive<string>) => {
  if (!value) return "";
  const maps: Record<string, Record<string, string>> = {
    base: {
      none: "hidden",
      block: "block",
      flex: "flex",
      grid: "grid",
      inline: "inline",
      "inline-block": "inline-block",
      "inline-flex": "inline-flex",
      contents: "contents",
    },
    sm: {
      none: "sm:hidden",
      block: "sm:block",
      flex: "sm:flex",
      grid: "sm:grid",
      inline: "sm:inline",
      "inline-block": "sm:inline-block",
      "inline-flex": "sm:inline-flex",
      contents: "sm:contents",
    },
    md: {
      none: "md:hidden",
      block: "md:block",
      flex: "md:flex",
      grid: "md:grid",
      inline: "md:inline",
      "inline-block": "md:inline-block",
      "inline-flex": "md:inline-flex",
      contents: "md:contents",
    },
    lg: {
      none: "lg:hidden",
      block: "lg:block",
      flex: "lg:flex",
      grid: "lg:grid",
      inline: "lg:inline",
      "inline-block": "lg:inline-block",
      "inline-flex": "lg:inline-flex",
      contents: "lg:contents",
    },
    xl: {
      none: "xl:hidden",
      block: "xl:block",
      flex: "xl:flex",
      grid: "xl:grid",
      inline: "xl:inline",
      "inline-block": "xl:inline-block",
      "inline-flex": "xl:inline-flex",
      contents: "xl:contents",
    },
  };
  const toClass = (prefix: keyof typeof maps, display?: string) =>
    display ? maps[prefix][display] ?? "" : "";

  if (typeof value === "string") return toClass("base", value);

  return cn(
    toClass("base", value.initial),
    toClass("sm", value.sm),
    toClass("md", value.md),
    toClass("lg", value.lg),
    toClass("xl", value.xl)
  );
};

const justifyClass = (value?: string) => {
  if (!value) return "";
  const map: Record<string, string> = {
    start: "justify-start",
    center: "justify-center",
    end: "justify-end",
    between: "justify-between",
  };
  return map[value] ?? value;
};

const alignClass = (value?: string) => {
  if (!value) return "";
  const map: Record<string, string> = {
    start: "items-start",
    center: "items-center",
    end: "items-end",
    baseline: "items-baseline",
    stretch: "items-stretch",
  };
  return map[value] ?? value;
};

const textSizeClass = (size?: string) => {
  const map: Record<string, string> = {
    "1": "text-xs",
    "2": "text-sm",
    "3": "text-base",
    "4": "text-lg",
    "5": "text-xl",
    "6": "text-2xl",
    "7": "text-3xl",
    "8": "text-4xl",
    "9": "text-5xl md:text-6xl",
  };
  return size ? map[size] : "";
};

const headingSizeClass = (size?: string) => {
  const map: Record<string, string> = {
    "1": "text-sm",
    "2": "text-base",
    "3": "text-lg",
    "4": "text-xl",
    "5": "text-2xl",
    "6": "text-3xl",
    "7": "text-4xl",
    "8": "text-5xl",
    "9": "text-5xl md:text-6xl",
  };
  return size ? map[size] : "";
};

const colorClass = (color?: string) => {
  if (!color) return "";
  const map: Record<string, string> = {
    gray: "text-muted-foreground",
    red: "text-red-600",
    green: "text-emerald-600",
    blue: "text-blue-600",
  };
  return map[color] ?? "";
};

const weightClass = (weight?: string) => {
  const map: Record<string, string> = {
    light: "font-light",
    regular: "font-normal",
    medium: "font-medium",
    bold: "font-bold",
  };
  return weight ? map[weight] : "";
};

const textAlignClass = (align?: string) => {
  const map: Record<string, string> = {
    left: "text-left",
    center: "text-center",
    right: "text-right",
  };
  return align ? map[align] : "";
};

const columnClass = (value?: Responsive<string>) => {
  if (!value) return "";
  const maps: Record<string, Record<string, string>> = {
    base: {
      "1": "grid-cols-1",
      "2": "grid-cols-2",
      "3": "grid-cols-3",
      "4": "grid-cols-4",
      "5": "grid-cols-5",
      "6": "grid-cols-6",
    },
    sm: {
      "1": "sm:grid-cols-1",
      "2": "sm:grid-cols-2",
      "3": "sm:grid-cols-3",
      "4": "sm:grid-cols-4",
      "5": "sm:grid-cols-5",
      "6": "sm:grid-cols-6",
    },
    md: {
      "1": "md:grid-cols-1",
      "2": "md:grid-cols-2",
      "3": "md:grid-cols-3",
      "4": "md:grid-cols-4",
      "5": "md:grid-cols-5",
      "6": "md:grid-cols-6",
    },
    lg: {
      "1": "lg:grid-cols-1",
      "2": "lg:grid-cols-2",
      "3": "lg:grid-cols-3",
      "4": "lg:grid-cols-4",
      "5": "lg:grid-cols-5",
      "6": "lg:grid-cols-6",
    },
    xl: {
      "1": "xl:grid-cols-1",
      "2": "xl:grid-cols-2",
      "3": "xl:grid-cols-3",
      "4": "xl:grid-cols-4",
      "5": "xl:grid-cols-5",
      "6": "xl:grid-cols-6",
    },
  };
  const toClass = (prefix: keyof typeof maps, columns?: string) =>
    columns ? maps[prefix][columns] : "";
  if (typeof value === "string") return toClass("base", value);

  return cn(
    toClass("base", value.initial),
    toClass("sm", value.sm),
    toClass("md", value.md),
    toClass("lg", value.lg),
    toClass("xl", value.xl)
  );
};

const omitShimProps = <T extends React.ElementType>(
  props: LayoutProps<T>
) => {
  const {
    as,
    p,
    px,
    py,
    pt,
    pr,
    pb,
    pl,
    m,
    mx,
    my,
    mt,
    mr,
    mb,
    ml,
    size,
    color,
    weight,
    align,
    direction,
    justify,
    gap,
    display,
    columns,
    width,
    wrap,
    ...rest
  } = props;
  return { rest, shim: { as, size, color, weight, align, direction, justify, gap, display, columns, width, wrap, p, px, py, pt, pr, pb, pl, m, mx, my, mt, mr, mb, ml } };
};

export function Box<T extends React.ElementType = "div">(props: LayoutProps<T>) {
  const { rest, shim } = omitShimProps(props);
  const Component = shim.as ?? "div";
  return (
    <Component
      {...rest}
      className={cn(displayClass(shim.display), rest.className)}
      style={mergeStyle(shim, rest.style)}
    />
  );
}

export function Flex<T extends React.ElementType = "div">(
  props: LayoutProps<T>
) {
  const { rest, shim } = omitShimProps(props);
  const Component = shim.as ?? "div";
  return (
    <Component
      {...rest}
      className={cn(
        "flex",
        directionClass(shim.direction),
        justifyClass(shim.justify),
        alignClass(shim.align),
        shim.wrap === "wrap" && "flex-wrap",
        shim.wrap === "nowrap" && "flex-nowrap",
        displayClass(shim.display),
        rest.className
      )}
      style={mergeStyle(shim, rest.style)}
    />
  );
}

export function Text<T extends React.ElementType = "span">(
  props: LayoutProps<T>
) {
  const { rest, shim } = omitShimProps(props);
  const Component = shim.as ?? "span";
  return (
    <Component
      {...rest}
      className={cn(
        textSizeClass(shim.size),
        colorClass(shim.color),
        weightClass(shim.weight),
        textAlignClass(shim.align),
        rest.className
      )}
      style={mergeStyle(shim, rest.style)}
    />
  );
}

export function Heading<T extends React.ElementType = "h2">(
  props: LayoutProps<T>
) {
  const { rest, shim } = omitShimProps(props);
  const Component = shim.as ?? "h2";
  return (
    <Component
      {...rest}
      className={cn(
        "font-semibold tracking-normal",
        headingSizeClass(shim.size),
        colorClass(shim.color),
        textAlignClass(shim.align),
        rest.className
      )}
      style={mergeStyle(shim, rest.style)}
    />
  );
}

export function Container<T extends React.ElementType = "div">(
  props: LayoutProps<T>
) {
  const { rest, shim } = omitShimProps(props);
  const Component = shim.as ?? "div";
  return (
    <Component
      {...rest}
      className={cn("mx-auto w-full max-w-7xl px-4", rest.className)}
      style={mergeStyle(shim, rest.style)}
    />
  );
}

export function Grid<T extends React.ElementType = "div">(
  props: LayoutProps<T>
) {
  const { rest, shim } = omitShimProps(props);
  const Component = shim.as ?? "div";
  return (
    <Component
      {...rest}
      className={cn(
        "grid",
        columnClass(shim.columns),
        rest.className
      )}
      style={mergeStyle(shim, rest.style)}
    />
  );
}

export function Theme({
  children,
}: React.PropsWithChildren<{ appearance?: string }>) {
  return <>{children}</>;
}

export function Code({
  size,
  className,
  ...props
}: React.ComponentPropsWithoutRef<"code"> & { size?: string }) {
  return (
    <code
      {...props}
      className={cn(
        "rounded bg-muted px-1.5 py-0.5 font-mono text-sm",
        textSizeClass(size),
        className
      )}
    />
  );
}

export function IconButton({
  className,
  variant,
  color,
  size,
  ...props
}: Omit<React.ComponentPropsWithoutRef<"button">, "color"> & {
  variant?: string;
  color?: string;
  size?: string;
}) {
  return (
    <button
      {...props}
      className={cn(
        "inline-flex size-9 items-center justify-center rounded-md border bg-background text-sm transition-colors hover:bg-accent hover:text-accent-foreground",
        variant === "ghost" && "border-transparent bg-transparent shadow-none",
        color === "red" && "text-red-600 hover:text-red-700",
        size === "1" && "size-8",
        size === "2" && "size-9",
        className
      )}
    />
  );
}

export function Card({
  className,
  ...props
}: React.ComponentPropsWithoutRef<"div">) {
  return (
    <div
      {...props}
      className={cn(
        "rounded-lg border bg-card text-card-foreground shadow-sm",
        className
      )}
    />
  );
}

const TableRoot = ({
  className,
  variant,
  ...props
}: React.ComponentPropsWithoutRef<"table"> & { variant?: string }) => {
  void variant;
  return (
    <div className="w-full overflow-auto">
      <table
        {...props}
        className={cn("w-full caption-bottom text-sm", className)}
      />
    </div>
  );
};

export const Table = {
  Root: TableRoot,
  Header: (props: React.ComponentPropsWithoutRef<"thead">) => (
    <thead {...props} className={cn("[&_tr]:border-b", props.className)} />
  ),
  Body: (props: React.ComponentPropsWithoutRef<"tbody">) => (
    <tbody {...props} className={cn("[&_tr:last-child]:border-0", props.className)} />
  ),
  Row: (props: React.ComponentPropsWithoutRef<"tr">) => (
    <tr
      {...props}
      className={cn(
        "border-b transition-colors hover:bg-muted/50",
        props.className
      )}
    />
  ),
  ColumnHeaderCell: (props: React.ComponentPropsWithoutRef<"th">) => (
    <th
      {...props}
      className={cn(
        "h-10 px-2 text-left align-middle font-medium text-muted-foreground",
        props.className
      )}
    />
  ),
  Cell: (props: React.ComponentPropsWithoutRef<"td">) => (
    <td {...props} className={cn("p-2 align-middle", props.className)} />
  ),
};

export { TextArea };
