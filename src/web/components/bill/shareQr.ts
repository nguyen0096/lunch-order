/**
 * Getting the payment code out of the browser and into a bank app.
 *
 * Most Vietnamese bank apps scan a QR from the photo library, so a saved image
 * is one step from a paid bill, where a screenshot is two plus a crop. A phone
 * that can share files gets the share sheet (which on iOS carries "Save
 * Image"); anything else gets a plain download.
 */

export type SaveMode = "share" | "download";

type ShareNavigator = Pick<Navigator, "share" | "canShare">;

function currentNavigator(): Partial<ShareNavigator> | undefined {
  return typeof navigator === "undefined" ? undefined : navigator;
}

/**
 * Probed with a real PNG-typed file, because `canShare({ files })` answers
 * for the file types it is shown: desktop Chrome shares text but not images.
 */
export function saveMode(nav: Partial<ShareNavigator> | undefined = currentNavigator()): SaveMode {
  if (!nav?.share || !nav.canShare) return "download";
  try {
    const probe = new File([new Uint8Array(1)], "probe.png", { type: "image/png" });
    return nav.canShare({ files: [probe] }) ? "share" : "download";
  } catch {
    return "download";
  }
}

/** `lunch-TEST-LUNCH-NEYU-2026-09-28.png`. */
export function qrFilename(paymentRef: string, day: Date): string {
  const ref = paymentRef.trim().replace(/[^0-9A-Za-z]+/g, "-");
  const y = day.getFullYear();
  const m = String(day.getMonth() + 1).padStart(2, "0");
  const d = String(day.getDate()).padStart(2, "0");
  return `lunch-${ref}-${y}-${m}-${d}.png`;
}

export type SaveOutcome = "shared" | "downloaded" | "cancelled";

export type SaveRequest = {
  file: File;
  title: string;
  /** Amount and reference in words, for wherever the image lands. */
  text: string;
};

export async function shareOrDownload(
  req: SaveRequest,
  nav: Partial<ShareNavigator> | undefined = currentNavigator(),
  doc: Document = document,
): Promise<SaveOutcome> {
  const data: ShareData = { files: [req.file], title: req.title, text: req.text };
  if (nav?.share && nav.canShare?.(data)) {
    try {
      await nav.share(data);
      return "shared";
    } catch (e) {
      const name = e instanceof Error || e instanceof DOMException ? e.name : "";
      if (name === "AbortError") return "cancelled";
      // Safari refuses a share that has lost the tap that started it. The
      // download needs no such thing, so the image still arrives.
      if (name !== "NotAllowedError") throw e;
    }
  }
  download(req.file, doc);
  return "downloaded";
}

function download(file: File, doc: Document): void {
  const url = URL.createObjectURL(file);
  const a = doc.createElement("a");
  a.href = url;
  a.download = file.name;
  a.rel = "noopener";
  doc.body.append(a);
  a.click();
  a.remove();
  // Revoked late: some browsers start reading the blob after click() returns.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/*
 * Black on white regardless of theme. This is a picture for a scanner in
 * another app, not part of the interface, so the design tokens do not apply.
 */
const PAPER = "#ffffff";
const INK = "#000000";

/**
 * The drawn code with its caption under it, as a PNG. Null when the browser
 * cannot draw to a canvas at all.
 */
export async function composeQrPng(
  qr: HTMLCanvasElement,
  caption: readonly string[],
): Promise<Blob | null> {
  const pad = Math.round(qr.width * 0.06);
  const lineHeight = Math.round(qr.width * 0.075);
  const canvas = qr.ownerDocument.createElement("canvas");
  canvas.width = qr.width + pad * 2;
  canvas.height = qr.height + pad * 2 + caption.length * lineHeight;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  ctx.fillStyle = PAPER;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(qr, pad, pad);
  ctx.fillStyle = INK;
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  caption.forEach((line, i) => {
    ctx.font = `${i === 0 ? 600 : 400} ${Math.round(lineHeight * 0.6)}px system-ui, sans-serif`;
    ctx.fillText(line, canvas.width / 2, qr.height + pad + i * lineHeight, canvas.width - pad * 2);
  });

  return new Promise((resolve) => canvas.toBlob((b) => resolve(b), "image/png"));
}
