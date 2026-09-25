import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowRight, ArrowUpRight, Captions, Clapperboard, Crop, FileVideo2, Sparkles, WandSparkles } from "lucide-react";

export const Route = createFileRoute("/")({ component: Home });

function Home() {
  return <>
    <section className="hero content-container"><div className="hero-copy"><span className="eyebrow"><span className="eyebrow-dot" /> THE EDITOR FOR CONVERSATIONS THAT MATTER</span>
      <h1>Your best <em>moments</em> deserve a bigger stage<span className="orange-dot">.</span></h1>
      <p className="hero-lead">Turn full-length podcasts and interviews into scroll-stopping shorts. Find the good parts, make them yours, and publish in minutes—not hours.</p>
      <div className="hero-actions"><Link to="/studio" className="button button-dark">Open your studio <ArrowUpRight size={19} /></Link><Link to="/pricing" className="text-link">See plans <ArrowRight size={18} /></Link></div>
      <div className="trust-line"><span className="stacked-avatars"><b>O</b><b>C</b><b>Y</b></span><span>Built for creators who have something to say.</span></div>
    </div><div className="hero-visual" aria-label="Illustration of a podcast clip editor">
      <div className="visual-top"><span className="pill-live"><span /> FROM LONG FORM</span><span className="visual-dots">● ● ●</span></div>
      <div className="visual-player"><div className="portrait-frame"><div className="portrait-grad"><span className="portrait-speaker">the moment</span><span className="portrait-subtitle">“And that's when<br /><strong>everything changed.</strong>”</span></div></div>
        <div className="visual-float"><Sparkles size={18} /><div><strong>Found a great moment</strong><small>01:24 → 02:09 · 45 seconds</small></div></div></div>
      <div className="visual-timeline"><div className="timeline-ruler"><span>01:20</span><span>01:35</span><span>01:50</span><span>02:05</span></div><div className="timeline-track"><div className="timeline-selected"><span>“And that's when everything changed...”</span></div></div><div className="timeline-track audio"><div className="waveform">{Array.from({ length: 48 }, (_, i) => <i key={i} style={{ height: `${9 + ((i * 37) % 22)}px` }} />)}</div></div></div>
    </div></section>
    <section className="strip"><div className="content-container strip-inner"><span>ONE EPISODE</span><ArrowRight size={20} /><span>MOMENTS WORTH SHARING</span><ArrowRight size={20} /><span>READY-TO-POST SHORTS</span></div></section>
    <section className="section content-container" id="how-it-works"><div className="section-kicker">THE WORKFLOW <span>— 01 / 03</span></div><div className="section-head"><h2>From long conversation<br />to <em>lasting impression.</em></h2><p>You stay in the creative seat. Clipforge takes care of the tedious parts, so you can focus on what makes the clip worth watching.</p></div>
      <div className="feature-grid"><article className="feature-card peach"><div className="feature-number">01 / FIND</div><FileVideo2 size={39} strokeWidth={1.5} /><h3>Drop in your episode.</h3><p>Upload your podcast or interview. We transcribe every word, identify speakers, and surface promising moments you might have missed.</p></article>
      <article className="feature-card lavender"><div className="feature-number">02 / SHAPE</div><Crop size={39} strokeWidth={1.5} /><h3>Make it your moment.</h3><p>Fine-tune the start and finish. Move the crop, correct the captions, and give every short your own point of view.</p></article>
      <article className="feature-card mint"><div className="feature-number">03 / SHARE</div><Clapperboard size={39} strokeWidth={1.5} /><h3>Ready for the feed.</h3><p>Export a crisp 9:16 MP4 with burned-in word-by-word captions. Post it wherever your audience lives.</p></article></div></section>
    <section className="spotlight"><div className="content-container spotlight-inner"><div><span className="eyebrow light"><WandSparkles size={17} /> HUMAN-LED, AI-ASSISTED</span><h2>AI finds a starting point.<br /><em>You make it yours.</em></h2><p>Real control over the cut, the words, and the frame. No mystery scores, no awkward auto-edits you can't fix.</p><Link to="/studio" className="button button-light">Start creating <ArrowUpRight size={18} /></Link></div><div className="spotlight-notes"><div><Captions size={22} /><span>Word-timed<br />captions</span></div><div><Crop size={22} /><span>Frame every<br />speaker</span></div><div><Sparkles size={22} /><span>Your best<br />moments first</span></div></div></div></section>
    <section className="last-cta content-container"><span className="eyebrow">YOUR NEXT GREAT CLIP STARTS HERE</span><h2>Make more out of<br /><em>what you already made.</em></h2><Link to="/studio" className="button button-orange">Open your studio <ArrowUpRight size={19} /></Link></section>
  </>;
}
