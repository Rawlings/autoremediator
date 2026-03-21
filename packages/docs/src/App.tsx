import { useEffect } from "react";
import { Navigate, NavLink, Route, Routes, useLocation, useParams } from "react-router-dom";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import "./App.css";

import gettingStarted from "../content/getting-started.md?raw";
import cli from "../content/cli.md?raw";
import scannerInputs from "../content/scanner-inputs.md?raw";
import policyAndSafety from "../content/policy-and-safety.md?raw";
import apiSdk from "../content/api-sdk.md?raw";
import integrations from "../content/integrations.md?raw";
import contributorGuide from "../content/contributor-guide.md?raw";

type Doc = {
  slug: string;
  title: string;
  body: string;
};

const docs: Doc[] = [
  { slug: "getting-started", title: "Getting Started", body: gettingStarted },
  { slug: "cli", title: "CLI Reference", body: cli },
  { slug: "scanner-inputs", title: "Scanner Inputs", body: scannerInputs },
  { slug: "policy-and-safety", title: "Policy and Safety", body: policyAndSafety },
  { slug: "api-sdk", title: "API and SDK", body: apiSdk },
  { slug: "integrations", title: "Integrations", body: integrations },
  { slug: "contributor-guide", title: "Contributor Guide", body: contributorGuide },
];

function findDoc(slug: string | undefined): Doc | undefined {
  return docs.find((doc) => doc.slug === slug);
}

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

function setCanonical(href: string): void {
  let canonical = document.head.querySelector("link[rel='canonical']") as HTMLLinkElement | null;
  if (!canonical) {
    canonical = document.createElement("link");
    canonical.setAttribute("rel", "canonical");
    document.head.appendChild(canonical);
  }
  canonical.setAttribute("href", href);
}

function DocPage() {
  const { slug } = useParams();
  const location = useLocation();
  const doc = findDoc(slug);

  useEffect(() => {
    if (!doc) return;

    const title = `${doc.title} | Autoremediator Docs`;
    const description = `${doc.title} documentation for automation-first, policy-aware CVE remediation in Node.js projects.`;
    const canonicalUrl = `https://rawlings.github.io/autoremediator${location.pathname}`;

    document.title = title;
    setMetaTag("name", "description", description);
    setMetaTag("property", "og:title", title);
    setMetaTag("property", "og:description", description);
    setMetaTag("property", "og:url", canonicalUrl);
    setMetaTag("name", "twitter:title", title);
    setMetaTag("name", "twitter:description", description);
    setCanonical(canonicalUrl);
  }, [doc, location.pathname]);

  if (!doc) {
    return <Navigate to={`/docs/${docs[0].slug}`} replace />;
  }

  return (
    <main className="content">
      <header className="content-header">
        <p className="eyebrow">Documentation</p>
        <h2>{doc.title}</h2>
      </header>
      <article className="markdown-rendered">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{doc.body}</ReactMarkdown>
      </article>
    </main>
  );
}

function App() {
  const location = useLocation();

  useEffect(() => {
    if (!location.pathname.startsWith("/docs/")) {
      const title = "Autoremediator Docs | Automation-first CVE Remediation";
      const description = "Documentation for CI-native Node.js CVE remediation using CLI, SDK, MCP, and OpenAPI surfaces.";

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
      <aside className="sidebar">
        <div className="brand-block">
          <p className="eyebrow">Autoremediator</p>
          <h1>Docs</h1>
          <p className="subtitle">Automation-first guidance, references, and integration patterns</p>
        </div>
        <div className="warning-card">
          <p className="warning-title">Warning</p>
          <p>
            Automated dependency remediation is controversial. Pair automation with policy controls,
            CI safeguards, and protected branch workflows.
          </p>
        </div>

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
        </div>

        <nav>
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
        <a className="site-link" href="https://rawlings.github.io/autoremediator/" target="_blank" rel="noreferrer">
          Open Published Site
        </a>
      </aside>

      <Routes>
        <Route path="/" element={<Navigate to={`/docs/${docs[0].slug}`} replace />} />
        <Route path="/docs/:slug" element={<DocPage />} />
        <Route path="*" element={<Navigate to={`/docs/${docs[0].slug}`} replace />} />
      </Routes>
    </div>
  );
}

export default App;
