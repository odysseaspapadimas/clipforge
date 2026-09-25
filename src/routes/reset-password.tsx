import { createFileRoute, Link } from "@tanstack/react-router";
import { createAuthClient } from "better-auth/react";
import { ArrowRight, LockKeyhole } from "lucide-react";
import { useState, type FormEvent } from "react";

export const Route = createFileRoute("/reset-password")({ component: ResetPassword });
function ResetPassword() {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);
  const token = typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("token");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError("");
    if (!token) { setError("This reset link is invalid. Request a new link."); return; }
    const result = await createAuthClient().resetPassword({ newPassword: password, token });
    if (result.error) setError(result.error.message ?? "This reset link expired. Request a new one.");
    else setDone(true);
  }
  return <div className="auth-layout content-container"><div className="auth-aside"><LockKeyhole size={38} /><h1>Back to making <em>moments.</em></h1><p>Choose a new password, then return to your studio.</p></div><div className="auth-card"><span className="eyebrow">ACCOUNT RECOVERY</span><h2>{done ? "All set." : "Choose a new password."}</h2>{done ? <Link to="/sign-in" className="button button-dark">Sign in <ArrowRight size={18} /></Link> : <form onSubmit={submit}><label>New password<input type="password" required minLength={12} autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="At least 12 characters" /></label>{error && <p className="form-error" role="alert">{error}</p>}<button className="button button-dark full" type="submit">Set new password <ArrowRight size={18} /></button></form>}</div></div>;
}
