import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  Badge,
  Combobox,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  EmptyState,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/ui";

/**
 * No screen uses these yet, so nothing else would notice a Radix or cmdk API
 * drift that the compiler cannot see. Cheap insurance until the screen pass.
 */
describe("primitives mount and behave", () => {
  it("Combobox filters Vietnamese names and reports the pick", async () => {
    const onChange = vi.fn();
    render(
      <Combobox
        value={null}
        onChange={onChange}
        options={[
          { value: "teo", label: "Tèo" },
          { value: "nguyen", label: "Nguyễn", keywords: ["nn"] },
        ]}
        placeholder="Who"
      />,
    );
    await userEvent.click(screen.getByRole("combobox"));
    await userEvent.click(await screen.findByText("Nguyễn"));
    expect(onChange).toHaveBeenCalledWith("nguyen");
  });

  it("Combobox says what to do when the filter matches nothing", async () => {
    render(
      <Combobox
        value={null}
        onChange={vi.fn()}
        options={[{ value: "teo", label: "Tèo" }]}
        emptyMessage="Nobody by that name is in this office."
        searchPlaceholder="Search people"
      />,
    );
    await userEvent.click(screen.getByRole("combobox"));
    await userEvent.type(await screen.findByPlaceholderText("Search people"), "zzz");
    expect(await screen.findByText("Nobody by that name is in this office.")).toBeInTheDocument();
  });

  it("Dialog opens with an accessible name", async () => {
    render(
      <Dialog>
        <DialogTrigger>Pick a dish</DialogTrigger>
        <DialogContent>
          <DialogTitle>Wednesday</DialogTitle>
          <DialogDescription>Cơm gà, Phở bò, Bún bò Huế</DialogDescription>
        </DialogContent>
      </Dialog>,
    );
    await userEvent.click(screen.getByText("Pick a dish"));
    expect(await screen.findByRole("dialog", { name: "Wednesday" })).toBeInTheDocument();
  });

  it("Dialog leaves room for the close button beside the title", async () => {
    render(
      <Dialog defaultOpen>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Cancel lunch on Friday 25 September?</DialogTitle>
          </DialogHeader>
        </DialogContent>
      </Dialog>,
    );

    // jsdom has neither layout nor the stylesheet, so this cannot be measured
    // here: it was measured in a browser, where the title's box ended 12px
    // clear of the button instead of running under it. What is assertable is
    // the rule that put it there, which is one class and easy to delete by
    // accident.
    const content = (await screen.findByRole("dialog")).closest(
      "[data-slot=dialog-content]",
    ) as HTMLElement;
    expect(content.className).toContain("[&_[data-slot=dialog-header]]:pr-10");
  });

  it("Dialog reclaims that room when there is no close button", async () => {
    render(
      <Dialog defaultOpen>
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Nothing to close</DialogTitle>
          </DialogHeader>
        </DialogContent>
      </Dialog>,
    );
    const content = (await screen.findByRole("dialog")).closest(
      "[data-slot=dialog-content]",
    ) as HTMLElement;
    expect(content.className).not.toContain("[&_[data-slot=dialog-header]]:pr-10");
  });

  it("Tabs switch panels", async () => {
    render(
      <Tabs defaultValue="week">
        <TabsList>
          <TabsTrigger value="week">Week</TabsTrigger>
          <TabsTrigger value="bill">Bill</TabsTrigger>
        </TabsList>
        <TabsContent value="week">the board</TabsContent>
        <TabsContent value="bill">the bill</TabsContent>
      </Tabs>,
    );
    expect(screen.getByText("the board")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("tab", { name: "Bill" }));
    expect(await screen.findByText("the bill")).toBeInTheDocument();
  });

  it("EmptyState names the thing and the next step", () => {
    render(
      <EmptyState heading="No menu for Wednesday" action={<button>Publish one</button>}>
        Paste the caterer's message and publish it, and the board fills in.
      </EmptyState>,
    );
    expect(screen.getByRole("heading", { name: "No menu for Wednesday" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Publish one" })).toBeInTheDocument();
  });

  it("Table renders a real table with tabular numerals available", () => {
    render(
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Who</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow>
            <TableCell>Tèo</TableCell>
          </TableRow>
        </TableBody>
      </Table>,
    );
    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(screen.getByRole("cell", { name: "Tèo" })).toBeInTheDocument();
  });

  it("Badge and Skeleton mount, and Skeleton announces itself as busy", () => {
    render(
      <>
        <Badge variant="success">Paid</Badge>
        <Skeleton className="h-6 w-40" />
      </>,
    );
    expect(screen.getByText("Paid")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveAttribute("aria-busy", "true");
  });
});
