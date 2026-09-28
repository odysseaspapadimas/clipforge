import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowLeft, ArrowRight, Captions, Check, ChevronDown, Crop, Download, Film, LoaderCircle, Play, RotateCcw, Save, Sparkles } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { previewCropStyle } from "../domain/crop.ts";
import { captionFrames, captionLines } from "../domain/caption-timeline.ts";
import { insertCaption, removeCaption } from "../domain/caption-edit.ts";
import { captionLayout, captionPresets, defaultCaptionStyle, type CaptionStyle } from "../domain/caption-style.ts";

export const Route = createFileRoute("/studio/$projectId")({ component: ProjectEditor });
type Caption = { text: string; startMs: number; endMs: number };
type Clip = { id: string; title: string; startMs: number; endMs: number; cropX: number; cropY: number; zoom: number;
  captions: Caption[]; captionStyle: CaptionStyle; rationale: string | null; score: number | null; revision: number; status: string; outputKey: string | null; renderedRevision: number | null };
type Project = { id: string; title: string; status: string; error: string | null; durationMs: number | null;
  width: number | null; height: number | null; transcriptChunks: number; transcriptChunksDone: number };
type Job = { id: string; clipId: string; revision: number; status: string; error: string | null };
type Word = { text: string; startMs: number; endMs: number; speaker: number | null };
type ProjectData = { project: Project; clips: Clip[]; jobs: Job[] };
const displayTime = (ms: number) => `${String(Math.floor(ms / 60000)).padStart(2, "0")}:${String(Math.floor(ms % 60000 / 1000)).padStart(2, "0")}`;
const jsonHeaders = { "content-type": "application/json" };
async function api<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`/api/${url}`, options);
  const body = await res.json() as T & { error?: string };
  if (!res.ok) throw new Error(body.error ?? "Something went wrong");
  return body;
}
function ProjectEditor() {
  const { projectId } = Route.useParams();
  const [data, setData] = useState<ProjectData | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [draft, setDraft] = useState<Clip | null>(null);
  const [words, setWords] = useState<Word[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [tab, setTab] = useState<"cut" | "frame" | "captions">("cut");
  const [newCaptionText, setNewCaptionText] = useState("");
  const [playing, setPlaying] = useState(false);
  const [previewError, setPreviewError] = useState("");
  const [currentMs, setCurrentMs] = useState(0);
  const [player, setPlayer] = useState<HTMLVideoElement | null>(null);
  const loadRequest = useRef(0);
  async function refresh() {
    const request = ++loadRequest.current;
    try {
      const latest = await api<ProjectData>(`projects/${projectId}`);
      if (request === loadRequest.current) { setData(latest); setError(""); }
    } catch (cause) {
      if (request === loadRequest.current) setError(cause instanceof Error ? cause.message : "Project unavailable");
    }
  }
  useEffect(() => {
    setData(null); setError("");
    void refresh();
    const timer = setInterval(() => { void refresh(); }, 6_000);
    return () => { clearInterval(timer); loadRequest.current++; };
  }, [projectId]);
  useEffect(() => {
    if (!data) return;
    const active = data.clips.find((clip) => clip.id === selected) ?? data.clips[0];
    if (!active) return;
    if (active.id !== selected) { setSelected(active.id); setDraft(active); setCurrentMs(active.startMs); }
    else if (draft?.revision !== active.revision || (!dirty && (draft.status !== active.status || draft.renderedRevision !== active.renderedRevision))) setDraft(active);
  }, [data, selected]);
  useEffect(() => {
    if (!draft || !data || data.project.status !== "ready") return;
    void api<{ words: Word[] }>(`projects/${projectId}/words?startMs=${Math.max(0, draft.startMs - 2000)}&endMs=${Math.min(data.project.durationMs ?? 0, draft.endMs + 2000)}`)
      .then((response) => setWords(response.words)).catch(() => setWords([]));
  }, [draft?.id, draft?.startMs, draft?.endMs, data?.project.status]);
  const original = data?.clips.find((clip) => clip.id === selected);
  const dirty = Boolean(draft && original && JSON.stringify({ title: draft.title, startMs: draft.startMs, endMs: draft.endMs,
    cropX: draft.cropX, cropY: draft.cropY, zoom: draft.zoom, captions: draft.captions, captionStyle: draft.captionStyle }) !==
    JSON.stringify({ title: original.title, startMs: original.startMs, endMs: original.endMs,
      cropX: original.cropX, cropY: original.cropY, zoom: original.zoom, captions: original.captions, captionStyle: original.captionStyle }));
  const job = data?.jobs.find((item) => item.clipId === selected && item.revision === original?.revision);
  const captions = useMemo(() => draft?.captions ?? [], [draft?.captions]);
  const previewWords = useMemo(() => {
    if (!draft) return [];
    const frame = captionFrames(captions, draft.startMs, draft.endMs).find((item) =>
      currentMs - draft.startMs >= item.startCs * 10 && currentMs - draft.startMs < item.endCs * 10);
    return frame ? captionLines(frame.words) : [];
  }, [captions, currentMs, draft?.startMs, draft?.endMs]);
  function addCaption(after: number) {
    if (!draft) return;
    try {
      setDraft({ ...draft, captions: insertCaption(draft.captions, after, newCaptionText, draft.startMs, draft.endMs) });
      setNewCaptionText(""); setError("");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not insert word"); }
  }
  async function save() {
    if (!draft) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const trimmed = draft.captions.filter((word) => word.startMs >= draft.startMs && word.endMs <= draft.endMs);
      await api(`clips/${draft.id}`, { method: "PATCH", headers: jsonHeaders,
        body: JSON.stringify({ title: draft.title, startMs: draft.startMs, endMs: draft.endMs,
          cropX: draft.cropX, cropY: draft.cropY, zoom: draft.zoom, captions: trimmed, captionStyle: draft.captionStyle ?? defaultCaptionStyle, revision: draft.revision }) });
      const updated = await api<ProjectData>(`projects/${projectId}`);
      setData(updated);
      setDraft(updated.clips.find((clip) => clip.id === draft.id) ?? null);
      setNotice(draft.startMs < (original?.startMs ?? draft.startMs) || draft.endMs > (original?.endMs ?? draft.endMs)
        ? "Edits saved. Newly exposed speech was added to captions; review timing before export."
        : "Edits saved. Your clip is ready to export.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not save edits"); }
    finally { setBusy(false); }
  }
  async function exportClip() {
    if (!draft || dirty) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const result = await api<{ startPending?: boolean; status?: string }>(`clips/${draft.id}/export`, { method: "POST" });
      setNotice(result.startPending ? "Export status/start is temporarily unavailable. Retry checking later; no duplicate job will be created." :
        result.status === "running" ? "Export is still running. Check again later; you can leave this page." :
        "Your export is queued. We'll keep this page updated.");
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not start export");
      await refresh();
    } finally { setBusy(false); }
  }
  async function retryIngest() {
    setBusy(true); setError(""); setNotice("");
    try {
      const result = await api<{ startPending?: boolean }>(`uploads/${projectId}/complete`, { method: "POST" });
      setNotice(result.startPending ? "Processing is still waiting to start. You can retry or cancel this queued upload." :
        "Processing request accepted. This page will update automatically.");
      await refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not retry processing"); }
    finally { setBusy(false); }
  }
  async function syncCaptions() {
    if (!draft) return;
    try {
      const response = await api<{ words: Word[] }>(`projects/${projectId}/words?startMs=${draft.startMs}&endMs=${draft.endMs}`);
      setDraft({ ...draft, captions: response.words.map((word) => ({ text: word.text, startMs: word.startMs, endMs: word.endMs })) });
      setNotice("Captions replaced from the transcript. Your text and timing corrections are not retained until you save.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not load transcript"); }
  }
  if (!data || data.project.id !== projectId) return <div className="content-container editor-loading">{error ? <div role="alert"><p>{error}</p><button className="button button-outline" onClick={() => { setError(""); void refresh(); }}>Retry loading project</button><p><Link to="/studio">Back to studio</Link></p></div> : <><LoaderCircle className="spin" /> Opening your studio…</>}</div>;
  const { project } = data;
  return <div className="content-container editor-page"><div className="editor-breadcrumb"><Link to="/studio"><ArrowLeft size={17} /> Your studio</Link><span>/</span><span>{project.title}</span></div>
    <div className="editor-heading"><div><span className="eyebrow">YOUR PROJECT</span><h1>{project.title}<span className="orange-dot">.</span></h1><p>{project.durationMs ? `${displayTime(project.durationMs)} source` : "Analyzing source"} <span>·</span> {data.clips.length} suggested {data.clips.length === 1 ? "clip" : "clips"}</p></div><span className={`status ${project.status}`}>{project.status}</span></div>
    {error && <div className="notice error" role="alert">{error}</div>}{notice && <div className="notice success" role="status"><Check size={17} /> {notice}</div>}
    {project.status === "expired" && <div className="processing-card failed"><strong>This recording has expired.</strong><p>Media is retained for at most 90 days. Downloads and editing are no longer available. Delete the remaining project data from your library.</p><Link to="/studio" className="text-link">Back to library <ArrowRight size={16} /></Link></div>}
    {project.status === "failed" && <div className="processing-card failed"><strong>We couldn't process this source.</strong><p>{project.error ?? "Please try a different recording."}</p><Link to="/studio" className="text-link">Back to studio <ArrowRight size={16} /></Link></div>}
    {(project.status === "queued" || project.status === "processing") && <div className="processing-card"><div className="processing-icon"><Sparkles size={27} /></div><div><strong>{project.transcriptChunks === 0 ? "Preparing your source video." :
      project.transcriptChunksDone === project.transcriptChunks ? "Finding the best moments." : "Transcribing your conversation."}</strong>
      <p>{project.transcriptChunks > 0 ? `${project.transcriptChunksDone} of ${project.transcriptChunks} audio segments complete. You can leave and come back.` :
        "We're checking the video and extracting its audio. Longer recordings take more time."}</p>
      {project.transcriptChunks > 0 && <div className="transcription-progress" role="progressbar" aria-valuenow={project.transcriptChunksDone}
        aria-valuemin={0} aria-valuemax={project.transcriptChunks} aria-label="Transcription progress"><i style={{ width: `${Math.min(100, 100 * project.transcriptChunksDone / project.transcriptChunks)}%` }} /></div>}
      {project.status === "queued" && <div className="queued-actions"><button className="button button-outline" disabled={busy} onClick={() => void retryIngest()}>Retry processing start</button><Link to="/studio" className="text-link">Cancel the queued upload in your library</Link></div>}</div><LoaderCircle size={21} className="spin" /></div>}
    {project.status === "ready" && data.clips.length === 0 && <div className="processing-card failed"><strong>No clips found yet.</strong><p>There wasn't enough transcribed speech to suggest a cut. Contact support if this seems wrong.</p></div>}
    {project.status === "ready" && draft && <div className="editor-grid"><aside className="moments-panel"><div className="moments-title"><div><span className="panel-label">AI-ASSISTED PICKS</span><h2>The moments <em>worth a look.</em></h2></div><span className="count-bubble">{data.clips.length}</span></div><p className="moments-help">Starting points, not finished edits. Pick one and make it your own.</p>
      <div className="moment-list">{data.clips.map((clip, index) => <button key={clip.id} className={`moment ${selected === clip.id ? "active" : ""}`} onClick={() => { setSelected(clip.id); setDraft(clip); setNotice(""); setError(""); if (player) { player.pause(); player.currentTime = clip.startMs / 1000; setCurrentMs(clip.startMs); } }}><span className="moment-index">{String(index + 1).padStart(2, "0")}</span><div><strong>{clip.title}</strong><small>{displayTime(clip.startMs)} – {displayTime(clip.endMs)} <span>·</span> {Math.round((clip.endMs - clip.startMs) / 1000)} sec</small></div><ArrowRight size={17} /></button>)}</div>
    </aside><div className="workbench"><div className="workbench-header"><div><span className="panel-label">NOW EDITING</span><h2>{draft.title}</h2></div><span className="edit-version">V{draft.revision}</span></div>
      <div className="preview-area"><div className="preview-phone"><div className="preview-viewport"><video ref={setPlayer} src={`/api/projects/${project.id}/media`} playsInline preload="metadata"
        onError={() => { setPreviewError("This recording cannot play in this browser. Convert to H.264/AAC MP4 before uploading another source."); setPlaying(false); }}
        onLoadedMetadata={(event) => {
          const video = event.currentTarget;
          if (project.width && project.height && Math.abs(video.videoWidth / video.videoHeight - project.width / project.height) > .02)
            setPreviewError("This browser displays a different rotation than the renderer. Do not rely on this preview; convert to an upright H.264 MP4.");
          else setPreviewError("");
        }}
        onTimeUpdate={(event) => { setCurrentMs(event.currentTarget.currentTime * 1000); if (event.currentTarget.currentTime >= draft.endMs / 1000) { event.currentTarget.pause(); setPlaying(false); } }}
        style={project.width && project.height ? previewCropStyle(project.width, project.height, draft.cropX, draft.cropY, draft.zoom) : undefined} />
        <div className="preview-overlay" style={{ color: (draft.captionStyle ?? defaultCaptionStyle).color, fontSize: `${(draft.captionStyle ?? defaultCaptionStyle).size * 340 / 1920}px`, bottom: `${captionLayout(draft.captionStyle ?? defaultCaptionStyle).marginV * 340 / 1920}px`, WebkitTextStroke: `${captionLayout(draft.captionStyle ?? defaultCaptionStyle).outline * 340 / 1920}px #0B1020`, textShadow: (draft.captionStyle ?? defaultCaptionStyle).preset === "minimal" ? "none" : "0 1px 1px #0B1020", fontWeight: (draft.captionStyle ?? defaultCaptionStyle).preset === "minimal" ? 400 : 900 }}>{previewWords.map((line, index) => <span key={index}>{line}{index < previewWords.length - 1 && <br />}</span>)}</div>
        {previewError ? <div className="preview-error" role="alert">{previewError}</div> : <button className="preview-play" aria-label={playing ? "Pause preview" : "Play preview"} onClick={() => { if (!player) return; if (playing) { player.pause(); setPlaying(false); } else { if (player.currentTime < draft.startMs / 1000 || player.currentTime >= draft.endMs / 1000) player.currentTime = draft.startMs / 1000; void player.play().then(() => setPlaying(true)).catch(() => setPreviewError("Playback failed in this browser. Convert to H.264/AAC MP4.")); } }}><Play size={25} fill="currentColor" /></button>}</div></div>
        <div className="preview-details"><span>9:16 PORTRAIT</span><strong>{displayTime(draft.startMs)} → {displayTime(draft.endMs)}</strong><p>Frame uses the export crop. Caption layout follows export styling; browser font rasterization may differ from MP4.</p></div></div>
      <div className="editor-controls"><div className="tabs" role="tablist"><button className={tab === "cut" ? "selected" : ""} onClick={() => setTab("cut")}><Film size={17} /> Cut</button><button className={tab === "frame" ? "selected" : ""} onClick={() => setTab("frame")}><Crop size={17} /> Frame</button><button className={tab === "captions" ? "selected" : ""} onClick={() => setTab("captions")}><Captions size={17} /> Captions</button></div>
        {tab === "cut" && <div className="control-body"><label>Clip title<input value={draft.title} maxLength={120} onChange={(event) => setDraft({ ...draft, title: event.target.value })} /></label><div className="input-pair"><label>Start (seconds)<input type="number" min={0} max={Math.floor((project.durationMs ?? 0) / 1000)} step="0.1" value={draft.startMs / 1000} onChange={(event) => setDraft({ ...draft, startMs: Math.round(Number(event.target.value) * 1000) })} /></label><label>End (seconds)<input type="number" min={0} max={Math.floor((project.durationMs ?? 0) / 1000)} step="0.1" value={draft.endMs / 1000} onChange={(event) => setDraft({ ...draft, endMs: Math.round(Number(event.target.value) * 1000) })} /></label></div><p className="hint">Choose an 8–180 second moment. Boundaries are absolute times in the source video.</p><div className="transcript-sample"><span>THE CONVERSATION</span><p>{words.length ? words.map((word) => word.text).join(" ") : "Transcript for this passage is loading…"}</p></div></div>}
        {tab === "frame" && <div className="control-body"><p className="hint">Drag the focal-point sliders to keep your speaker in frame. Vertical crop is shown in the preview.</p><label className="slider-label">Horizontal focus <strong>{draft.cropX / 10}%</strong><input type="range" min="0" max="1000" step="10" value={draft.cropX} onChange={(event) => setDraft({ ...draft, cropX: Number(event.target.value) })} /></label><label className="slider-label">Vertical focus <strong>{draft.cropY / 10}%</strong><input type="range" min="0" max="1000" step="10" value={draft.cropY} onChange={(event) => setDraft({ ...draft, cropY: Number(event.target.value) })} /></label><label className="slider-label">Zoom <strong>{(draft.zoom / 1000).toFixed(1)}×</strong><input type="range" min="1000" max="2500" step="50" value={draft.zoom} onChange={(event) => setDraft({ ...draft, zoom: Number(event.target.value) })} /></label></div>}
        {tab === "captions" && <div className="control-body"><div className="caption-heading"><p className="hint">Correct, insert or remove words and their absolute start/end seconds. Simultaneous words appear on separate lines. Extending the cut adds newly exposed words on save.</p><button onClick={() => { if (window.confirm("Replace all captions from the transcript? Unsaved text/timing edits will be lost.")) void syncCaptions(); }} className="text-button"><RotateCcw size={15} /> Reset to transcript</button></div><div className="caption-style-controls"><strong>Caption look</strong><div className="caption-presets">{Object.entries(captionPresets).map(([key, preset]) => <button key={key} type="button" className={(draft.captionStyle ?? defaultCaptionStyle).preset === key ? "active" : ""} aria-pressed={(draft.captionStyle ?? defaultCaptionStyle).preset === key} onClick={() => setDraft({ ...draft, captionStyle: preset })}>{key}</button>)}</div><div className="caption-style-fields"><label>Text color<input aria-label="Caption color" type="color" value={(draft.captionStyle ?? defaultCaptionStyle).color} onChange={(event) => setDraft({ ...draft, captionStyle: { ...(draft.captionStyle ?? defaultCaptionStyle), color: event.target.value } })} /></label><label>Text size <strong>{(draft.captionStyle ?? defaultCaptionStyle).size}</strong><input aria-label="Caption size" type="range" min="48" max="110" value={(draft.captionStyle ?? defaultCaptionStyle).size} onChange={(event) => setDraft({ ...draft, captionStyle: { ...(draft.captionStyle ?? defaultCaptionStyle), size: Number(event.target.value) } })} /></label><label>Placement<select aria-label="Caption placement" value={(draft.captionStyle ?? defaultCaptionStyle).position} onChange={(event) => setDraft({ ...draft, captionStyle: { ...(draft.captionStyle ?? defaultCaptionStyle), position: event.target.value as CaptionStyle["position"] } })}><option value="low">Lower third</option><option value="middle">Center</option></select></label></div></div><div className="caption-add"><label>Missing word<input aria-label="New caption word" value={newCaptionText} maxLength={80} placeholder="Type a missing word" onChange={(event) => setNewCaptionText(event.target.value)} /></label><button className="button button-outline" disabled={!newCaptionText.trim()} onClick={() => addCaption(-1)}>Add at start</button></div><div className="caption-list">{captions.map((item, index) => <div className="caption-row" key={`${draft.id}-${index}`}><span>{index + 1}.</span><input aria-label={`Caption ${index + 1} text`} value={item.text} maxLength={80} onChange={(event) => { const next = [...draft.captions]; next[index] = { ...item, text: event.target.value }; setDraft({ ...draft, captions: next }); }} /><label>Start (s)<input aria-label={`Caption ${index + 1} start`} type="number" min={draft.startMs / 1000} max={draft.endMs / 1000} step="0.01" value={item.startMs / 1000} onChange={(event) => { const next = [...draft.captions]; next[index] = { ...item, startMs: Math.round(Number(event.target.value) * 1000) }; setDraft({ ...draft, captions: next }); }} /></label><label>End (s)<input aria-label={`Caption ${index + 1} end`} type="number" min={draft.startMs / 1000} max={draft.endMs / 1000} step="0.01" value={item.endMs / 1000} onChange={(event) => { const next = [...draft.captions]; next[index] = { ...item, endMs: Math.round(Number(event.target.value) * 1000) }; setDraft({ ...draft, captions: next }); }} /></label><button className="caption-small-button" aria-label={`Add word after caption ${index + 1}`} disabled={!newCaptionText.trim()} onClick={() => addCaption(index)}>+ Word</button><button className="caption-small-button caption-remove" aria-label={`Remove caption ${index + 1}`} onClick={() => setDraft({ ...draft, captions: removeCaption(draft.captions, index) })}>Remove</button></div>)}</div></div>}
      </div><div className="workbench-footer"><div><span>{dirty ? "Unsaved changes" : "All changes saved"}</span>{job && <small>Export · {job.status}{job.error ? ` — ${job.error}` : ""}</small>}</div><div className="editor-actions"><button disabled={busy || !dirty} onClick={save} className="button button-outline"><Save size={17} /> Save edits</button>{draft.status === "ready" && draft.renderedRevision === draft.revision && !dirty ? <a href={`/api/clips/${draft.id}/download`} className="button button-dark"><Download size={18} /> Download MP4</a> : <button disabled={busy || dirty} onClick={exportClip} className="button button-dark">{busy ? <LoaderCircle size={17} className="spin" /> : <Film size={17} />} {job?.status === "running" ? "Check export status" : job?.status === "queued" ? "Retry export start" : "Export short"} <ArrowRight size={17} /></button>}</div></div></div></div>}
  </div>;
}
