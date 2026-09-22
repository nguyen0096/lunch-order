// One import site for the design system. Screens import from "@/ui", never
// from a file inside it, so a primitive can be split or renamed without
// touching nine screens.
export { Action } from "@/ui/action";
export { useAction, type Action as ActionHandle, type ActionResult, type UseActionOptions } from "@/ui/useAction";

export { Badge, badgeVariants } from "@/ui/badge";
export { Button, buttonVariants } from "@/ui/button";
export { cn } from "@/ui/cn";
export { Combobox, type ComboboxOption } from "@/ui/combobox";
export { EmptyState } from "@/ui/empty-state";
export { Skeleton } from "@/ui/skeleton";
export { Toaster } from "@/ui/sonner";

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/ui/dialog";
export { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from "@/ui/popover";
export {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableNumericCell,
  TableRow,
} from "@/ui/table";
export { Tabs, TabsContent, TabsList, TabsTrigger } from "@/ui/tabs";
export { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/ui/tooltip";
