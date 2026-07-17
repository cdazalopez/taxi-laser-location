"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { WEBHOOK_URL } from "../config";

type Status =
  | "loading" // requesting / waiting on geolocation
  | "sending" // posting to webhook
  | "success" // location received (gps or manual)
  | "denied" // permission denied -> show address form
  | "error"; // something went wrong -> allow retry / manual

export default function LocationCapture({ contactId }: { contactId: string }) {
  const [status, setStatus] = useState<Status>("loading");
  const [address, setAddress] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState("");
  const requested = useRef(false);

  const postToWebhook = useCallback(
    async (payload: Record<string, unknown>) => {
      const res = await fetch(WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...payload, contact_id: contactId }),
      });
      if (!res.ok) {
        throw new Error(`Webhook responded ${res.status}`);
      }
    },
    [contactId]
  );

  const requestLocation = useCallback(() => {
    if (!("geolocation" in navigator)) {
      setStatus("denied");
      return;
    }

    setStatus("loading");

    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        setStatus("sending");
        try {
          await postToWebhook({
            lat: Number(pos.coords.latitude.toFixed(6)),
            lng: Number(pos.coords.longitude.toFixed(6)),
            type: "gps",
          });
          setStatus("success");
        } catch {
          setStatus("error");
        }
      },
      (err) => {
        // 1 = PERMISSION_DENIED -> show manual fallback.
        // Other errors (position unavailable / timeout) also fall back to
        // manual entry so the user is never stuck.
        if (err.code === err.PERMISSION_DENIED) {
          setStatus("denied");
        } else {
          setStatus("denied");
        }
      },
      {
        enableHighAccuracy: true,
        timeout: 15000,
        maximumAge: 0,
      }
    );
  }, [postToWebhook]);

  // Request geolocation immediately on load — no extra button click.
  useEffect(() => {
    if (requested.current) return;
    requested.current = true;
    requestLocation();
  }, [requestLocation]);

  const handleManualSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      const trimmed = address.trim();
      if (trimmed.length < 5) {
        setFormError(
          "Escribe una dirección más completa. / Please enter a more complete address."
        );
        return;
      }
      setFormError("");
      setSubmitting(true);
      try {
        await postToWebhook({ address: trimmed, type: "manual" });
        setStatus("success");
      } catch {
        setFormError(
          "No se pudo enviar. Intenta de nuevo. / Could not send. Please try again."
        );
      } finally {
        setSubmitting(false);
      }
    },
    [address, postToWebhook]
  );

  return (
    <main className="min-h-screen w-full flex flex-col items-center px-6 py-10 sm:py-14">
      <div className="w-full max-w-md flex flex-col items-center text-center">
        {/* Text logo */}
        <h1 className="text-3xl sm:text-4xl font-extrabold tracking-tight text-brand-yellow">
          TAXI LASER
        </h1>
        <div className="mt-2 h-1 w-16 rounded-full bg-brand-yellow/70" />

        <div className="mt-10 w-full">
          {(status === "loading" || status === "sending") && (
            <LoadingState sending={status === "sending"} />
          )}

          {status === "success" && <SuccessState />}

          {status === "denied" && (
            <ManualForm
              address={address}
              setAddress={setAddress}
              onSubmit={handleManualSubmit}
              submitting={submitting}
              formError={formError}
            />
          )}

          {status === "error" && (
            <ErrorState
              onRetry={requestLocation}
              onManual={() => setStatus("denied")}
            />
          )}
        </div>
      </div>

      <p className="mt-10 max-w-xs text-center text-xs leading-relaxed text-brand-white/45">
        Tu ubicación solo se usa para este viaje.
        <br />
        Your location is only used for this ride.
      </p>

      <footer className="mt-auto pt-8 text-xs text-brand-white/40">
        Taxi Laser LLC
      </footer>
    </main>
  );
}

/* ----------------------------- States ----------------------------- */

function LoadingState({ sending }: { sending: boolean }) {
  return (
    <div className="flex flex-col items-center gap-6">
      <Spinner />
      <PinIcon className="hidden" />
      <div>
        <p className="text-lg font-semibold text-brand-white">
          {sending
            ? "Enviando tu ubicación…"
            : "Obteniendo tu ubicación…"}
        </p>
        <p className="mt-1 text-sm text-brand-white/60">
          {sending
            ? "Sending your location…"
            : "Getting your location…"}
        </p>
        {!sending && (
          <p className="mt-4 text-sm text-brand-white/70 leading-relaxed">
            Por favor toca <span className="text-brand-yellow font-semibold">Permitir</span> cuando
            tu teléfono lo pida.
            <br />
            Please tap{" "}
            <span className="text-brand-yellow font-semibold">Allow</span> when
            your phone asks.
          </p>
        )}
      </div>
    </div>
  );
}

function SuccessState() {
  return (
    <div className="flex flex-col items-center gap-6">
      <div className="flex h-24 w-24 items-center justify-center rounded-full bg-brand-yellow/15">
        <CheckIcon className="h-14 w-14 text-brand-yellow" />
      </div>
      <div>
        <p className="text-xl font-bold text-brand-white leading-relaxed">
          ¡Listo! Hemos recibido tu ubicación. En breve te confirmamos tu
          conductor.
        </p>
        <p className="mt-3 text-base text-brand-white/70 leading-relaxed">
          Got it! We received your location. Your driver details are coming
          shortly.
        </p>
      </div>
    </div>
  );
}

function ManualForm({
  address,
  setAddress,
  onSubmit,
  submitting,
  formError,
}: {
  address: string;
  setAddress: (v: string) => void;
  onSubmit: (e: React.FormEvent) => void;
  submitting: boolean;
  formError: string;
}) {
  return (
    <div className="flex flex-col items-center gap-6">
      <div className="flex h-24 w-24 items-center justify-center rounded-full bg-brand-yellow/15">
        <PinIcon className="h-14 w-14 text-brand-yellow" />
      </div>
      <div>
        <p className="text-lg font-bold text-brand-white leading-relaxed">
          No pudimos obtener tu ubicación. Escribe tu dirección y te enviamos tu
          conductor.
        </p>
        <p className="mt-2 text-sm text-brand-white/70 leading-relaxed">
          We couldn&apos;t get your location. Please type your address and
          we&apos;ll send your driver.
        </p>
      </div>

      <form onSubmit={onSubmit} className="w-full flex flex-col gap-3">
        <input
          type="text"
          inputMode="text"
          autoComplete="street-address"
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          placeholder="602 Everett St, Conroe TX"
          className="w-full rounded-xl border border-brand-white/15 bg-brand-white/5 px-4 py-4 text-base text-brand-white placeholder:text-brand-white/40 outline-none focus:border-brand-yellow focus:ring-2 focus:ring-brand-yellow/40"
          disabled={submitting}
          autoFocus
        />

        {formError && (
          <p className="text-sm text-red-400 text-left">{formError}</p>
        )}

        <button
          type="submit"
          disabled={submitting}
          className="w-full rounded-xl bg-brand-yellow px-4 py-4 text-base font-bold text-brand-black transition active:scale-[0.98] disabled:opacity-60"
        >
          {submitting ? (
            <span className="inline-flex items-center gap-2">
              <MiniSpinner /> Enviando… / Sending…
            </span>
          ) : (
            "Enviar dirección / Send address"
          )}
        </button>
      </form>
    </div>
  );
}

function ErrorState({
  onRetry,
  onManual,
}: {
  onRetry: () => void;
  onManual: () => void;
}) {
  return (
    <div className="flex flex-col items-center gap-6">
      <div className="flex h-24 w-24 items-center justify-center rounded-full bg-red-500/15">
        <AlertIcon className="h-14 w-14 text-red-400" />
      </div>
      <div>
        <p className="text-lg font-bold text-brand-white leading-relaxed">
          Algo salió mal al enviar tu ubicación.
        </p>
        <p className="mt-2 text-sm text-brand-white/70 leading-relaxed">
          Something went wrong sending your location.
        </p>
      </div>
      <div className="w-full flex flex-col gap-3">
        <button
          onClick={onRetry}
          className="w-full rounded-xl bg-brand-yellow px-4 py-4 text-base font-bold text-brand-black transition active:scale-[0.98]"
        >
          Reintentar / Try again
        </button>
        <button
          onClick={onManual}
          className="w-full rounded-xl border border-brand-white/20 px-4 py-4 text-base font-semibold text-brand-white transition active:scale-[0.98]"
        >
          Escribir dirección / Type address
        </button>
      </div>
    </div>
  );
}

/* ----------------------------- Icons ----------------------------- */

function Spinner() {
  return (
    <div
      className="h-16 w-16 rounded-full border-4 border-brand-white/15 border-t-brand-yellow animate-spin"
      role="status"
      aria-label="Cargando / Loading"
    />
  );
}

function MiniSpinner() {
  return (
    <span className="inline-block h-4 w-4 rounded-full border-2 border-brand-black/30 border-t-brand-black animate-spin" />
  );
}

function CheckIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

function PinIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z" />
      <circle cx="12" cy="10" r="3" />
    </svg>
  );
}

function AlertIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 9v4" />
      <path d="M12 17h.01" />
      <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
    </svg>
  );
}
