import type * as React from "react";
import { CheckIcon, ChevronRightIcon, CopyIcon, MoreHorizontalIcon, XIcon } from "lucide-react";

const ICONS = {
  CheckIcon,
  ChevronRightIcon,
  CopyIcon,
  MoreHorizontalIcon,
  XIcon,
} as const;

type IconPlaceholderProps = React.SVGProps<SVGSVGElement> & {
  lucide: keyof typeof ICONS;
  /** icon-library hints passed by the registry components — ignored here */
  tabler?: string;
  hugeicons?: string;
  phosphor?: string;
  remixicon?: string;
};

/**
 * Local stand-in for the registry's icon-placeholder: resolves the lucide icon
 * name embedded in vendored shadcn components.
 */
export function IconPlaceholder({ lucide, ...props }: IconPlaceholderProps) {
  // registry components pass hints for other icon libraries — never render
  // them as DOM attributes
  for (const key of ["tabler", "hugeicons", "phosphor", "remixicon"] as const) {
    delete props[key];
  }
  const Icon = ICONS[lucide];
  return <Icon {...props} />;
}
