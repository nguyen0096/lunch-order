import { qrFilename, saveMode, shareOrDownload } from "../src/web/components/bill/shareQr.js";

const png = () => new File([new Uint8Array([137, 80, 78, 71])], "lunch-X.png", { type: "image/png" });

describe("saveMode", () => {
  it("shares where the browser can share a PNG", () => {
    expect(saveMode({ share: vi.fn(), canShare: () => true })).toBe("share");
  });

  it("downloads where it can share only text, or not at all", () => {
    expect(saveMode({ share: vi.fn(), canShare: () => false })).toBe("download");
    expect(saveMode({ share: vi.fn() })).toBe("download");
    expect(saveMode({})).toBe("download");
    expect(saveMode(undefined)).toBe("download");
  });

  it("asks about a PNG, not about nothing", () => {
    const canShare = vi.fn(() => true);
    saveMode({ share: vi.fn(), canShare });
    const files = (canShare.mock.calls[0] as unknown as [ShareData])[0].files!;
    expect(files[0]!.type).toBe("image/png");
  });
});

describe("qrFilename", () => {
  it("names the file after the reference and the day", () => {
    expect(qrFilename("TEST LUNCH NEYU", new Date(2026, 8, 28, 9))).toBe(
      "lunch-TEST-LUNCH-NEYU-2026-09-28.png",
    );
  });
});

describe("shareOrDownload", () => {
  const createObjectURL = vi.fn(() => "blob:qr");
  const revokeObjectURL = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers();
    Object.assign(URL, { createObjectURL, revokeObjectURL });
    createObjectURL.mockClear();
    revokeObjectURL.mockClear();
  });
  afterEach(() => vi.useRealTimers());

  function watchDownloads() {
    const clicked: HTMLAnchorElement[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push(this);
    });
    return clicked;
  }

  it("opens the share sheet with the file, the amount and the reference", async () => {
    const share = vi.fn(async () => {});
    const file = png();
    const outcome = await shareOrDownload(
      { file, title: "Lunch payment", text: "Pay 180.000 ₫. Reference: TEST LUNCH NEYU" },
      { share, canShare: () => true },
    );
    expect(outcome).toBe("shared");
    expect(share).toHaveBeenCalledWith({
      files: [file],
      title: "Lunch payment",
      text: "Pay 180.000 ₫. Reference: TEST LUNCH NEYU",
    });
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it("says nothing happened when the sheet is dismissed", async () => {
    const share = vi.fn(async () => {
      throw new DOMException("cancelled", "AbortError");
    });
    const clicked = watchDownloads();
    expect(await shareOrDownload({ file: png(), title: "t", text: "x" }, { share, canShare: () => true })).toBe(
      "cancelled",
    );
    expect(clicked).toHaveLength(0);
  });

  it("downloads instead when Safari refuses a share that lost its tap", async () => {
    const share = vi.fn(async () => {
      throw new DOMException("no gesture", "NotAllowedError");
    });
    const clicked = watchDownloads();
    expect(await shareOrDownload({ file: png(), title: "t", text: "x" }, { share, canShare: () => true })).toBe(
      "downloaded",
    );
    expect(clicked).toHaveLength(1);
  });

  it("passes on any other failure", async () => {
    const share = vi.fn(async () => {
      throw new TypeError("bad data");
    });
    await expect(
      shareOrDownload({ file: png(), title: "t", text: "x" }, { share, canShare: () => true }),
    ).rejects.toThrow("bad data");
  });

  it("falls back to a download link where files cannot be shared", async () => {
    const clicked = watchDownloads();
    const file = png();
    expect(await shareOrDownload({ file, title: "t", text: "x" }, { share: vi.fn(), canShare: () => false })).toBe(
      "downloaded",
    );
    expect(clicked).toHaveLength(1);
    expect(clicked[0]!.download).toBe("lunch-X.png");
    expect(clicked[0]!.href).toBe("blob:qr");
    expect(createObjectURL).toHaveBeenCalledWith(file);
    // Gone from the page, and the blob released once the browser has read it.
    expect(document.querySelector("a[download]")).toBeNull();
    vi.runAllTimers();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:qr");
  });
});
