import type { Metadata } from 'next';
import './globals.css';
export const metadata: Metadata = {
  title: '环境观测站 · Hi3861',
  description: '环境数据监测、报警阈值管理与 ntfy 通知',
};
export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
