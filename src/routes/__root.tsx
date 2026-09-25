import { createRootRoute, HeadContent, Link, Outlet, Scripts } from "@tanstack/react-router";
import { useEffect, type ReactNode } from "react";
import { ArrowUpRight, Sparkles } from "lucide-react";
import "../styles.css";

export const Route = createRootRoute({
  head: () => ({ meta: [{ charSet: "utf-8" }, { name: "viewport", content: "width=device-width, initial-scale=1" },
    { title: "Clipforge — Find the moment. Make the short." },
    { name: "description", content: "Turn podcasts and conversations into polished short-form video." }] }),
  component: Root,
});
function Root() {
  useEffect(() => { document.documentElement.dataset.hydrated = "true"; }, []);
  return <html lang="en"><head><HeadContent /></head><body><div className="shell">
    <header className="site-header"><Link to="/" className="brand"><span className="brand-icon"><Sparkles size={19} strokeWidth={2.5} /></span> clipforge<span className="brand-dot">.</span></Link>
      <nav className="top-nav" aria-label="Main navigation"><Link to="/" hash="how-it-works">How it works</Link><Link to="/pricing">Pricing</Link><Link to="/studio">Studio <ArrowUpRight size={15} /></Link></nav>
    </header><main><Outlet /></main><footer className="footer"><div className="brand"><span className="brand-icon"><Sparkles size={16} /></span> clipforge<span className="brand-dot">.</span></div><p>More signal. Less scrolling.</p><span>© {new Date().getFullYear()} Clipforge</span></footer>
  </div><Scripts /></body></html>;
}
export function Layout({ children }: { children: ReactNode }) { return <div className="content-container">{children}</div>; }
