import type { Metadata } from 'next';
import './globals.css';
import { SessionProvider } from '../lib/session';

export const metadata: Metadata = {
  title: 'AgentFlow',
  description: 'Build, run and supervise chained AI agent workflows.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <SessionProvider>{children}</SessionProvider>
      </body>
    </html>
  );
}
