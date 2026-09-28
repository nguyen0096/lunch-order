import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Action } from "@/ui/action";

describe("Action, available", () => {
  it("is enabled and clickable when reason is null", async () => {
    const onClick = vi.fn();
    render(
      <Action reason={null} onClick={onClick}>
        Publish
      </Action>,
    );
    const button = screen.getByRole("button", { name: "Publish" });
    expect(button).not.toHaveAttribute("aria-disabled");
    expect(button).toBeEnabled();
    await userEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("carries no description when there is nothing to explain", () => {
    render(<Action reason={null}>Publish</Action>);
    expect(screen.getByRole("button")).not.toHaveAccessibleDescription();
  });
});

describe("Action, unavailable", () => {
  const reason = "Ordering closed at 21:00";

  it("refuses the click and says why", async () => {
    const onClick = vi.fn();
    render(
      <Action reason={reason} onClick={onClick}>
        Order
      </Action>,
    );
    const button = screen.getByRole("button", { name: "Order" });
    expect(button).toHaveAttribute("aria-disabled", "true");
    await userEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("announces the sentence to assistive tech without any interaction", () => {
    render(<Action reason={reason}>Order</Action>);
    expect(screen.getByRole("button", { name: "Order" })).toHaveAccessibleDescription(reason);
  });

  it("stays in the tab order, so a keyboard user can reach the reason at all", async () => {
    render(<Action reason={reason}>Order</Action>);
    await userEvent.tab();
    expect(screen.getByRole("button", { name: "Order" })).toHaveFocus();
  });

  it("refuses Enter and Space as well as the pointer", async () => {
    const onClick = vi.fn();
    render(
      <Action reason={reason} onClick={onClick}>
        Order
      </Action>,
    );
    await userEvent.tab();
    await userEvent.keyboard("{Enter}");
    await userEvent.keyboard(" ");
    expect(onClick).not.toHaveBeenCalled();
  });

  it("shows the sentence in a tooltip on hover", async () => {
    render(<Action reason={reason}>Order</Action>);
    await userEvent.hover(screen.getByRole("button", { name: "Order" }));
    await waitFor(() => expect(screen.getAllByText(reason).length).toBeGreaterThan(1));
  });

  // A phone never hovers, and Radix opens a tooltip on hover and focus only. A
  // bare click event, with no pointer moving over the button first, is a tap.
  it("shows the sentence on a tap, where there is no hover to open it", async () => {
    render(<Action reason={reason}>Order</Action>);
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Order" }));

    expect(await screen.findByRole("tooltip")).toHaveTextContent(reason);
  });

  it("does not open anything on a tap when the control is only busy", () => {
    render(
      <Action reason={null} pending>
        Order
      </Action>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Order" }));
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("is not merely greyed: it is marked unavailable for styling to hang off", () => {
    render(<Action reason={reason}>Order</Action>);
    expect(screen.getByRole("button", { name: "Order" })).toHaveAttribute("data-unavailable", "true");
  });
});

describe("Action, pending", () => {
  it("refuses a second click while the first is in flight", async () => {
    const onClick = vi.fn();
    render(
      <Action reason={null} pending onClick={onClick}>
        Publish
      </Action>,
    );
    const button = screen.getByRole("button", { name: "Publish" });
    expect(button).toHaveAttribute("aria-disabled", "true");
    await userEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("stays available, because pending is not a reason", () => {
    render(
      <Action reason={null} pending>
        Publish
      </Action>,
    );
    expect(screen.getByRole("button")).not.toHaveAttribute("data-unavailable");
  });
});
