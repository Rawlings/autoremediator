import { useEffect } from "react";
import { useLocation } from "react-router-dom";
import tocbot from "tocbot";
import "./TocPanel.css";

export function TocPanel() {
  const { pathname } = useLocation();

  useEffect(() => {
    let raf2: number;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        tocbot.init({
          tocSelector: ".toc-nav",
          contentSelector: ".markdown-rendered",
          headingSelector: "h2, h3",
          hasInnerContainers: false,
          scrollSmooth: false,
          disableTocScrollSync: false,
        });
      });
    });
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
      tocbot.destroy();
    };
  }, [pathname]);

  return (
    <aside className="toc-panel">
      <div className="toc-nav" />
    </aside>
  );
}
