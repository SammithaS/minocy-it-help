import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { Headset, Loader2 } from "lucide-react";
import { useState, type FormEvent } from "react";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { isStaff, meQuery } from "@/lib/api";
import { authClient } from "@/lib/auth-client";

export const Route = createFileRoute("/login")({
  validateSearch: z.object({ redirect: z.string().optional() }),
  beforeLoad: async ({ context }) => {
    const me = await context.queryClient.ensureQueryData(meQuery);
    if (me) throw redirect({ to: isStaff(me.user.role) ? "/console" : "/" });
  },
  component: Login,
});

function Login() {
  const { redirect: redirectTo } = Route.useSearch();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [email, setEmail] = useState("");
  const [otp, setOtp] = useState("");
  const [step, setStep] = useState<"email" | "code">("email");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function sendCode(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { error } = await authClient.emailOtp.sendVerificationOtp({ email, type: "sign-in" });
    setBusy(false);
    if (error) return setError(error.message ?? "Could not send the code.");
    setStep("code");
  }

  async function verify(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { error } = await authClient.signIn.emailOtp({ email, otp });
    if (error) {
      setBusy(false);
      return setError(
        error.code === "USER_NOT_FOUND"
          ? "That email isn't registered with IT. Ask your IT admin for access."
          : (error.message ?? "That code didn't work."),
      );
    }
    await qc.invalidateQueries({ queryKey: ["me"] });
    const me = await qc.fetchQuery(meQuery);
    await navigate({ to: redirectTo ?? (isStaff(me?.user.role) ? "/console" : "/") });
  }

  return (
    <div className="grid min-h-dvh place-items-center p-4">
      <div className="w-full max-w-sm rounded-card border border-line bg-card p-6 sm:p-8">
        <span className="grid size-12 place-items-center rounded-full bg-brand-700 text-on-brand">
          <Headset className="size-6" strokeWidth={2} />
        </span>
        <h1 className="mt-4 text-2xl font-extrabold">Minocy IT Help</h1>
        <p className="mt-1 text-sm text-muted">
          {step === "email"
            ? "Sign in with your work email. We'll send you a 6-digit code."
            : `Enter the code we sent to ${email}.`}
        </p>

        {step === "email" ? (
          <form onSubmit={sendCode} className="mt-6 space-y-3">
            <label className="block text-sm font-semibold" htmlFor="email">
              Work email
            </label>
            <Input
              id="email"
              type="email"
              required
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@minocy.example"
            />
            <Button type="submit" className="w-full" disabled={busy}>
              {busy && <Loader2 className="animate-spin" />} Send code
            </Button>
          </form>
        ) : (
          <form onSubmit={verify} className="mt-6 space-y-3">
            <label className="block text-sm font-semibold" htmlFor="otp">
              Sign-in code
            </label>
            <Input
              id="otp"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]{6}"
              maxLength={6}
              required
              value={otp}
              onChange={(e) => setOtp(e.target.value.replace(/\D/g, ""))}
              className="text-center text-lg tracking-[0.4em]"
            />
            <Button type="submit" className="w-full" disabled={busy}>
              {busy && <Loader2 className="animate-spin" />} Sign in
            </Button>
            <button
              type="button"
              className="w-full text-sm font-semibold text-brand-700"
              onClick={() => {
                setStep("email");
                setOtp("");
              }}
            >
              Use a different email
            </button>
          </form>
        )}

        {error && (
          <p role="alert" className="mt-4 rounded-2xl bg-critical-bg px-4 py-3 text-sm text-critical">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
