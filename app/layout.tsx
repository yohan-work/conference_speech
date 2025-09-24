import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "발표 음성 인식 & 요약",
  description: "실시간 음성 인식과 AI 요약 기능을 제공하는 웹앱",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="ko">
      <body className="bg-gray-50 min-h-screen">{children}</body>
    </html>
  );
}
