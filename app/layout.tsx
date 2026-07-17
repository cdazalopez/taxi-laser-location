import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Taxi Laser — Compartir Ubicación",
  description:
    "Comparte tu ubicación con Taxi Laser para que tu conductor te encuentre. / Share your location with Taxi Laser so your driver can find you.",
  robots: { index: false, follow: false },
  openGraph: {
    title: "Taxi Laser — Compartir Ubicación",
    description:
      "Comparte tu ubicación para que te enviemos tu conductor. / Share your location so we can send your driver.",
    siteName: "Taxi Laser",
    type: "website",
  },
};

export const viewport: Viewport = {
  themeColor: "#0D0D0D",
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="es">
      <body>{children}</body>
    </html>
  );
}
