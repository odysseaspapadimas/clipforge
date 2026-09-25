import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowLeft, ArrowRight, Captions, Check, ChevronDown, Crop, Download, Film, LoaderCircle, Play, RotateCcw, Save, Sparkles } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

export const Route = createFileRoute("/studio/$projectId")({ component: ProjectEditor });
type Caption = { text: string; startMs: number; endMs: number };
type Clip = { id: string; title: string; startMs: number; endMs: number; cropX: number; cropY: number; zoom: number;
  captions: Caption[]; rationale: string | null; score: number | null; revision: number; status: string; outputKey: string | null; renderedRevision: number | null };
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
  const [playing, setPlaying] = useState(false);
  const [currentMs, setCurrentMs] = useState(0);
  const [player, setPlayer] = useState<HTMLVideoElement | null>(null);
  async function refresh() {
    try { setData(await api<ProjectData>(`projects/${projectId}`)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Project unavailable"); }
  }
  useEffect(() => { void refresh(); const timer = setInterval(() => { void refresh(); }, 6_000); return () => clearInterval(timer); }, [projectId]);
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
    cropX: draft.cropX, cropY: draft.cropY, zoom: draft.zoom, captions: draft.captions }) !==
    JSON.stringify({ title: original.title, startMs: original.startMs, endMs: original.endMs,
      cropX: original.cropX, cropY: original.cropY, zoom: original.zoom, captions: original.captions }));
  const job = data?.jobs.find((item) => item.clipId === selected && item.revision === original?.revision);
  const captions = useMemo(() => draft?.captions ?? [], [draft?.captions]);
  const previewWords = useMemo(() => {
    const groups: Caption[][] = [];
    let group: Caption[] = [];
    for (const word of captions) {
      if (group.length >= 4 || (group.length > 0 && (word.startMs - group[0].startMs > 1600 ||
        word.startMs - group[group.length - 1].endMs > 360))) { groups.push(group); group = []; }
      group.push(word);
    }
    if (group.length) groups.push(group);
    return groups.find((items) => items.some((word) => currentMs >= word.startMs && currentMs < word.endMs + 150)) ?? [];
  }, [captions, currentMs]);
  async function save() {
    if (!draft) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const trimmed = draft.captions.filter((word) => word.startMs >= draft.startMs && word.endMs <= draft.endMs);
      await api(`clips/${draft.id}`, { method: "PATCH", headers: jsonHeaders,
        body: JSON.stringify({ title: draft.title, startMs: draft.startMs, endMs: draft.endMs,
          cropX: draft.cropX, cropY: draft.cropY, zoom: draft.zoom, captions: trimmed, revision: draft.revision }) });
      setNotice("Edits saved. Your clip is ready to export."); await refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not save edits"); }
    finally { setBusy(false); }
  }
  async function exportClip() {
    if (!draft || dirty) return;
    setBusy(true); setError(""); setNotice("");
    try { await api(`clips/${draft.id}/export`, { method: "POST" }); setNotice("Your export is queued. We'll keep this page updated."); await refresh(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not start export"); }
    finally { setBusy(false); }
  }
  async function syncCaptions() {
    if (!draft) return;
    try {
      const response = await api<{ words: Word[] }>(`projects/${projectId}/words?startMs=${draft.startMs}&endMs=${draft.endMs}`);
      setDraft({ ...draft, captions: response.words.map((word) => ({ text: word.text, startMs: word.startMs, endMs: word.endMs })) });
      setNotice("Captions synced to your new cut. Save to keep them.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not load transcript"); }
  }
  if (!data) return <div className="content-container editor-loading">{error || <><LoaderCircle className="spin" /> Opening your studio…</>}</div>;
  const { project } = data;
  return <div className="content-container editor-page"><div className="editor-breadcrumb"><Link to="/studio"><ArrowLeft size={17} /> Your studio</Link><span>/</span><span>{project.title}</span></div>
    <div className="editor-heading"><div><span className="eyebrow">YOUR PROJECT</span><h1>{project.title}<span className="orange-dot">.</span></h1><p>{project.durationMs ? `${displayTime(project.durationMs)} source` : "Analyzing source"} <span>·</span> {data.clips.length} suggested {data.clips.length === 1 ? "clip" : "clips"}</p></div><span className={`status ${project.status}`}>{project.status}</span></div>
    {error && <div className="notice error" role="alert">{error}</div>}{notice && <div className="notice success" role="status"><Check size={17} /> {notice}</div>}
    {project.status === "failed" && <div className="processing-card failed"><strong>We couldn't process this source.</strong><p>{project.error ?? "Please try a different recording."}</p><Link to="/studio" className="text-link">Back to studio <ArrowRight size={16} /></Link></div>}
    {(project.status === "queued" || project.status === "processing") && <div className="processing-card"><div className="processing-icon"><Sparkles size={27} /></div><div><strong>{project.transcriptChunks === 0 ? "Preparing your source video." :
      project.transcriptChunksDone === project.transcriptChunks ? "Finding the best moments." : "Transcribing your conversation."}</strong>
      <p>{project.transcriptChunks > 0 ? `${project.transcriptChunksDone} of ${project.transcriptChunks} audio segments complete. You can leave and come back.` :
        "We're checking the video and extracting its audio. Longer recordings take more time."}</p>
      {project.transcriptChunks > 0 && <div className="transcription-progress" role="progressbar" aria-valuenow={project.transcriptChunksDone}
        aria-valuemin={0} aria-valuemax={project.transcriptChunks} aria-label="Transcription progress"><i style={{ width: `${Math.min(100, 100 * project.transcriptChunksDone / project.transcriptChunks)}%` }} /></div>}</div><LoaderCircle size={21} className="spin" /></div>}
    {project.status === "ready" && data.clips.length === 0 && <div className="processing-card failed"><strong>No clips found yet.</strong><p>There wasn't enough transcribed speech to suggest a cut. Contact support if this seems wrong.</p></div>}
    {project.status === "ready" && draft && <div className="editor-grid"><aside className="moments-panel"><div className="moments-title"><div><span className="panel-label">AI-ASSISTED PICKS</span><h2>The moments <em>worth a look.</em></h2></div><span className="count-bubble">{data.clips.length}</span></div><p className="moments-help">Starting points, not finished edits. Pick one and make it your own.</p>
      <div className="moment-list">{data.clips.map((clip, index) => <button key={clip.id} className={`moment ${selected === clip.id ? "active" : ""}`} onClick={() => { setSelected(clip.id); setDraft(clip); setNotice(""); setError(""); if (player) { player.pause(); player.currentTime = clip.startMs / 1000; setCurrentMs(clip.startMs); } }}><span className="moment-index">{String(index + 1).padStart(2, "0")}</span><div><strong>{clip.title}</strong><small>{displayTime(clip.startMs)} – {displayTime(clip.endMs)} <span>·</span> {Math.round((clip.endMs - clip.startMs) / 1000)} sec</small></div><ArrowRight size={17} /></button>)}</div>
    </aside><div className="workbench"><div className="workbench-header"><div><span className="panel-label">NOW EDITING</span><h2>{draft.title}</h2></div><span className="edit-version">V{draft.revision}</span></div>
      <div className="preview-area"><div className="preview-phone"><video ref={setPlayer} src={`/api/projects/${project.id}/media`} crossOrigin="use-credentials" playsInline preload="metadata" onTimeUpdate={(event) => { setCurrentMs(event.currentTarget.currentTime * 1000); if (event.currentTarget.currentTime >= draft.endMs / 1000) { event.currentTarget.pause(); setPlaying(false); } }}
        style={{ objectPosition: `${draft.cropX / 10}% ${draft.cropY / 10}%`, transform: `scale(${draft.zoom / 1000})` }} />
        <div className="preview-overlay">{previewWords.map((word) => <span className={currentMs >= word.startMs && currentMs <= word.endMs ? "highlight" : ""} key={`${word.startMs}-${word.text}`}>{word.text} </span>)}</div>
        <button className="preview-play" aria-label={playing ? "Pause preview" : "Play preview"} onClick={() => { if (!player) return; if (playing) { player.pause(); setPlaying(false); } else { if (player.currentTime < draft.startMs / 1000 || player.currentTime >= draft.endMs / 1000) player.currentTime = draft.startMs / 1000; void player.play(); setPlaying(true); } }}><Play size={25} fill="currentColor" /></button></div>
        <div className="preview-details"><span>9:16 PORTRAIT</span><strong>{displayTime(draft.startMs)} → {displayTime(draft.endMs)}</strong><p>Preview approximates framing. The exported video has full-resolution, burned-in captions.</p></div></div>
      <div className="editor-controls"><div className="tabs" role="tablist"><button className={tab === "cut" ? "selected" : ""} onClick={() => setTab("cut")}><Film size={17} /> Cut</button><button className={tab === "frame" ? "selected" : ""} onClick={() => setTab("frame")}><Crop size={17} /> Frame</button><button className={tab === "captions" ? "selected" : ""} onClick={() => setTab("captions")}><Captions size={17} /> Captions</button></div>
        {tab === "cut" && <div className="control-body"><label>Clip title<input value={draft.title} maxLength={120} onChange={(event) => setDraft({ ...draft, title: event.target.value })} /></label><div className="input-pair"><label>Start (seconds)<input type="number" min={0} max={Math.floor((project.durationMs ?? 0) / 1000)} step="0.1" value={draft.startMs / 1000} onChange={(event) => setDraft({ ...draft, startMs: Math.round(Number(event.target.value) * 1000) })} /></label><label>End (seconds)<input type="number" min={0} max={Math.floor((project.durationMs ?? 0) / 1000)} step="0.1" value={draft.endMs / 1000} onChange={(event) => setDraft({ ...draft, endMs: Math.round(Number(event.target.value) * 1000) })} /></label></div><p className="hint">Choose an 8–180 second moment. Boundaries are absolute times in the source video.</p><div className="transcript-sample"><span>THE CONVERSATION</span><p>{words.length ? words.map((word) => word.text).join(" ") : "Transcript for this passage is loading…"}</p></div></div>}
        {tab === "frame" && <div className="control-body"><p className="hint">Drag the focal-point sliders to keep your speaker in frame. Vertical crop is shown in the preview.</p><label className="slider-label">Horizontal focus <strong>{draft.cropX / 10}%</strong><input type="range" min="0" max="1000" step="10" value={draft.cropX} onChange={(event) => setDraft({ ...draft, cropX: Number(event.target.value) })} /></label><label className="slider-label">Vertical focus <strong>{draft.cropY / 10}%</strong><input type="range" min="0" max="1000" step="10" value={draft.cropY} onChange={(event) => setDraft({ ...draft, cropY: Number(event.target.value) })} /></label><label className="slider-label">Zoom <strong>{(draft.zoom / 1000).toFixed(1)}×</strong><input type="range" min="1000" max="2500" step="50" value={draft.zoom} onChange={(event) => setDraft({ ...draft, zoom: Number(event.target.value) })} /></label></div>}
        {tab === "captions" && <div className="control-body"><div className="caption-heading"><p className="hint">These word-level captions are burned into your export. Edit any word before publishing.</p><button onClick={syncCaptions} className="text-button"><RotateCcw size={15} /> Sync to cut</button></div><div className="caption-list">{captions.map((item, index) => <label key={`${item.startMs}-${index}`}><span>{displayTime(item.startMs)}</span><input aria-label={`Caption ${index + 1}`} value={item.text} onChange={(event) => { const next = [...draft.captions]; next[index] = { ...item, text: event.target.value }; setDraft({ ...draft, captions: next }); }} /></label>)}</div></div>}
      </div><div className="workbench-footer"><div><span>{dirty ? "Unsaved changes" : "All changes saved"}</span>{job && <small>Export · {job.status}{job.error ? ` — ${job.error}` : ""}</small>}</div><div className="editor-actions"><button disabled={busy || !dirty} onClick={save} className="button button-outline"><Save size={17} /> Save edits</button>{draft.status === "ready" && draft.renderedRevision === draft.revision && !dirty ? <a href={`/api/clips/${draft.id}/download`} className="button button-dark"><Download size={18} /> Download MP4</a> : <button disabled={busy || dirty || job?.status === "running" || job?.status === "queued"} onClick={exportClip} className="button button-dark">{busy ? <LoaderCircle size={17} className="spin" /> : <Film size={17} />} Export short <ArrowRight size={17} /></button>}</div></div></div></div>}
  </div>;
}
