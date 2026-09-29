import { useEffect, useId, useMemo, useRef, useState } from "react";
import { QRCodeCanvas } from "qrcode.react";
import { DownloadIcon, ExternalLinkIcon, ShareIcon } from "lucide-react";
import { toast } from "sonner";
import {
  Action,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  useAction,
} from "@/ui";
import {
  bankAppById,
  bankAppLink,
  bankAppsFor,
  type BankApp,
  type BankAppPlatform,
} from "../../../shared/bankApps.js";
import type { Currency } from "../../../shared/money.js";
import { now } from "../../../shared/clock.js";
import { coarsePointer, openUrl, rememberBankApp, rememberedBankApp } from "../../phone.js";
import { composeQrPng, qrFilename, saveMode, shareOrDownload } from "./shareQr.js";

const INPUT =
  "h-11 w-full min-w-0 rounded-md border border-border bg-surface px-3 text-base text-text placeholder:text-subtle";

/* ------------------------------------------------------------------ save */

/**
 * The code as an image, for a bank app's "scan from photo".
 *
 * The PNG is drawn as soon as the code is, not on the tap. Safari refuses a
 * share that starts too long after the tap that asked for it, and awaiting a
 * canvas encode first is enough to lose it.
 */
export function SaveQr({
  payload,
  paymentRef,
  caption,
  summary,
}: {
  payload: string;
  paymentRef: string;
  /** Printed under the code in the image: amount first, then reference. */
  caption: readonly string[];
  /** The same facts as one sentence, for the share sheet's text. */
  summary: string;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [png, setPng] = useState<Blob | null | "drawing">("drawing");
  const mode = useMemo(() => saveMode(), []);
  const captionKey = caption.join("\n");

  useEffect(() => {
    let live = true;
    setPng("drawing");
    const qr = canvas.current;
    if (!qr) return;
    composeQrPng(qr, captionKey.split("\n"))
      .catch(() => null)
      .then((blob) => {
        if (live) setPng(blob);
      });
    return () => {
      live = false;
    };
  }, [payload, captionKey]);

  const save = useAction(
    async (blob: Blob) =>
      shareOrDownload({
        file: new File([blob], qrFilename(paymentRef, now()), { type: "image/png" }),
        title: "Lunch payment",
        text: summary,
      }),
    {
      onSuccess: (outcome) => {
        if (outcome === "shared") toast.success("QR shared");
        if (outcome === "downloaded") toast.success("QR downloaded");
      },
    },
  );

  const label = mode === "share" ? "Share QR" : "Download QR";
  const reason =
    png === "drawing"
      ? "The image is still being drawn."
      : png === null
        ? "This browser cannot turn the code into an image. Take a screenshot instead."
        : null;

  return (
    <>
      {/* Off screen and fixed black on white: this one is only ever an image. */}
      <QRCodeCanvas
        ref={canvas}
        value={payload}
        marginSize={4}
        level="M"
        size={480}
        bgColor="#ffffff"
        fgColor="#000000"
        hidden
        aria-hidden
      />
      <Action
        variant="outline"
        size="sm"
        reason={reason}
        pending={save.pending}
        onClick={() => {
          if (png instanceof Blob) void save.run(png);
        }}
      >
        {mode === "share" ? <ShareIcon /> : <DownloadIcon />}
        {label}
      </Action>
    </>
  );
}

/* ------------------------------------------------------------ open app */

/**
 * A button that opens the payer's banking app, on a phone, when something is
 * owed in dong.
 *
 * It opens the app and nothing more: the redirector drops the account, amount
 * and memo (see shared/bankApps.ts), so the button copies the reference on
 * the way out, that being the field whose loss is unrecoverable. The copy
 * under it says so rather than letting the name imply a filled-in transfer.
 */
export function OpenBankApp({
  platform,
  bankBin,
  accountNumber,
  owedMinor,
  currency,
  paymentRef,
}: {
  platform: BankAppPlatform;
  bankBin: string;
  accountNumber: string;
  owedMinor: number;
  currency: Currency;
  paymentRef: string;
}) {
  const apps = bankAppsFor(platform);
  const [chosen, setChosen] = useState<BankApp | undefined>(() => {
    const id = rememberedBankApp();
    return id === null ? undefined : bankAppById(platform, id);
  });
  const [picking, setPicking] = useState(false);

  const linkFor = (app: BankApp) =>
    bankAppLink({ platform, appId: app.appId, bankBin, accountNumber, owedMinor, currency, paymentRef });

  /**
   * Said on the bill as well as in a toast: on iOS the app opens over a new
   * tab, and the member comes back to this one to find out what to paste.
   */
  const [copy, setCopy] = useState<"copied" | "failed" | null>(null);

  const first = apps[0];
  if (!first || linkFor(first) === null) return null;

  const go = (app: BankApp) => {
    const link = linkFor(app);
    if (link === null) return;
    // Started before the open, awaited by nobody on iOS: Safari allows a
    // window.open only in the tap's own tick.
    const copying = copyText(paymentRef);
    void copying.then((ok) => {
      setCopy(ok ? "copied" : "failed");
      if (ok) toast.success("Reference copied. Paste it into the transfer message.");
    });
    if (platform === "ios") openUrl(link, platform);
    else void copying.then(() => openUrl(link, platform));
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        {chosen ? (
          <>
            <Button onClick={() => go(chosen)}>
              <ExternalLinkIcon />
              {`Open ${chosen.appName}`}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setPicking(true)}>
              Other bank app
            </Button>
          </>
        ) : (
          <Button onClick={() => setPicking(true)}>
            <ExternalLinkIcon />
            Open your bank app
          </Button>
        )}
      </div>
      <p className="max-w-prose text-sm text-muted">
        Your bank app opens on its own home screen and will not fill the transfer in.
        The reference is copied as you go, so paste it into the message.
      </p>
      <p role="status" className="max-w-prose text-sm font-medium text-text empty:hidden">
        {copy === "copied"
          ? `${paymentRef} is copied. Paste it into the transfer message.`
          : copy === "failed"
            ? `The reference could not be copied. Type ${paymentRef} into the transfer message.`
            : ""}
      </p>

      <BankAppPicker
        open={picking}
        onOpenChange={setPicking}
        apps={apps}
        onPick={(app) => {
          rememberBankApp(app.appId);
          setChosen(app);
          setPicking(false);
          go(app);
        }}
      />
    </div>
  );
}

function BankAppPicker({
  open,
  onOpenChange,
  apps,
  onPick,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  apps: readonly BankApp[];
  onPick: (app: BankApp) => void;
}) {
  const [query, setQuery] = useState("");
  const filterId = useId();
  const content = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) setQuery("");
  }, [open]);

  // Alphabetical, like the admin's bank picker: a list somebody scans for a
  // name reads faster in an order they can predict.
  const sorted = useMemo(
    () => [...apps].sort((a, b) => a.appName.localeCompare(b.appName, "vi")),
    [apps],
  );
  const q = fold(query);
  const shown = q === "" ? sorted : sorted.filter((a) => fold(`${a.appName} ${a.bankName}`).includes(q));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-h-[85dvh] grid-rows-[auto_auto_minmax(0,1fr)]"
        onOpenAutoFocus={(e) => {
          // Focusing the filter on a phone raises the keyboard over the list
          // most people pick from without typing. Focus stays in the dialog.
          if (!coarsePointer()) return;
          e.preventDefault();
          content.current?.focus();
        }}
        ref={content}
      >
        <DialogHeader>
          <DialogTitle>Which bank app do you pay with?</DialogTitle>
          <DialogDescription>This phone remembers it for next time.</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={filterId} className="text-sm text-muted">
            Find your bank
          </label>
          <input
            id={filterId}
            value={query}
            className={INPUT}
            autoComplete="off"
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <ul className="-mx-2 flex min-h-0 flex-col overflow-y-auto">
          {shown.map((app) => (
            <li key={app.appId}>
              <button
                type="button"
                className="flex min-h-11 w-full flex-col items-start rounded-md px-2 py-2 text-left hover:bg-surface-sunken"
                // Two spans read as one run-on word ("ACB OneNgân hàng") otherwise.
                aria-label={`${app.appName}, ${app.bankName}`}
                onClick={() => onPick(app)}
              >
                <span className="font-medium text-text">{app.appName}</span>
                <span className="text-sm text-muted">{app.bankName}</span>
              </button>
            </li>
          ))}
          {shown.length === 0 && (
            <li className="px-2 py-2 text-sm text-muted">
              No bank app by that name. Copy the details above and pay from any app.
            </li>
          )}
        </ul>
      </DialogContent>
    </Dialog>
  );
}

/** Never rejects: a refused clipboard is an answer, not a failure to open the app. */
function copyText(text: string): Promise<boolean> {
  const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard;
  if (!clipboard) return Promise.resolve(false);
  try {
    return clipboard.writeText(text).then(
      () => true,
      () => false,
    );
  } catch {
    return Promise.resolve(false);
  }
}

/** Case and diacritics off, so "vietin" finds "VietinBank" and "a chau" finds "Á Châu". */
function fold(s: string): string {
  return s
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/đ/gi, "d")
    .toLowerCase()
    .trim();
}
