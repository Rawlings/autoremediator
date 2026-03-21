import { useEffect } from "react";
import { Navigate, NavLink, Route, Routes, useLocation } from "react-router-dom";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import "./App.css";

import { DocPage, docs, setCanonical } from "./DocPage";
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
    if (!location.pathname.startsWith("/docs/")) {
      const title = "Autoremediator | Automation-first CVE Remediation";
      const description = "Guides and references for CI-native Node.js CVE remediation using CLI, SDK, MCP, and OpenAPI surfaces.";

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
      <header className="site-header">
        <div className="brand-block">
          <p className="eyebrow">Autoremediator</p>
          <h1>Security Reference</h1>
          <p className="subtitle">Automation-first guidance, references, and integration patterns</p>
        </div>

        <nav className="top-nav" aria-label="Reference sections">
          <NavLink to="/" end className={({ isActive }) => (isActive ? "nav-item active" : "nav-item")}>
            Home
          </NavLink>
          {docs.map((doc) => (
            <NavLink
              key={doc.slug}
              to={`/docs/${doc.slug}`}
              className={({ isActive }) => (isActive ? "nav-item active" : "nav-item")}
            >
              {doc.title}
            </NavLink>
          ))}
        </nav>
      </header>

      <Routes>
        <Route
          path="/"
          element={(
            <main className="content">
              <article className="markdown-rendered">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{monorepoReadme}</ReactMarkdown>
              </article>
            </main>
          )}
        />
        <Route path="/docs/:slug" element={<DocPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>

      <footer className="site-footer">
        <div className="badge-row" aria-label="Project badges">
          <a href="https://www.npmjs.com/package/autoremediator" target="_blank" rel="noreferrer">
            <img
              src="https://img.shields.io/npm/v/autoremediator.svg"
              alt="npm version badge"
              loading="lazy"
            />
          </a>
          <a href="https://github.com/Rawlings/autoremediator" target="_blank" rel="noreferrer">
            <img
              src="https://img.shields.io/github/stars/Rawlings/autoremediator.svg?style=social"
              alt="GitHub stars badge"
              loading="lazy"
            />
          </a>
        </div>

        <div className="external-links" aria-label="Package and repository links">
          <a href="https://www.npmjs.com/package/autoremediator" target="_blank" rel="noreferrer">
            npm package
          </a>
          <a href="https://github.com/Rawlings/autoremediator" target="_blank" rel="noreferrer">
            GitHub repository
          </a>
          <a className="site-link" href="https://rawlings.github.io/autoremediator/" target="_blank" rel="noreferrer">
            Open site
          </a>
        </div>
      </footer>
    </div>
  );
}

export default App;
