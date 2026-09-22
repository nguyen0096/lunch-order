import "@testing-library/jest-dom/vitest";

// jsdom implements neither of these, and Radix's positioning code calls both
// the moment a tooltip, popover or dialog opens. Without them the component
// throws on mount and the test reads as a component bug rather than a missing
// browser API.
if (!("ResizeObserver" in globalThis)) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

// cmdk scrolls the highlighted option into view on every keystroke.
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = function scrollIntoView() {};
}

if (!("DOMRect" in globalThis)) {
  globalThis.DOMRect = class {
    constructor(
      public x = 0,
      public y = 0,
      public width = 0,
      public height = 0,
    ) {}
    top = 0;
    left = 0;
    right = 0;
    bottom = 0;
    static fromRect(r?: DOMRectInit) {
      return new DOMRect(r?.x, r?.y, r?.width, r?.height);
    }
    toJSON() {
      return this;
    }
  } as unknown as typeof DOMRect;
}
