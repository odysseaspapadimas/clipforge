import { createFileRoute, Link } from "@tanstack/react-router";
import { createAuthClient } from "better-auth/react";
import { ArrowRight, ArrowUpRight, Clock3, CloudUpload, FileVideo2, LoaderCircle, LogOut, Play, Sparkles, Trash2, Upload } from "lucide-react";
import { preflightBrowserVideo } from "../domain/browser-preview.ts";
import { useEffect, useState, type ChangeEvent } from "react";

export const Route = createFileRoute("/studio/")({ component: Studio });
type Project = { id: string; title: string; fileSize: number; status: string; durationMs: number | null; error: string | null; createdAt: number };
type Account = { user: { name: string; email: string }; minutes: number; localDemo: boolean;
  stagingMinutesRemaining: number | null; subscription: { status: string; periodEnd: number | null } | null };
async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`/api/${path}`, { credentials: "same-origin", ...options });
  const data = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(data.error ?? `Request failed (${response.status})`);
  return data;
}
function greeting() { const hour = new Date().getHours(); return hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening"; }
function duration(ms: number | null) { return ms ? `${Math.floor(ms / 60000)} min` : "Processing"; }

function Studio() {
  const [account, setAccount] = useState<Account | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [error, setError] = useState("");
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [resumeId, setResumeId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function refresh() {
    try {
      const [me, library] = await Promise.all([api<Account>("me"), api<{ projects: Project[] }>("projects")]);
      setAccount(me); setProjects(library.projects);
    } catch (cause) {
      if (String(cause).includes("Sign in required")) window.location.assign("/sign-in");
      else setError(String(cause));
    }
  }
  useEffect(() => { void refresh(); const timer = setInterval(() => { void refresh(); }, 8_000); return () => clearInterval(timer); }, []);
  async function billing(operation: "checkout" | "portal") {
    setBusy(true); setError("");
    try { const result = await api<{ url: string }>(`billing/${operation}`, { method: "POST" }); window.location.assign(result.url); }
    catch (cause) { setError(String(cause)); setBusy(false); }
  }
  async function removeProject(project: Project) {
    if (!window.confirm(`Permanently delete “${project.title}” and its recording, transcript and exports? This cannot be undone. Billing usage is retained.`)) return;
    setBusy(true); setError("");
    try { await api(`projects/${project.id}`, { method: "DELETE" }); if (resumeId === project.id) setResumeId(null); await refresh(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not delete project; please retry."); }
    finally { setBusy(false); }
  }
  async function upload(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]; if (!file) return;
    setUploading(true); setError(""); setProgress(0);
    try {
      if (!account?.subscription || account.subscription.status !== "active" || account.minutes <= 0) {
        throw new Error("Choose a plan with available source minutes before uploading.");
      }
      const title = file.name;
      const extension = file.name.toLowerCase().split(".").pop();
      if (extension !== "mp4" && extension !== "webm") throw new Error("MOV/ProRes is not browser-previewable here. Convert to H.264/AAC MP4 or browser-playable WebM before upload.");
      const mimeType = extension === "webm" ? "video/webm" : "video/mp4";
      await preflightBrowserVideo(file, mimeType);
      const session = resumeId ? await api<{ projectId: string; size: number; partBytes: number; parts: Array<{ partNumber: number; etag: string }> }>(`uploads/${resumeId}`)
        : await api<{ projectId: string; partBytes: number; parts: number }>("uploads", { method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: title, size: file.size, mimeType }) });
      if ("size" in session && session.size !== file.size) throw new Error("Select the same file to resume this upload.");
      const projectId = session.projectId;
      const totalParts = Math.ceil(file.size / session.partBytes);
      const finished = new Set(Array.isArray(session.parts) ? session.parts.map((part) => part.partNumber) : []);
      let completed = finished.size;
      setProgress(Math.round(completed / totalParts * 100));
      const pending = Array.from({ length: totalParts }, (_, i) => i + 1).filter((part) => !finished.has(part));
      let cursor = 0;
      await Promise.all(Array.from({ length: Math.min(3, pending.length) }, async () => {
        while (cursor < pending.length) {
          const part = pending[cursor++];
          const blob = file.slice((part - 1) * session.partBytes, Math.min(file.size, part * session.partBytes));
          for (let attempt = 0; attempt < 3; attempt++) {
            try {
              await api(`uploads/${projectId}/parts/${part}`, { method: "PUT", body: blob });
              completed++; setProgress(Math.round(completed / totalParts * 100));
              break;
            } catch (cause) {
              if (attempt === 2) throw cause;
              await new Promise((resolve) => setTimeout(resolve, (attempt + 1) * 1200));
            }
          }
        }
      }));
      await api(`uploads/${projectId}/complete`, { method: "POST" });
      setResumeId(null); event.target.value = "";
      window.location.assign(`/studio/${projectId}`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Upload failed; you can resume it."); }
    finally { setUploading(false); await refresh(); }
  }
  return <div className="content-container studio-page">
    {account?.localDemo && <div className="notice demo" role="status">LOCAL SANDBOX — payment and transcript discovery use offline fixtures here. Real Stripe and speech providers have not been contacted.</div>}
    {account?.stagingMinutesRemaining !== null && account?.stagingMinutesRemaining !== undefined &&
      <div className="notice demo" role="status">GUARDED STAGING — {account.stagingMinutesRemaining} shared inference minutes remain across this staging environment. Sources exceeding the remaining allowance fail without model inference; reserved plan minutes are returned. Upload only consented short test recordings.</div>}
    <div className="studio-top"><div><span className="eyebrow">YOUR CREATIVE WORKSPACE</span><h1>{greeting()}, <em>{account?.user.name?.split(" ")[0] ?? "creator"}.</em></h1><p>Your conversations have more to give. Let's find the moments that matter.</p></div>
      <button className="button button-outline" onClick={async () => { await createAuthClient().signOut(); window.location.assign("/"); }}><LogOut size={17} /> Sign out</button></div>
    {error && <div className="notice error" role="alert">{error}</div>}
    <div className="studio-grid"><section className="upload-panel"><div className="upload-head"><div className="panel-icon"><CloudUpload size={26} /></div><span>NEW PROJECT</span></div>
      <h2>What's the conversation?</h2><p>Upload an episode or interview. We'll find the highlights and leave the finishing touches to you.</p>
      <label className={`drop-zone ${uploading ? "uploading" : ""}`}><input type="file" disabled={uploading} accept="video/mp4,video/webm,.mp4,.webm" onChange={upload} /><div className="drop-illustration"><Upload size={32} strokeWidth={1.5} /></div><strong>{uploading ? `Uploading · ${progress}%` : resumeId ? "Select the same file to resume" : "Choose a video file"}</strong><span>Browser-playable MP4 or WebM · Up to 2 hours / 5 GiB. Convert MOV/ProRes to H.264/AAC MP4 first.</span>{uploading && <div className="progress-bar"><i style={{ width: `${progress}%` }} /></div>}</label>
      {resumeId && <button className="text-button" onClick={() => setResumeId(null)}>Start a different upload</button>}
      <div className="upload-help"><Sparkles size={16} /><span>English audio works best. Only successfully processed sources use your minutes. Recordings and exports expire within 90 days; queued uploads can be canceled before processing starts.</span></div>
    </section><aside className="plan-panel"><span className="panel-label">YOUR PLAN</span><h3>{account?.subscription?.status === "active" ? "Creator plan" : "Make your first moment."}</h3><div className="minute-number">{account?.minutes ?? "—"}<span>minutes available</span></div><div className="plan-progress"><i style={{ width: `${Math.min(100, Math.max(0, (account?.minutes ?? 0) / 120 * 100))}%` }} /></div><p>Source minutes reset each billing month. Editing and exporting don't spend extra minutes.</p><button disabled={busy} className="button button-dark full" onClick={() => billing(account?.subscription?.status === "active" ? "portal" : "checkout")}>{busy && <LoaderCircle size={16} className="spin" />}{account?.subscription?.status === "active" ? "Manage subscription" : "Choose the Creator plan"}<ArrowUpRight size={18} /></button></aside></div>
    <section className="library"><div className="library-heading"><div><span className="eyebrow">YOUR LIBRARY</span><h2>Every conversation, <em>one place.</em></h2></div><span className="library-count">{projects.length} PROJECT{projects.length !== 1 ? "S" : ""}</span></div>
      {projects.length === 0 ? <div className="empty-state"><FileVideo2 size={42} strokeWidth={1.4} /><h3>Your next great clip starts with an upload.</h3><p>Your projects will appear here when you add a video.</p></div> :
        <div className="project-list">{projects.map((project) => <article className="project-row" key={project.id}><div className="project-thumbnail"><Play size={20} fill="currentColor" /></div><div className="project-main"><strong>{project.title}</strong><span>{new Date(project.createdAt).toLocaleDateString()} <b>·</b> <Clock3 size={13} /> {duration(project.durationMs)}</span></div><span className={`status ${project.status}`}>{project.status}</span>
          {project.status === "uploading" ? <button className="project-open" onClick={() => { setResumeId(project.id); window.scrollTo({ top: 0, behavior: "smooth" }); }}>Resume upload <ArrowRight size={16} /></button> : project.status === "expired" || project.status === "deleting" ?
            <span className="project-expired">{project.status === "expired" ? "Media expired" : "Deleting… retry below"}</span> : <Link to="/studio/$projectId" params={{ projectId: project.id }} className="project-open">Open project <ArrowRight size={16} /></Link>}
          <button className="project-delete" aria-label={`Delete ${project.title}`} title="Permanently delete project and media" disabled={busy || project.status === "processing"} onClick={() => void removeProject(project)}><Trash2 size={17} /></button></article>)}</div>}
    </section></div>;
}
