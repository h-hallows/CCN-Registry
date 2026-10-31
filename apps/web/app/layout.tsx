import type { Metadata, Viewport } from 'next';
import { siteUrl } from '@/lib/site';
import './globals.css';

/**
 * metadataBase makes every canonical and OpenGraph URL absolute. Without it Next emits
 * relative ones, which a crawler resolves against whatever host it happened to reach —
 * including a preview deployment.
 */
export const metadata: Metadata = {
  metadataBase: new URL(siteUrl()),
  title: {
    default: 'Century City Concierge Nursing',
    template: '%s · Century City Concierge Nursing',
  },
  description:
    'A private nursing and caregiver referral registry serving Century City and West '
    + 'Los Angeles.',
  alternates: { canonical: '/' },
  openGraph: {
    type: 'website',
    siteName: 'Century City Concierge Nursing',
    locale: 'en_US',
  },
  // No licensure, accreditation or award anywhere in metadata — § 1812.5095(i)–(j).
};

export const viewport: Viewport = { width: 'device-width', initialScale: 1 };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en-US">
      <body>{children}</body>
    </html>
  );
}
