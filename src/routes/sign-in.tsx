import { createFileRoute, Link } from "@tanstack/react-router";
import { createAuthClient } from "better-auth/react";
import { ArrowRight, LoaderCircle, Sparkles } from "lucide-react";
import { useState, type FormEvent } from "react";

export const Route = createFileRoute("/sign-in")({ component: SignIn });
const authClient = createAuthClient();
function SignIn() {
  const [mode, setMode] = useState<"login" | "signup" | "forgot">("login");
  const [notice, setNotice] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setPending(true); setError(""); setNotice("");
    try {
      if (mode === "forgot") {
        await authClient.requestPasswordReset({ email, redirectTo: "/reset-password" });
        setNotice("If this email has an account, a reset link is on its way."); return;
      }
      const result = mode === "signup" ? await authClient.signUp.email({ name, email, password, callbackURL: "/studio" })
        : await authClient.signIn.email({ email, password });
      if (result.error) { setError(result.error.message ?? "Could not sign in. Please try again."); return; }
      if (mode === "signup") { setNotice("Check your email for a verification link before signing in."); return; }
      window.location.assign("/studio");
    } catch { setError("Could not reach Clipforge. Please try again."); }
    finally { setPending(false); }
  }
  return <div className="auth-layout content-container"><div className="auth-aside"><span className="eyebrow light">YOUR CREATIVE WORKSPACE</span><h1>There's more in<br />your <em>conversation.</em></h1><p>Sign in, find the moment worth sharing, and make it yours.</p><div className="auth-doodle"><Sparkles size={73} strokeWidth={1} /><span>MAKE IT<br />COUNT.</span></div></div>
    <div className="auth-card"><div className="auth-card-top"><span className="eyebrow">WELCOME {mode === "login" ? "BACK" : "IN"}</span><h2>{mode === "login" ? "Good to see you." : mode === "signup" ? "Let's make something." : "Reset your password."}</h2><p>{mode === "login" ? "Pick up where you left off." : mode === "signup" ? "Your best moments are waiting to be found." : "We'll send a link to your email address."}</p></div>
      <form onSubmit={submit}>{mode === "signup" && <label>Your name<input required maxLength={80} autoComplete="name" value={name} onChange={(event) => setName(event.target.value)} placeholder="Your name" /></label>}
        <label>Email address<input required type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@example.com" /></label>
        {mode !== "forgot" && <label>Password<input required type="password" minLength={mode === "signup" ? 12 : undefined} autoComplete={mode === "signup" ? "new-password" : "current-password"} value={password} onChange={(event) => setPassword(event.target.value)} placeholder={mode === "signup" ? "At least 12 characters" : "Your password"} /></label>}
        {mode === "login" && <button type="button" className="text-button" onClick={() => setMode("forgot")}>Forgot password?</button>}
        {error && <p className="form-error" role="alert">{error}</p>}{notice && <p className="notice success" role="status">{notice}</p>}
        <button disabled={pending} className="button button-dark full" type="submit">{pending && <LoaderCircle className="spin" size={18} />}{mode === "login" ? "Sign in" : mode === "signup" ? "Create account" : "Send reset link"} <ArrowRight size={18} /></button>
      </form><div className="auth-switch">{mode === "login" ? "New to Clipforge?" : "Already have an account?"} <button type="button" onClick={() => { setMode(mode === "login" ? "signup" : "login"); setError(""); setNotice(""); }}>{mode === "login" ? "Create an account" : "Sign in"}</button></div>
      <p className="auth-note">By continuing, you agree to process only videos you own or have permission to use. <Link to="/pricing">View pricing</Link>.</p>
    </div></div>;
}
