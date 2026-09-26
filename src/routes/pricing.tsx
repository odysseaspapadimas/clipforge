import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowUpRight, Check, Clock3, HelpCircle } from "lucide-react";

export const Route = createFileRoute("/pricing")({ component: Pricing });
function Pricing() {
  return <div className="content-container pricing-page"><span className="eyebrow">SIMPLE, PREDICTABLE PRICING</span><h1>More moments.<br /><em>Less guesswork.</em></h1><p className="page-intro">Pay for source minutes, not every time you tweak a caption or move the crop.</p>
    <div className="pricing-layout"><div className="pricing-card"><div className="pricing-top"><span className="pricing-badge">FOR THE CONSISTENT CREATOR</span><h2>Creator</h2><p>Make the most of every conversation.</p><div className="price">$29 <span>/ month</span></div></div>
      <ul><li><Check size={19} /> 120 source minutes each billing month</li><li><Check size={19} /> Transcript-backed clip suggestions</li><li><Check size={19} /> Edit cuts, framing and word captions</li><li><Check size={19} /> Export captioned vertical MP4s</li><li><Check size={19} /> Up to 20 exports per source</li></ul>
      <Link to="/studio" className="button button-dark">Get started <ArrowUpRight size={19} /></Link></div>
      <aside className="pricing-aside"><Clock3 size={32} /><h3>Only the source counts.</h3><p>A 60-minute episode uses 60 minutes once, after successful processing. Refine and export its clips without being charged source minutes again.</p><div className="divider" /><HelpCircle size={29} /><h3>Know before you upload.</h3><p>We show your remaining minutes up front. Upload up to 2 hours per browser-playable MP4 or WebM (convert MOV/ProRes first), and adjust suggested moments before export.</p><small>Unused minutes expire when your billing period ends. Uploads require an active subscription. Failed processing releases reserved minutes. Media is retained for up to 90 days; download exports you wish to keep.</small></aside></div>
  </div>;
}
