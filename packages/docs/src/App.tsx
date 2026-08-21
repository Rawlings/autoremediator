import { useEffect } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import "./App.css";

import { Menu } from "./Menu";
import { DocPage, markdownComponents, setCanonical } from "./DocPage";
import monorepoReadme from "../../../README.md?raw";

function setMetaTag(key: "name" | "property", value: string, content: string): void {
  const selector = `meta[${key}="${value}"]`;
  const existing = document.head.querySelector(selector);
  if (existing) {
    existing.setAttribute("content", content);
    return;
  }

  const meta = document.createElement("meta");
  meta.setAttribute(key, value);
  meta.setAttribute("content", content);
  document.head.appendChild(meta);
}

function App() {
  const location = useLocation();

  useEffect(() => {
    window.scrollTo(0, 0);
  }, [location.pathname]);

  useEffect(() => {
    if (!location.pathname.startsWith("/docs/")) {
      const title = "Autoremediator | Risk-Aware, Agentic CVE Remediation";
      const description =
        "Guides and references for Node.js CVE remediation prioritized with OSV, CISA KEV, and FIRST EPSS intelligence, with policy and evidence controls for trusted automation.";

      document.title = title;
      setMetaTag("name", "description", description);
      setMetaTag("property", "og:title", title);
      setMetaTag("property", "og:description", description);
      setMetaTag("name", "twitter:title", title);
      setMetaTag("name", "twitter:description", description);
      setCanonical("https://rawlings.github.io/autoremediator/");
    }
  }, [location.pathname]);

  return (
    <div className="layout">
      <Menu />

      <main className="main-content">
        <Routes>
          <Route
            path="/"
            element={
              <article className="markdown-rendered">
                <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
                  {monorepoReadme}
                </ReactMarkdown>
              </article>
            }
          />
          <Route path="/docs/:slug" element={<DocPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}

export default App;
