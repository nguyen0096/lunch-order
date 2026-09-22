import * as React from "react";
import { CheckIcon, ChevronsUpDownIcon } from "lucide-react";
import { cn } from "@/ui/cn";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/ui/popover";

export type ComboboxOption = {
  value: string;
  label: string;
  /** Extra text the filter should match, for example a short code. */
  keywords?: string[];
  disabled?: boolean;
};

type ComboboxProps = {
  options: ComboboxOption[];
  value: string | null;
  onChange: (value: string) => void;
  /** Shown on the closed trigger when nothing is picked. */
  placeholder?: string;
  searchPlaceholder?: string;
  /** Shown when the filter matches nothing. Not "No results". */
  emptyMessage?: string;
  id?: string;
  disabled?: boolean;
  className?: string;
  "aria-label"?: string;
  "aria-describedby"?: string;
};

/**
 * A searchable single-select. Used wherever a picker would otherwise be a flat
 * list of every person, day or dish, which stops being usable at about twenty
 * rows and is unreadable at a hundred.
 */
export function Combobox({
  options,
  value,
  onChange,
  placeholder = "Choose",
  searchPlaceholder = "Search",
  emptyMessage = "Nothing matches that.",
  id,
  disabled,
  className,
  ...aria
}: ComboboxProps) {
  const [open, setOpen] = React.useState(false);
  const selected = options.find((o) => o.value === value) ?? null;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        id={id}
        disabled={disabled}
        role="combobox"
        aria-expanded={open}
        aria-label={aria["aria-label"]}
        aria-describedby={aria["aria-describedby"]}
        className={cn(
          "flex h-11 w-full items-center justify-between gap-2 rounded-md border border-border bg-surface-raised px-3 text-sm text-text transition-colors hover:border-border-strong disabled:pointer-events-none disabled:opacity-60",
          className,
        )}
      >
        <span className={cn("truncate", !selected && "text-subtle")}>
          {selected ? selected.label : placeholder}
        </span>
        <ChevronsUpDownIcon className="size-4 shrink-0 text-subtle" />
      </PopoverTrigger>
      <PopoverContent className="w-(--radix-popover-trigger-width) p-0">
        <Command>
          <CommandInput placeholder={searchPlaceholder} />
          <CommandList>
            <CommandEmpty>{emptyMessage}</CommandEmpty>
            <CommandGroup>
              {options.map((option) => (
                <CommandItem
                  key={option.value}
                  value={option.value}
                  keywords={[option.label, ...(option.keywords ?? [])]}
                  disabled={option.disabled}
                  onSelect={(next) => {
                    onChange(next);
                    setOpen(false);
                  }}
                >
                  <CheckIcon
                    className={cn("size-4", option.value === value ? "opacity-100" : "opacity-0")}
                  />
                  <span className="truncate">{option.label}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
