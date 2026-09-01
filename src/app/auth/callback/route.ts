import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const requestUrl = new URL(request.url);
  const code = requestUrl.searchParams.get("code");
  const next = requestUrl.searchParams.get("next") ?? "/reset-password";

  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      const baseUrl = process.env.NEXT_PUBLIC_SITE_URL || requestUrl.origin;
      const cleanBaseUrl = baseUrl.replace(/\/+$/, "");
      const cleanNext = next.startsWith("/") ? next : `/${next}`;
      return NextResponse.redirect(`${cleanBaseUrl}${cleanNext}`);
    }
  }

  // If code is missing or exchange fails, redirect to login with error
  const baseUrl = process.env.NEXT_PUBLIC_SITE_URL || requestUrl.origin;
  return NextResponse.redirect(
    `${baseUrl.replace(/\/+$/, "")}/login?error=auth-code-error`
  );
}
